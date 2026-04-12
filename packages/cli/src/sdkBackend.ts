/**
 * SDK Backend
 *
 * Implements ChatBackend using @github/copilot-sdk's CopilotClient.
 * Wraps the SDK to provide OpenAI-compatible chat completion processing.
 */

import { CopilotClient, approveAll } from '@github/copilot-sdk';
import {
  ChatBackend,
  Logger,
  ModelInfo,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  generateId,
} from '@hyorman/copilot-proxy-core';

type ToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

type ToolCallChunk = ToolCall & { index: number };

export interface SdkOptions {
  githubToken?: string;
  cliPath?: string;
  cliUrl?: string;
}

export class SdkBackend implements ChatBackend {
  private client: CopilotClient | null = null;
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Initialize the CopilotClient. Must be called before any requests.
   */
  async init(options: SdkOptions = {}): Promise<void> {
    const clientOpts: Record<string, unknown> = {
      cliPath: options.cliPath,
      cliUrl: options.cliUrl,
      autoStart: true,
    };
    if (options.githubToken) {
      clientOpts.githubToken = options.githubToken;
    }
    this.client = new CopilotClient(clientOpts as any);
    await this.client.start();
    this.logger.log('CopilotClient started');
  }

  /**
   * Stop the CopilotClient.
   */
  async stop(): Promise<void> {
    if (this.client) {
      await this.client.stop();
      this.client = null;
      this.logger.log('CopilotClient stopped');
    }
  }

  private getClient(): CopilotClient {
    if (!this.client) {
      throw new Error('CopilotClient not initialized. Call init() first.');
    }
    return this.client;
  }

  /**
   * Build a combined prompt string from chat messages.
   */
  private buildPrompt(request: ChatCompletionRequest): { systemMessage: string; prompt: string } {
    const systemParts: string[] = [];
    const conversationParts: string[] = [];

    for (const msg of request.messages) {
      const role = msg.role.toLowerCase();
      const content = typeof msg.content === 'string'
        ? msg.content
        : msg.content === null || msg.content === undefined
          ? ''
          : Array.isArray(msg.content)
            ? msg.content.map((c: any) => c.text ?? '').join('\n')
            : String(msg.content);

      if (role === 'system') {
        systemParts.push(content);
      } else if (role === 'tool' && msg.tool_call_id) {
        conversationParts.push(`<tool_result tool_call_id="${msg.tool_call_id}">\n${content}\n</tool_result>`);
      } else if (role === 'assistant' && msg.tool_calls?.length) {
        let text = content || '';
        for (const tc of msg.tool_calls) {
          text += `\n<tool_call id="${tc.id}" name="${tc.function.name}">\n${tc.function.arguments}\n</tool_call>`;
        }
        conversationParts.push(`[assistant]\n${text}`);
      } else {
        conversationParts.push(`[${role}]\n${content}`);
      }
    }

    if (request.tools?.length) {
      const toolDescriptions = request.tools.map((t: any) => {
        const fn = t.function;
        return `- ${fn.name}: ${fn.description ?? 'No description'}\n  Parameters: ${JSON.stringify(fn.parameters ?? {})}`;
      }).join('\n');
      systemParts.push(`\nYou have access to the following tools. To call a tool, respond with a JSON object in this exact format:\n{"tool_calls": [{"id": "call_<unique_id>", "type": "function", "function": {"name": "<tool_name>", "arguments": "<json_args>"}}]}\n\nAvailable tools:\n${toolDescriptions}`);
    }

    return {
      systemMessage: systemParts.join('\n\n'),
      prompt: conversationParts.join('\n\n'),
    };
  }

  /**
   * Parse tool calls from the assistant's response text.
   */
  private parseToolCalls(content: string): { text: string; toolCalls: ToolCall[] } {
    try {
      const parsed = JSON.parse(content.trim());
      if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
        return {
          text: '',
          toolCalls: parsed.tool_calls.map((tc: any) => ({
            id: tc.id || generateId('call'),
            type: 'function' as const,
            function: {
              name: tc.function.name,
              arguments: typeof tc.function.arguments === 'string'
                ? tc.function.arguments
                : JSON.stringify(tc.function.arguments),
            },
          })),
        };
      }
    } catch {
      // Not JSON, continue
    }

