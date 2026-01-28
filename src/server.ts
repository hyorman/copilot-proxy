import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import morgan from 'morgan';
import {
  ChatCompletionRequest,
  ChatCompletionChunk,
  ChatCompletionChunkDelta,
  ChatCompletionResponse,
  CompletionRequest,
  CompletionResponse,
  EmbeddingRequest,
  ModelObject,
  ModelsListResponse,
  OpenAIErrorResponse,
  CreateResponseRequest,
  ResponseObject,
  ResponseOutputItem,
  ResponseFunctionCallItem,
  ResponseFunctionCallOutputItem,
  ResponseOutputItemUnion,
  FunctionTool,
  ToolCall
} from './types';
import { processChatRequest, getAvailableModels } from './extension';
import { assistantsRouter } from './assistants';

// Load environment variables from .env file if present
dotenv.config();

const app = express();

// Middleware to parse JSON bodies
app.use(express.json());

// Logger middleware
app.use(morgan('combined'));

// ==================== Error Helpers ====================

function errorResponse(
  message: string,
  type = 'invalid_request_error',
  param: string | null = null,
  code: string | null = null
): OpenAIErrorResponse {
  return {
    error: { message, type, param, code }
  };
}

// ==================== Models Endpoints ====================

// GET /v1/models - List available models
app.get('/v1/models', async (req: Request, res: Response) => {
  try {
    const models = await getAvailableModels();
    const response: ModelsListResponse = {
      object: 'list',
      data: models.map(m => ({
        id: m.family,
        object: 'model' as const,
        created: Math.floor(Date.now() / 1000),
        owned_by: m.vendor
      }))
    };
    res.json(response);
  } catch (error) {
    console.error('Error listing models:', error);
    res.status(500).json(errorResponse('Failed to list models', 'server_error'));
  }
});

// GET /v1/models/:model - Get specific model
app.get('/v1/models/:model', async (req: Request, res: Response) => {
  try {
    const models = await getAvailableModels();
    const model = models.find(m => m.family === req.params.model);

    if (!model) {
      return res.status(404).json(
        errorResponse(`Model '${req.params.model}' not found`, 'invalid_request_error', 'model', 'model_not_found')
      );
    }

    const response: ModelObject = {
      id: model.family,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: model.vendor
    };
    res.json(response);
  } catch (error) {
    console.error('Error getting model:', error);
    res.status(500).json(errorResponse('Failed to get model', 'server_error'));
  }
});

// ==================== Embeddings Endpoint (Stub) ====================

// POST /v1/embeddings - Returns 501 Not Implemented
app.post('/v1/embeddings', (req: Request<{}, {}, EmbeddingRequest>, res: Response) => {
  res.status(501).json(
    errorResponse(
      'Embeddings are not supported by the VS Code Language Model API. ' +
      'Consider using an external embedding service like OpenAI, Ollama, or a local embedding model.',
      'not_implemented',
      null,
      'embeddings_not_supported'
    )
  );
});

// ==================== Legacy Completions Endpoint ====================

