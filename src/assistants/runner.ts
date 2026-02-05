/**
 * Run Execution Engine
 *
 * Executes runs with support for:
 * - Streaming mode (yields SSE events)
 * - Non-streaming mode (returns promise)
 * - Run steps tracking
 * - Cancellation support
 * - Tool calling (prompt-based)
 *
 * The executeRun function is a generator that yields StreamEvent objects.
 * For non-streaming, consume all events and ignore them.
 * For streaming, pipe events to SSE response.
 */

import { state, PendingToolContext } from './state';
import { processChatRequest } from '../extension';
import { ChatCompletionRequest, ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '../types';
import { createMessage } from '../utils';
import { assistantToolsToFunctionTools } from '../toolConvert';
import {
  Run,
  Message,
  RunStep,
  TextContent,
  MessageContent,
  StreamEvent,
  MessageDelta,
  ToolCall,
  ToolOutput,
} from './types';

// Active runs that can be cancelled
const activeRuns = new Map<string, { cancelled: boolean }>();

/**
 * Extract text content from MessageContent array
 */
function extractTextFromContent(content: MessageContent[]): string {
  return content
    .filter((c): c is TextContent => c.type === 'text')
    .map(c => c.text.value)
    .join('\n');
}

/**
 * Create a stream event
 */
function createEvent(event: StreamEvent['event'], data: unknown): StreamEvent {
  return { event, data };
}

/**
 * Execute a run as an async generator
 * Yields StreamEvent objects for SSE streaming
 *
 * @param threadId - The thread ID
 * @param runId - The run ID
 * @param streaming - Whether to yield intermediate events
 */
export async function* executeRun(
  threadId: string,
  runId: string,
  streaming: boolean = false
): AsyncGenerator<StreamEvent, void, unknown> {
  const runKey = `${threadId}:${runId}`;
  activeRuns.set(runKey, { cancelled: false });

  try {
    const run = state.getRun(threadId, runId);
    const thread = state.getThread(threadId);

    if (!run || !thread) {
      state.updateRun(threadId, runId, {
        status: 'failed',
        failed_at: Math.floor(Date.now() / 1000),
        last_error: { code: 'server_error', message: 'Thread or run not found' }
      });
      if (streaming) {
        yield createEvent('thread.run.failed', state.getRun(threadId, runId));
        yield createEvent('done', '[DONE]');
      }
      return;
    }

    const assistant = state.getAssistant(run.assistant_id);
    if (!assistant) {
      state.updateRun(threadId, runId, {
        status: 'failed',
        failed_at: Math.floor(Date.now() / 1000),
        last_error: { code: 'server_error', message: 'Assistant not found' }
      });
      if (streaming) {
        yield createEvent('thread.run.failed', state.getRun(threadId, runId));
        yield createEvent('done', '[DONE]');
      }
      return;
    }

    // Check for cancellation
    if (activeRuns.get(runKey)?.cancelled) {
      state.updateRun(threadId, runId, {
        status: 'cancelled',
        cancelled_at: Math.floor(Date.now() / 1000)
      });
      if (streaming) {
        yield createEvent('thread.run.cancelled', state.getRun(threadId, runId));
        yield createEvent('done', '[DONE]');
      }
      return;
    }

    // Emit run queued event
    if (streaming) {
      yield createEvent('thread.run.queued', run);
    }

    // Mark as in progress
    state.updateRun(threadId, runId, {
      status: 'in_progress',
      started_at: Math.floor(Date.now() / 1000)
    });

    if (streaming) {
      yield createEvent('thread.run.in_progress', state.getRun(threadId, runId));
    }

    // Build messages array from thread
    const threadMessages = state.getMessages(threadId, { order: 'asc' });
    const chatMessages: ChatMessage[] = [];

    // Build system instructions (assistant instructions + run overrides)
    // Tools are passed natively via processChatRequest, not injected into system prompt
    let systemContent = '';
    if (assistant.instructions) {
      systemContent += assistant.instructions;
    }
    if (run.instructions) {
      systemContent += (systemContent ? '\n\n' : '') + run.instructions;
    }

    // Get tools for native passing
    const tools = run.tools.length > 0 ? run.tools : assistant.tools;
    const functionTools = assistantToolsToFunctionTools(tools);

    // Convert thread messages to chat messages
    // Prepend system content to the first user message
    let systemPrepended = false;

    for (const msg of threadMessages.data) {
      const textContent = extractTextFromContent(msg.content);

      if (msg.role === 'user' && !systemPrepended && systemContent) {
        // Prepend system instructions to first user message
        chatMessages.push({
          role: 'user',
          content: `${systemContent}\n\n---\n\n${textContent}`
        });
        systemPrepended = true;
      } else {
        chatMessages.push({
          role: msg.role,
          content: textContent
        });
      }
    }

    // If no user messages but we have system content, add it as a user message
    if (!systemPrepended && systemContent) {
      chatMessages.unshift({
        role: 'user',
        content: systemContent
      });
    }

    // Check for cancellation before calling LLM
    if (activeRuns.get(runKey)?.cancelled) {
      state.updateRun(threadId, runId, {
        status: 'cancelled',
        cancelled_at: Math.floor(Date.now() / 1000)
      });
      if (streaming) {
        yield createEvent('thread.run.cancelled', state.getRun(threadId, runId));
        yield createEvent('done', '[DONE]');
      }
      return;
    }

    // Create message_creation run step
    const stepId = state.generateStepId();
    const messageId = state.generateMessageId();

    const runStep: RunStep = {
      id: stepId,
      object: 'thread.run.step',
      created_at: Math.floor(Date.now() / 1000),
      run_id: runId,
      assistant_id: assistant.id,
      thread_id: threadId,
      type: 'message_creation',
      status: 'in_progress',
      cancelled_at: null,
      completed_at: null,
      expired_at: null,
      failed_at: null,
      last_error: null,
      step_details: {
        type: 'message_creation',
        message_creation: {
          message_id: messageId
        }
      },
      usage: null
    };

    state.addRunStep(runId, runStep);

    if (streaming) {
      yield createEvent('thread.run.step.created', runStep);
      yield createEvent('thread.run.step.in_progress', runStep);
    }

    // Build request - use streaming mode if requested, pass tools natively
    const request: ChatCompletionRequest = {
      model: run.model || assistant.model,
      messages: chatMessages,
      stream: streaming,
      ...(functionTools.length > 0 ? { tools: functionTools } : {}),
    };

    let fullContent = '';
    let promptTokens = 0;
    let completionTokens = 0;

    if (streaming) {
      // Streaming mode: yield message deltas
      const streamIterator = await processChatRequest(request) as AsyncIterable<ChatCompletionChunk>;

      // Create message in progress
      const assistantMessage = createMessage({
        threadId,
        messageId,
        content: '',
        role: 'assistant',
        assistantId: assistant.id,
        runId,
        status: 'in_progress',
      });

      state.addMessage(threadId, assistantMessage);
      yield createEvent('thread.message.created', assistantMessage);
      yield createEvent('thread.message.in_progress', assistantMessage);

      let deltaIndex = 0;
      const accumulatedToolCalls: ToolCall[] = [];

      for await (const chunk of streamIterator) {
        // Check for cancellation
        if (activeRuns.get(runKey)?.cancelled) {
          state.updateRun(threadId, runId, {
            status: 'cancelled',
            cancelled_at: Math.floor(Date.now() / 1000)
          });
          state.updateRunStep(runId, stepId, {
            status: 'cancelled',
            cancelled_at: Math.floor(Date.now() / 1000)
          });
          yield createEvent('thread.run.step.cancelled', state.getRunStep(runId, stepId));
          yield createEvent('thread.run.cancelled', state.getRun(threadId, runId));
          yield createEvent('done', '[DONE]');
          return;
        }

        const content = chunk.choices[0]?.delta?.content ?? '';
        if (content) {
          fullContent += content;

          // Emit message delta
          const delta: MessageDelta = {
            id: messageId,
            object: 'thread.message.delta',
            delta: {
              content: [{
                index: deltaIndex,
                type: 'text',
                text: {
                  value: content
                }
              }]
            }
          };
          yield createEvent('thread.message.delta', delta);
          deltaIndex++;
        }

        // Check for native tool calls in delta
        const chunkToolCalls = chunk.choices[0]?.delta?.tool_calls;
        if (chunkToolCalls) {
          for (const tc of chunkToolCalls) {
            if (tc.id && tc.function?.name) {
              accumulatedToolCalls.push({
                id: tc.id,
                type: 'function',
                function: {
                  name: tc.function.name,
                  arguments: tc.function.arguments ?? '{}',
                },
              });
            }
          }
        }

        // Check for finish reason
        if (chunk.choices[0]?.finish_reason === 'stop' || chunk.choices[0]?.finish_reason === 'tool_calls') {
          break;
        }
      }

      // Estimate tokens (rough approximation)
      completionTokens = fullContent.length;
      promptTokens = chatMessages.reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0);

      // Update message with full content
      state.updateMessage(threadId, messageId, {
        status: 'completed',
        completed_at: Math.floor(Date.now() / 1000),
        content: [{
          type: 'text',
          text: {
            value: fullContent,
            annotations: []
          }
        }]
      });

      yield createEvent('thread.message.completed', state.getMessage(threadId, messageId));

      // Handle tool calls detected during streaming
      if (accumulatedToolCalls.length > 0) {
        // Complete the message_creation step
        state.updateRunStep(runId, stepId, {
          status: 'completed',
          completed_at: Math.floor(Date.now() / 1000)
        });

        // Create tool_calls run step
        const toolStepId = state.generateStepId();
        const toolStep: RunStep = {
          id: toolStepId,
          object: 'thread.run.step',
          created_at: Math.floor(Date.now() / 1000),
          run_id: runId,
          assistant_id: assistant.id,
          thread_id: threadId,
          type: 'tool_calls',
          status: 'in_progress',
          cancelled_at: null,
          completed_at: null,
          expired_at: null,
          failed_at: null,
          last_error: null,
          step_details: {
            type: 'tool_calls',
            tool_calls: accumulatedToolCalls
          },
          usage: null
        };
        state.addRunStep(runId, toolStep);

        // Save context for when tool outputs are submitted
        const pendingContext: PendingToolContext = {
          runId,
          threadId,
          toolCalls: accumulatedToolCalls,
          partialContent: fullContent,
          stepId: toolStepId
        };
        state.setPendingToolContext(runId, pendingContext);

        // Update run to requires_action
        state.updateRun(threadId, runId, {
          status: 'requires_action',
          required_action: {
            type: 'submit_tool_outputs',
            submit_tool_outputs: {
              tool_calls: accumulatedToolCalls
            }
          }
        });

        yield createEvent('thread.run.step.created', toolStep);
        yield createEvent('thread.run.requires_action', state.getRun(threadId, runId));
        yield createEvent('done', '[DONE]');
        return;
      }

    } else {
      // Non-streaming mode
      const response = await processChatRequest(request) as ChatCompletionResponse;

      // Check for cancellation after LLM response
      if (activeRuns.get(runKey)?.cancelled) {
        state.updateRun(threadId, runId, {
          status: 'cancelled',
          cancelled_at: Math.floor(Date.now() / 1000)
        });
        state.updateRunStep(runId, stepId, {
          status: 'cancelled',
          cancelled_at: Math.floor(Date.now() / 1000)
        });
        return;
      }

      // Extract response content
      const responseContent = response.choices[0]?.message?.content;
      if (!responseContent) {
        state.updateRun(threadId, runId, {
          status: 'failed',
          failed_at: Math.floor(Date.now() / 1000),
          last_error: { code: 'server_error', message: 'Empty response from model' }
        });
        state.updateRunStep(runId, stepId, {
          status: 'failed',
          failed_at: Math.floor(Date.now() / 1000),
          last_error: { code: 'server_error', message: 'Empty response from model' }
        });
        return;
      }

      fullContent = typeof responseContent === 'string'
        ? responseContent
        : JSON.stringify(responseContent);

      promptTokens = response.usage?.prompt_tokens ?? 0;
      completionTokens = response.usage?.completion_tokens ?? fullContent.length;

      // Check for native tool calls in the response
      const responseToolCalls = response.choices?.[0]?.message?.tool_calls;
      if (responseToolCalls && responseToolCalls.length > 0) {
        // Complete the message_creation step (with partial content if any)
        state.updateRunStep(runId, stepId, {
          status: 'completed',
          completed_at: Math.floor(Date.now() / 1000)
        });

        // Create tool_calls run step
        const toolStepId = state.generateStepId();
        const toolStep: RunStep = {
          id: toolStepId,
          object: 'thread.run.step',
          created_at: Math.floor(Date.now() / 1000),
          run_id: runId,
          assistant_id: assistant.id,
          thread_id: threadId,
          type: 'tool_calls',
          status: 'in_progress',
          cancelled_at: null,
          completed_at: null,
          expired_at: null,
          failed_at: null,
          last_error: null,
          step_details: {
            type: 'tool_calls',
            tool_calls: responseToolCalls
          },
          usage: null
        };
        state.addRunStep(runId, toolStep);

        // Save context for when tool outputs are submitted
        const pendingContext: PendingToolContext = {
          runId,
          threadId,
          toolCalls: responseToolCalls,
          partialContent: fullContent,
          stepId: toolStepId
        };
        state.setPendingToolContext(runId, pendingContext);

        // Update run to requires_action
        state.updateRun(threadId, runId, {
          status: 'requires_action',
          required_action: {
            type: 'submit_tool_outputs',
            submit_tool_outputs: {
              tool_calls: responseToolCalls
            }
          }
        });

        // Don't create message yet - wait for tool outputs
        return;
      }

      // Create assistant message
      const assistantMessage = createMessage({
        threadId,
        messageId,
        content: fullContent,
        role: 'assistant',
        assistantId: assistant.id,
        runId,
      });

      state.addMessage(threadId, assistantMessage);
    }

    // Update run step as completed
    const usage = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens
    };

    state.updateRunStep(runId, stepId, {
      status: 'completed',
      completed_at: Math.floor(Date.now() / 1000),
      usage
    });

    if (streaming) {
      yield createEvent('thread.run.step.completed', state.getRunStep(runId, stepId));
    }

    // Mark run as completed
    state.updateRun(threadId, runId, {
      status: 'completed',
      completed_at: Math.floor(Date.now() / 1000),
      usage
    });

    if (streaming) {
      yield createEvent('thread.run.completed', state.getRun(threadId, runId));
      yield createEvent('done', '[DONE]');
    }

  } catch (error) {
    console.error('Run execution error:', error);
    state.updateRun(threadId, runId, {
      status: 'failed',
      failed_at: Math.floor(Date.now() / 1000),
      last_error: {
        code: 'server_error',
        message: error instanceof Error ? error.message : 'Unknown error'
      }
    });

    if (streaming) {
      yield createEvent('error', {
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'server_error'
        }
      });
      yield createEvent('thread.run.failed', state.getRun(threadId, runId));
      yield createEvent('done', '[DONE]');
    }
  } finally {
    activeRuns.delete(runKey);
  }
}