    const toolCallRegex = /\{"tool_calls"\s*:\s*\[[\s\S]*?\]\s*\}/g;
    const match = content.match(toolCallRegex);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
          const textBefore = content.substring(0, content.indexOf(match[0])).trim();
          return {
            text: textBefore,
            toolCalls: parsed.tool_calls.map((tc: any) => ({
              id: tc.id || generateId('call'),
              type: 'function' as const,
              function: {
                name: tc.function.name,
                arguments: typeof tc.function.arguments === 'string'
                  ? tc.function.arguments
                  : JSON.stringify(tc.function.arguments),
              },
            })),
          };
        }
      } catch {
        // Failed to parse, treat as plain text
      }
    }

    return { text: content, toolCalls: [] };
  }

  /**
   * Process a chat completion request through the Copilot SDK.
   */
  async processChatRequest(
    request: ChatCompletionRequest
  ): Promise<AsyncIterable<ChatCompletionChunk> | ChatCompletionResponse> {
    const sdkClient = this.getClient();
    const { systemMessage, prompt } = this.buildPrompt(request);
    const hasTools = (request.tools?.length ?? 0) > 0;

    if (request.stream) {
      return this.processStreaming(sdkClient, request, systemMessage, prompt, hasTools);
    } else {
      return this.processNonStreaming(sdkClient, request, systemMessage, prompt, hasTools);
    }
  }

  private async *processStreaming(
    sdkClient: CopilotClient,
    request: ChatCompletionRequest,
    systemMessage: string,
    prompt: string,
    hasTools: boolean,
  ): AsyncGenerator<ChatCompletionChunk, void, unknown> {
    const session = await sdkClient.createSession({
      model: request.model,
      onPermissionRequest: approveAll,
      ...(systemMessage ? {
        systemMessage: {
          mode: 'replace' as const,
          content: systemMessage,
        },
      } : {}),
      infiniteSessions: { enabled: false },
    });

    try {
      let chunkIndex = 0;
      let firstChunk = true;

      const deltaQueue: string[] = [];
      let idleResolved = false;
      let idleResolver: (() => void) | null = null;

      const waitForDelta = (): Promise<void> =>
        new Promise(resolve => { idleResolver = resolve; });

      const unsubDelta = session.on('assistant.message_delta', (event: any) => {
        const deltaContent = event.data?.deltaContent ?? '';
        if (deltaContent) {
          deltaQueue.push(deltaContent);
          if (idleResolver) {
            const r = idleResolver;
            idleResolver = null;
            r();
          }
        }
      });

      const unsubIdle = session.on('session.idle', () => {
        idleResolved = true;
        if (idleResolver) {
          const r = idleResolver;
          idleResolver = null;
          r();
        }
      });

      await session.send({ prompt });

      while (!idleResolved || deltaQueue.length > 0) {
        if (deltaQueue.length === 0 && !idleResolved) {
          await waitForDelta();
        }

        while (deltaQueue.length > 0) {
          const content = deltaQueue.shift()!;
          const chunk: ChatCompletionChunk = {
            id: `chatcmpl-stream-${chunkIndex}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: request.model,
            choices: [{
              delta: {
                ...(firstChunk ? { role: 'assistant' } : {}),
                content,
              },
              index: 0,
              finish_reason: '',
            }],
          };
          firstChunk = false;
          chunkIndex++;
          yield chunk;
        }
      }

      unsubDelta();
      unsubIdle();

      const messages = await session.getMessages();
      const lastAssistant = [...messages].reverse().find(
        (m: any) => m.type === 'assistant.message'
      );
      const finalContent = (lastAssistant as any)?.data?.content ?? '';

      if (hasTools && finalContent) {
        const { toolCalls } = this.parseToolCalls(finalContent);
        if (toolCalls.length > 0) {
          const toolCallChunks: ToolCallChunk[] = toolCalls.map((tc, index) => ({
            index,
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          }));

          const toolCallsChunk: ChatCompletionChunk = {
            id: `chatcmpl-stream-${chunkIndex}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: request.model,
            choices: [{
              delta: {
                tool_calls: toolCallChunks,
              },
              index: 0,
              finish_reason: 'tool_calls',
            }],
          };
          yield toolCallsChunk;
          return;
        }
      }

      const finalChunk: ChatCompletionChunk = {
        id: `chatcmpl-stream-final`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [{
          delta: { content: '' },
          index: 0,
          finish_reason: 'stop',
        }],
      };
      yield finalChunk;

    } finally {
      await session.disconnect();
    }
  }

  private async processNonStreaming(
    sdkClient: CopilotClient,
    request: ChatCompletionRequest,
    systemMessage: string,
    prompt: string,
    hasTools: boolean,
  ): Promise<ChatCompletionResponse> {
    const session = await sdkClient.createSession({
      model: request.model,
      onPermissionRequest: approveAll,
      ...(systemMessage ? {
        systemMessage: {
          mode: 'replace' as const,
          content: systemMessage,
        },
      } : {}),
      infiniteSessions: { enabled: false },
    });

    try {
      const result = await session.sendAndWait({ prompt });
      const fullContent = result?.data?.content ?? '';

      let responseContent: string | null = fullContent || null;
      const toolCalls: ToolCall[] = [];

      if (hasTools && fullContent) {
        const parsed = this.parseToolCalls(fullContent);
        if (parsed.toolCalls.length > 0) {
          responseContent = parsed.text || null;
          toolCalls.push(...parsed.toolCalls);
        }
      }

      const hasToolCalls = toolCalls.length > 0;
      const completionTokens = Math.ceil((fullContent?.length ?? 0) / 4);

      const response: ChatCompletionResponse = {
        id: `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: responseContent,
            refusal: null,
            annotations: [],
            ...(hasToolCalls ? { tool_calls: toolCalls } : {}),
          },
          logprobs: null,
          finish_reason: hasToolCalls ? 'tool_calls' : 'stop',
        }],
        usage: {
          prompt_tokens: 0,
          completion_tokens: completionTokens,
          total_tokens: completionTokens,
          prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
          completion_tokens_details: {
            reasoning_tokens: 0,
            audio_tokens: 0,
            accepted_prediction_tokens: 0,
            rejected_prediction_tokens: 0,
          },
        },
        service_tier: 'default',
        system_fingerprint: null,
      };

      return response;
    } finally {
      await session.disconnect();
    }
  }

  private inferVendor(modelId: string): string {
    if (/^(gpt-|o\d)/.test(modelId)) return 'openai';
    if (modelId.startsWith('claude-')) return 'anthropic';
    if (modelId.startsWith('gemini-')) return 'google';
    return 'copilot';
  }

  async getAvailableModels(): Promise<ModelInfo[]> {
    const sdkModels = await this.getClient().listModels();
    return sdkModels.map((m: any) => ({ vendor: this.inferVendor(m.id), family: m.id, id: m.id }));
  }
}