// POST /v1/completions - Wrap as chat completion
app.post<{}, {}, CompletionRequest>('/v1/completions', async (req: Request, res: Response) => {
  const { model, prompt, stream, ...rest } = req.body;

  // Normalize prompt to string
  const promptText = Array.isArray(prompt) ? prompt.join('\n') : prompt;

  // Remove vendor prefixes
  const cleanModel = model.split('/').pop()!;

  // Convert to chat completion request
  const chatRequest: ChatCompletionRequest = {
    model: cleanModel,
    messages: [{ role: 'user', content: promptText }],
    stream: stream ?? false
  };

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      const streamIterator = await processChatRequest(chatRequest) as AsyncIterable<ChatCompletionChunk>;
      let chunkIndex = 0;

      for await (const chunk of streamIterator) {
        // Convert chat chunk to completion chunk format
        const completionChunk = {
          id: chunk.id,
          object: 'text_completion',
          created: chunk.created,
          model: chunk.model,
          choices: [{
            index: 0,
            text: chunk.choices[0]?.delta?.content ?? '',
            finish_reason: chunk.choices[0]?.finish_reason || null,
            logprobs: null
          }]
        };
        res.write(`data: ${JSON.stringify(completionChunk)}\n\n`);
        chunkIndex++;
      }
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (error) {
      console.error('Streaming completions error:', error);
      res.status(500).json(errorResponse('Streaming error', 'server_error'));
    }
  } else {
    try {
      const chatResponse = await processChatRequest(chatRequest) as ChatCompletionResponse;

      const response: CompletionResponse = {
        id: chatResponse.id,
        object: 'text_completion',
        created: chatResponse.created,
        model: cleanModel,
        choices: [{
          index: 0,
          text: typeof chatResponse.choices[0]?.message?.content === 'string'
            ? chatResponse.choices[0].message.content
            : JSON.stringify(chatResponse.choices[0]?.message?.content ?? ''),
          finish_reason: chatResponse.choices[0]?.finish_reason ?? 'stop',
          logprobs: null
        }],
        usage: chatResponse.usage
      };
      res.json(response);
    } catch (error) {
      console.error('Completions error:', error);
      res.status(500).json(errorResponse('Error processing request', 'server_error'));
    }
  }
});

// ==================== Responses API Endpoint ====================

// Helper to generate unique IDs
function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}

// Helper to parse tool calls from LLM response
function parseToolCalls(content: string, tools: FunctionTool[]): { text: string; toolCalls: ResponseFunctionCallItem[] } {
  const toolCalls: ResponseFunctionCallItem[] = [];
  let remainingText = content;

  // Look for JSON-formatted tool calls in the response
  // Common patterns: <tool_call>, ```json, or direct JSON objects
  const toolCallPatterns = [
    /<tool_call>([\s\S]*?)<\/tool_call>/g,
    /```(?:json)?\s*\n?({[\s\S]*?"name"[\s\S]*?"arguments"[\s\S]*?})\s*\n?```/g,
    /\{\s*"tool_calls?"\s*:\s*\[([\s\S]*?)\]\s*\}/g
  ];

  for (const pattern of toolCallPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      try {
        let parsed = JSON.parse(match[1] || match[0]);

        // Handle both single tool call and array of tool calls
        const calls = Array.isArray(parsed) ? parsed : (parsed.tool_calls || [parsed]);

        for (const call of calls) {
          if (call.name && tools.some(t => t.function.name === call.name)) {
            const toolCall: ResponseFunctionCallItem = {
              type: 'function_call',
              id: generateId('fc'),
              call_id: generateId('call'),
              name: call.name,
              arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments || {}),
              status: 'completed'
            };
            toolCalls.push(toolCall);
            remainingText = remainingText.replace(match[0], '').trim();
          }
        }
      } catch (e) {
        // Not valid JSON, continue
      }
    }
  }

  return { text: remainingText, toolCalls };
}

// Build tool instructions for the system prompt
function buildToolInstructions(tools: FunctionTool[]): string {
  if (!tools || tools.length === 0) return '';

  const toolDescriptions = tools.map(tool => {
    const params = tool.function.parameters
      ? `\nParameters: ${JSON.stringify(tool.function.parameters, null, 2)}`
      : '';
    return `- ${tool.function.name}: ${tool.function.description || 'No description'}${params}`;
  }).join('\n');

  return `\n\nYou have access to the following tools:\n${toolDescriptions}\n\nTo use a tool, respond with a JSON object in this format:\n\`\`\`json\n{"name": "tool_name", "arguments": {"arg1": "value1"}}\n\`\`\`\n\nYou can make multiple tool calls if needed. After receiving tool results, continue your response.`;
}