/**
 * Execute run without streaming (convenience wrapper)
 * Consumes all events and returns when complete
 */
export async function executeRunNonStreaming(threadId: string, runId: string): Promise<void> {
  const generator = executeRun(threadId, runId, false);
  // Consume all events
  for await (const _ of generator) {
    // Discard events in non-streaming mode
  }
}

/**
 * Request cancellation of a run
 */
export function requestRunCancellation(threadId: string, runId: string): boolean {
  const runKey = `${threadId}:${runId}`;
  const activeRun = activeRuns.get(runKey);
  if (activeRun) {
    activeRun.cancelled = true;
    return true;
  }
  return false;
}

/**
 * Check if a run is currently active
 */
export function isRunActive(threadId: string, runId: string): boolean {
  return activeRuns.has(`${threadId}:${runId}`);
}

/**
 * Continue a run after tool outputs have been submitted
 * This resumes execution by adding tool results to the conversation and calling the model again
 */
export async function* continueRunWithToolOutputs(
  threadId: string,
  runId: string,
  toolOutputs: ToolOutput[],
  streaming: boolean = false
): AsyncGenerator<StreamEvent, void, unknown> {
  const runKey = `${threadId}:${runId}`;
  activeRuns.set(runKey, { cancelled: false });

  try {
    const run = state.getRun(threadId, runId);
    const pendingContext = state.getPendingToolContext(runId);

    if (!run || !pendingContext) {
      state.updateRun(threadId, runId, {
        status: 'failed',
        failed_at: Math.floor(Date.now() / 1000),
        last_error: { code: 'server_error', message: 'Run or pending context not found' }
      });
      if (streaming) {
        yield createEvent('thread.run.failed', state.getRun(threadId, runId));
        yield createEvent('done', '[DONE]');
      }
      return;
    }

    const assistant = state.getAssistant(run.assistant_id);
    if (!assistant) {
      state.updateRun(threadId, runId, {
        status: 'failed',
        failed_at: Math.floor(Date.now() / 1000),
        last_error: { code: 'server_error', message: 'Assistant not found' }
      });
      if (streaming) {
        yield createEvent('thread.run.failed', state.getRun(threadId, runId));
        yield createEvent('done', '[DONE]');
      }
      return;
    }

    // Update run status back to in_progress
    state.updateRun(threadId, runId, {
      status: 'in_progress',
      required_action: null
    });

    if (streaming) {
      yield createEvent('thread.run.in_progress', state.getRun(threadId, runId));
    }

    // Complete the tool_calls step
    state.updateRunStep(runId, pendingContext.stepId, {
      status: 'completed',
      completed_at: Math.floor(Date.now() / 1000)
    });

    if (streaming) {
      yield createEvent('thread.run.step.completed', state.getRunStep(runId, pendingContext.stepId));
    }

    // Build messages array including tool results
    const threadMessages = state.getMessages(threadId, { order: 'asc' });
    const chatMessages: ChatMessage[] = [];

    // Build system instructions
    let systemContent = '';
    if (assistant.instructions) {
      systemContent += assistant.instructions;
    }
    if (run.instructions) {
      systemContent += (systemContent ? '\n\n' : '') + run.instructions;
    }

    // Get tools for native passing
    const tools = run.tools.length > 0 ? run.tools : assistant.tools;
    const functionTools = assistantToolsToFunctionTools(tools);

    // Convert thread messages to chat messages
    let systemPrepended = false;
    for (const msg of threadMessages.data) {
      const textContent = extractTextFromContent(msg.content);

      if (msg.role === 'user' && !systemPrepended && systemContent) {
        chatMessages.push({
          role: 'user',
          content: `${systemContent}\n\n---\n\n${textContent}`
        });
        systemPrepended = true;
      } else {
        chatMessages.push({
          role: msg.role,
          content: textContent
        });
      }
    }

    // If no user messages but we have system content, add it
    if (!systemPrepended && systemContent) {
      chatMessages.unshift({
        role: 'user',
        content: systemContent
      });
    }

    // Add the assistant message with tool calls (as native tool call parts)
    if (pendingContext.toolCalls.length > 0) {
      if (pendingContext.partialContent) {
        // Include partial content with the tool call assistant message
      }
      // Add assistant message with tool_calls for the conversation history
      chatMessages.push({
        role: 'assistant',
        content: pendingContext.partialContent || null,
        tool_calls: pendingContext.toolCalls,
      });
    }

    // Add tool results as individual tool messages
    for (const output of toolOutputs) {
      chatMessages.push({
        role: 'tool',
        tool_call_id: output.tool_call_id,
        content: output.output,
      });
    }

    // Clear pending context
    state.deletePendingToolContext(runId);

    // Create new message_creation step for the continuation
    const stepId = state.generateStepId();
    const messageId = state.generateMessageId();

    const runStep: RunStep = {
      id: stepId,
      object: 'thread.run.step',
      created_at: Math.floor(Date.now() / 1000),
      run_id: runId,
      assistant_id: assistant.id,
      thread_id: threadId,
      type: 'message_creation',
      status: 'in_progress',
      cancelled_at: null,
      completed_at: null,
      expired_at: null,
      failed_at: null,
      last_error: null,
      step_details: {
        type: 'message_creation',
        message_creation: {
          message_id: messageId
        }
      },
      usage: null
    };

    state.addRunStep(runId, runStep);

    if (streaming) {
      yield createEvent('thread.run.step.created', runStep);
      yield createEvent('thread.run.step.in_progress', runStep);
    }

    // Build request with native tool support
    const request: ChatCompletionRequest = {
      model: run.model || assistant.model,
      messages: chatMessages,
      stream: streaming,
      ...(functionTools.length > 0 ? { tools: functionTools } : {}),
    };

    let fullContent = '';
    let promptTokens = 0;
    let completionTokens = 0;

    // Non-streaming continuation
    const response = await processChatRequest(request) as ChatCompletionResponse;

    const responseContent = response.choices[0]?.message?.content;
    if (!responseContent) {
      state.updateRun(threadId, runId, {
        status: 'failed',
        failed_at: Math.floor(Date.now() / 1000),
        last_error: { code: 'server_error', message: 'Empty response from model' }
      });
      return;
    }

    fullContent = typeof responseContent === 'string'
      ? responseContent
      : JSON.stringify(responseContent);

    promptTokens = response.usage?.prompt_tokens ?? 0;
    completionTokens = response.usage?.completion_tokens ?? fullContent.length;

    // Check for more tool calls (native)
    const responseToolCalls = response.choices?.[0]?.message?.tool_calls;
    if (responseToolCalls && responseToolCalls.length > 0) {
      // Complete the message_creation step
      state.updateRunStep(runId, stepId, {
        status: 'completed',
        completed_at: Math.floor(Date.now() / 1000)
      });

      // Create new tool_calls step
      const toolStepId = state.generateStepId();
      const toolStep: RunStep = {
        id: toolStepId,
        object: 'thread.run.step',
        created_at: Math.floor(Date.now() / 1000),
        run_id: runId,
        assistant_id: assistant.id,
        thread_id: threadId,
        type: 'tool_calls',
        status: 'in_progress',
        cancelled_at: null,
        completed_at: null,
        expired_at: null,
        failed_at: null,
        last_error: null,
        step_details: {
          type: 'tool_calls',
          tool_calls: responseToolCalls
        },
        usage: null
      };
      state.addRunStep(runId, toolStep);

      // Save context for next round
      const newPendingContext: PendingToolContext = {
        runId,
        threadId,
        toolCalls: responseToolCalls,
        partialContent: fullContent,
        stepId: toolStepId
      };
      state.setPendingToolContext(runId, newPendingContext);

      // Update run to requires_action again
      state.updateRun(threadId, runId, {
        status: 'requires_action',
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: {
            tool_calls: responseToolCalls
          }
        }
      });

      if (streaming) {
        yield createEvent('thread.run.step.created', toolStep);
        yield createEvent('thread.run.requires_action', state.getRun(threadId, runId));
        yield createEvent('done', '[DONE]');
      }
      return;
    }

    // Create assistant message
    const assistantMessage = createMessage({
      threadId,
      messageId,
      content: fullContent,
      role: 'assistant',
      assistantId: assistant.id,
      runId,
    });

    state.addMessage(threadId, assistantMessage);

    if (streaming) {
      yield createEvent('thread.message.created', assistantMessage);
      yield createEvent('thread.message.completed', assistantMessage);
    }

    // Update run step
    const usage = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens
    };

    state.updateRunStep(runId, stepId, {
      status: 'completed',
      completed_at: Math.floor(Date.now() / 1000),
      usage
    });

    if (streaming) {
      yield createEvent('thread.run.step.completed', state.getRunStep(runId, stepId));
    }

    // Mark run as completed
    state.updateRun(threadId, runId, {
      status: 'completed',
      completed_at: Math.floor(Date.now() / 1000),
      usage
    });

    if (streaming) {
      yield createEvent('thread.run.completed', state.getRun(threadId, runId));
      yield createEvent('done', '[DONE]');
    }

  } catch (error) {
    console.error('Continue run error:', error);
    state.updateRun(threadId, runId, {
      status: 'failed',
      failed_at: Math.floor(Date.now() / 1000),
      last_error: {
        code: 'server_error',
        message: error instanceof Error ? error.message : 'Unknown error'
      }
    });

    if (streaming) {
      yield createEvent('error', {
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'server_error'
        }
      });
      yield createEvent('thread.run.failed', state.getRun(threadId, runId));
      yield createEvent('done', '[DONE]');
    }
  } finally {
    activeRuns.delete(runKey);
  }
}

/**
 * Continue run with tool outputs (non-streaming wrapper)
 */
export async function continueRunWithToolOutputsNonStreaming(
  threadId: string,
  runId: string,
  toolOutputs: ToolOutput[]
): Promise<void> {
  const generator = continueRunWithToolOutputs(threadId, runId, toolOutputs, false);
  for await (const _ of generator) {
    // Discard events
  }
}