// POST /v1/responses - Create a model response (new OpenAI API)
app.post<{}, {}, CreateResponseRequest>('/v1/responses', async (req, res) => {
  const { model, input, instructions, stream, temperature, max_output_tokens, metadata, tools, tool_choice } = req.body;

  // Validate required field
  if (!model) {
    return res.status(400).json(errorResponse('Missing required field: model', 'invalid_request_error', 'model'));
  }

  // Remove vendor prefixes
  const cleanModel = model.split('/').pop()!;

  // Convert input to chat messages
  const messages: { role: string; content: string }[] = [];

  // Build system instructions with tool information
  let systemInstructions = instructions || '';
  if (tools && tools.length > 0) {
    systemInstructions += buildToolInstructions(tools);
  }

  // Add instructions as system message if provided
  if (systemInstructions) {
    messages.push({ role: 'system', content: systemInstructions });
  }

  // Process input
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (item.type === 'message') {
        const content = typeof item.content === 'string'
          ? item.content
          : item.content.map(c => c.text).join('');
        messages.push({ role: item.role, content });
      } else if ((item as any).type === 'function_call_output') {
        // Handle tool output from previous turn
        const toolOutput = item as unknown as ResponseFunctionCallOutputItem;
        messages.push({
          role: 'user',
          content: `Tool result for call_id ${toolOutput.call_id}:\n${toolOutput.output}`
        });
      }
    }
  }

  // Build chat completion request
  const chatRequest: ChatCompletionRequest = {
    model: cleanModel,
    messages,
    stream: stream ?? false,
    temperature,
    max_tokens: max_output_tokens
  };

  const responseId = `resp_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
  const createdAt = Math.floor(Date.now() / 1000);

  if (stream) {
    // Streaming mode
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      // Send initial response.created event
      const initialResponse: ResponseObject = {
        id: responseId,
        object: 'response',
        created_at: createdAt,
        status: 'in_progress',
        completed_at: null,
        error: null,
        incomplete_details: null,
        instructions: instructions ?? null,
        max_output_tokens: max_output_tokens ?? null,
        model: cleanModel,
        output: [],
        parallel_tool_calls: true,
        previous_response_id: req.body.previous_response_id ?? null,
        temperature: temperature ?? 1,
        top_p: req.body.top_p ?? 1,
        truncation: 'disabled',
        usage: null,
        metadata: metadata ?? {}
      };

      res.write(`event: response.created\ndata: ${JSON.stringify(initialResponse)}\n\n`);

      const streamIterator = await processChatRequest(chatRequest) as AsyncIterable<ChatCompletionChunk>;
      let fullContent = '';
      const messageId = generateId('msg');

      for await (const chunk of streamIterator) {
        const deltaContent = chunk.choices[0]?.delta?.content ?? '';
        fullContent += deltaContent;

        if (deltaContent) {
          // Send content delta event
          res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ delta: deltaContent })}\n\n`);
        }
      }

      // Parse for tool calls if tools are provided
      let output: ResponseOutputItemUnion[] = [];
      let textContent = fullContent;

      if (tools && tools.length > 0) {
        const { text, toolCalls } = parseToolCalls(fullContent, tools);
        textContent = text;

        // Send tool call events
        for (const toolCall of toolCalls) {
          res.write(`event: response.function_call_arguments.done\ndata: ${JSON.stringify(toolCall)}\n\n`);
          output.push(toolCall);
        }
      }

      // Add text message if there's remaining content
      if (textContent.trim()) {
        output.push({
          type: 'message',
          id: messageId,
          status: 'completed',
          role: 'assistant',
          content: [{
            type: 'output_text',
            text: textContent,
            annotations: []
          }]
        });
      }

      // If only tool calls and no text, still need at least one output
      if (output.length === 0) {
        output.push({
          type: 'message',
          id: messageId,
          status: 'completed',
          role: 'assistant',
          content: [{
            type: 'output_text',
            text: fullContent,
            annotations: []
          }]
        });
      }

      // Send completed response
      const completedResponse = {
        ...initialResponse,
        status: 'completed' as const,
        completed_at: Math.floor(Date.now() / 1000),
        output,
        tools: tools ?? [],
        usage: {
          input_tokens: 0,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: fullContent.length,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: fullContent.length
        }
      };

      res.write(`event: response.completed\ndata: ${JSON.stringify(completedResponse)}\n\n`);
      res.write('event: done\ndata: [DONE]\n\n');
      res.end();
    } catch (error) {
      console.error('Responses API streaming error:', error);
      res.write(`event: error\ndata: ${JSON.stringify({ error: { message: 'Stream error', type: 'server_error' } })}\n\n`);
      res.end();
    }
  } else {
    // Non-streaming mode
    try {
      const chatResponse = await processChatRequest(chatRequest) as ChatCompletionResponse;
      const rawContent = typeof chatResponse.choices[0]?.message?.content === 'string'
        ? chatResponse.choices[0].message.content
        : JSON.stringify(chatResponse.choices[0]?.message?.content ?? '');

      const messageId = generateId('msg');

      // Parse for tool calls if tools are provided
      let output: ResponseOutputItemUnion[] = [];
      let textContent = rawContent;

      if (tools && tools.length > 0) {
        const { text, toolCalls } = parseToolCalls(rawContent, tools);
        textContent = text;

        // Add tool calls to output
        output.push(...toolCalls);
      }

      // Add text message if there's remaining content
      if (textContent.trim()) {
        output.push({
          type: 'message',
          id: messageId,
          status: 'completed',
          role: 'assistant',
          content: [{
            type: 'output_text',
            text: textContent,
            annotations: []
          }]
        });
      }

      // If only tool calls and no text, still need at least one output
      if (output.length === 0) {
        output.push({
          type: 'message',
          id: messageId,
          status: 'completed',
          role: 'assistant',
          content: [{
            type: 'output_text',
            text: rawContent,
            annotations: []
          }]
        });
      }

      const response = {
        id: responseId,
        object: 'response' as const,
        created_at: createdAt,
        status: 'completed' as const,
        completed_at: Math.floor(Date.now() / 1000),
        error: null,
        incomplete_details: null,
        instructions: instructions ?? null,
        max_output_tokens: max_output_tokens ?? null,
        model: cleanModel,
        output,
        parallel_tool_calls: req.body.parallel_tool_calls ?? true,
        previous_response_id: req.body.previous_response_id ?? null,
        temperature: temperature ?? 1,
        top_p: req.body.top_p ?? 1,
        truncation: 'disabled' as const,
        usage: {
          input_tokens: chatResponse.usage?.prompt_tokens ?? 0,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: chatResponse.usage?.completion_tokens ?? rawContent.length,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: chatResponse.usage?.total_tokens ?? rawContent.length
        },
        metadata: metadata ?? {},
        tools: tools ?? []
      };

      res.json(response);
    } catch (error) {
      console.error('Responses API error:', error);
      res.status(500).json(errorResponse('Error processing request', 'server_error'));
    }
  }
});

// ==================== Chat Completions Endpoint ====================

// Helper to parse tool calls for chat completions format
function parseChatToolCalls(content: string, tools: FunctionTool[]): { text: string; toolCalls: ToolCall[] } {
  const toolCalls: ToolCall[] = [];
  let remainingText = content;

  // Look for JSON-formatted tool calls in the response
  const toolCallPatterns = [
    /<tool_call>([\s\S]*?)<\/tool_call>/g,
    /```(?:json)?\s*\n?({[\s\S]*?"name"[\s\S]*?"arguments"[\s\S]*?})\s*\n?```/g,
    /\{\s*"tool_calls?"\s*:\s*\[([\s\S]*?)\]\s*\}/g
  ];

  for (const pattern of toolCallPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      try {
        let parsed = JSON.parse(match[1] || match[0]);
        const calls = Array.isArray(parsed) ? parsed : (parsed.tool_calls || [parsed]);

        for (const call of calls) {
          if (call.name && tools.some(t => t.function.name === call.name)) {
            const toolCall: ToolCall = {
              id: generateId('call'),
              type: 'function',
              function: {
                name: call.name,
                arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments || {})
              }
            };
            toolCalls.push(toolCall);
            remainingText = remainingText.replace(match[0], '').trim();
          }
        }
      } catch (e) {
        // Not valid JSON, continue
      }
    }
  }

  return { text: remainingText, toolCalls };
}

app.post<{}, {}, ChatCompletionRequest>('/v1/chat/completions', async (req, res) => {
  const { model, stream, tools, tool_choice } = req.body;

// Remove vendor prefixes so that only the actual model name is used.
  // For instance, "openrouter/anthropic/claude-3.5-sonnet" becomes "claude-3.5-sonnet".
  req.body.model = model.split('/').pop()!;

  // If tools are provided, inject tool instructions into the messages
  if (tools && tools.length > 0) {
    const toolInstructions = buildToolInstructions(tools);

    // Find or create system message
    const systemMsgIndex = req.body.messages.findIndex(m => m.role === 'system');
    if (systemMsgIndex >= 0) {
      const existingContent = req.body.messages[systemMsgIndex].content;
      req.body.messages[systemMsgIndex].content =
        (typeof existingContent === 'string' ? existingContent : '') + toolInstructions;
    } else {
      req.body.messages.unshift({ role: 'system', content: toolInstructions.trim() });
    }

    // Convert tool role messages to user messages with context
    req.body.messages = req.body.messages.map(msg => {
      if (msg.role === 'tool' && msg.tool_call_id) {
        return {
          role: 'user',
          content: `Tool result for ${msg.tool_call_id}:\n${msg.content}`
        };
      }
      // Convert assistant messages with tool_calls to include the call info
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        const toolCallsText = msg.tool_calls.map(tc =>
          `Called ${tc.function.name} with arguments: ${tc.function.arguments}`
        ).join('\n');
        return {
          role: 'assistant',
          content: (msg.content || '') + '\n' + toolCallsText
        };
      }
      return msg;
    });
  }

  if (stream) {
    // Set headers for streaming.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      // Call processChatRequest and expect an async iterator for streaming.
      const streamIterator = await processChatRequest(req.body) as AsyncIterable<ChatCompletionChunk>;
      for await (const chunk of streamIterator) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        console.log(`Sent chunk with content: ${chunk.choices[0].delta.content}`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    } catch (error) {
      console.error("Streaming error:", error);
      return res.status(500).json(errorResponse('Streaming error', 'server_error'));
    }
  } else {
    try {
      // For non-streaming, await a full response.
      const fullResponse = await processChatRequest(req.body) as ChatCompletionResponse;

      // If tools were provided, check for tool calls in the response
      if (tools && tools.length > 0 && fullResponse.choices[0]?.message?.content) {
        const content = typeof fullResponse.choices[0].message.content === 'string'
          ? fullResponse.choices[0].message.content
          : JSON.stringify(fullResponse.choices[0].message.content);

        const { text, toolCalls } = parseChatToolCalls(content, tools);

        if (toolCalls.length > 0) {
          // Return response with tool_calls
          fullResponse.choices[0].message = {
            role: 'assistant',
            content: text.trim() || null,
            tool_calls: toolCalls
          };
          fullResponse.choices[0].finish_reason = 'tool_calls';
        }
      }

      return res.json(fullResponse);
    } catch (error) {
      console.error("Non-streaming error:", error);
      return res.status(500).json(
        errorResponse('Error processing request', 'server_error')
      );
    }
  }
});

// ==================== Assistants API Routes ====================

// Mount assistants router for /v1/assistants, /v1/threads, etc.
app.use(assistantsRouter);

// ==================== Health Check ====================

app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ==================== 404 Handler ====================

app.use((req: Request, res: Response) => {
  res.status(404).json(
    errorResponse(
      `Unknown endpoint: ${req.method} ${req.path}`,
      'invalid_request_error',
      null,
      'unknown_endpoint'
    )
  );
});

export function startServer(port: number = 3000) {
  const server = app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
  return server;
}

// If running as a standalone Node process, start the server automatically.
if (require.main === module) {
  startServer();
}
