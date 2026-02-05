import express, { Request, Response } from 'express';
import morgan from 'morgan';
import {
  ChatCompletionRequest,
  ChatCompletionChunk,
  ChatCompletionResponse,
  CompletionRequest,
  CompletionResponse,
  EmbeddingRequest,
  ModelObject,
  ModelsListResponse,
  CreateResponseRequest,
  ResponseObject,
  ResponseFunctionCallItem,
  ResponseFunctionCallOutputItem,
  ResponseOutputItemUnion,
  ChatMessage
} from './types';
import { processChatRequest, getAvailableModels } from './extension';
import { assistantsRouter } from './assistants';
import { generateId, errorResponse, setApiTokens, addApiToken, removeApiToken, authMiddleware } from './utils';

const app = express();

// Middleware to parse JSON bodies (50MB limit to accommodate large tool results)
app.use(express.json({ limit: '50mb' }));

// Logger middleware
app.use(morgan('combined'));

// Re-export for extension.ts imports
export { setApiTokens, addApiToken, removeApiToken };

// Apply auth middleware to all routes
app.use(authMiddleware);

// errorResponse and generateId are imported from ./utils

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
      }
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (error) {
      console.error('Streaming completions error:', error);
      if (!res.headersSent) {
        res.status(500).json(errorResponse('Streaming error', 'server_error'));
      } else {
        res.write(`data: ${JSON.stringify({ error: { message: 'Stream error', type: 'server_error' } })}\n\n`);
        res.end();
      }
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

// POST /v1/responses - Create a model response (new OpenAI API)
app.post<{}, {}, CreateResponseRequest>('/v1/responses', async (req, res) => {
  const { model, input, instructions, stream, temperature, max_output_tokens, metadata, tools, tool_choice } = req.body;

  // Validate required field
  if (!model) {
    return res.status(400).json(errorResponse('Missing required field: model', 'invalid_request_error', 'model'));
  }

  // Remove vendor prefixes (don't mutate req.body)
  const cleanModel = model.split('/').pop()!;

  // Convert input to chat messages
  const messages: ChatMessage[] = [];

  // Add instructions as system message if provided
  if (instructions) {
    messages.push({ role: 'system', content: instructions });
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
      } else if ('call_id' in item && 'output' in item) {
        // Handle tool output from previous turn (function_call_output)
        const toolOutput = item as unknown as ResponseFunctionCallOutputItem;
        messages.push({
          role: 'user',
          content: `Tool result for call_id ${toolOutput.call_id}:\n${toolOutput.output}`
        });
      }
    }
  }

  // Build chat completion request with native tool support
  const chatRequest: ChatCompletionRequest = {
    model: cleanModel,
    messages,
    stream: stream ?? false,
    temperature,
    max_tokens: max_output_tokens,
    tools: tools,
    // Map 'required' to 'auto' since ChatCompletionRequest doesn't support 'required'
    tool_choice: (tool_choice === 'required' ? 'auto' : tool_choice) as ChatCompletionRequest['tool_choice'],
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
      const output: ResponseOutputItemUnion[] = [];
      const toolCalls: ResponseFunctionCallItem[] = [];

      for await (const chunk of streamIterator) {
        const deltaContent = chunk.choices[0]?.delta?.content ?? '';
        fullContent += deltaContent;

        if (deltaContent) {
          // Send content delta event
          res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ delta: deltaContent })}\n\n`);
        }

        // Check for native tool calls in the chunk
        const chunkToolCalls = chunk.choices[0]?.delta?.tool_calls;
        if (chunkToolCalls) {
          for (const tc of chunkToolCalls) {
            if (tc.id && tc.function?.name) {
              const toolCall: ResponseFunctionCallItem = {
                type: 'function_call',
                id: generateId('fc'),
                call_id: tc.id,
                name: tc.function.name,
                arguments: tc.function.arguments ?? '{}',
                status: 'completed'
              };
              toolCalls.push(toolCall);
              res.write(`event: response.function_call_arguments.done\ndata: ${JSON.stringify(toolCall)}\n\n`);
              output.push(toolCall);
            }
          }
        }
      }

      // Add text message if there's content
      if (fullContent.trim()) {
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

      // If no output at all, add an empty message
      if (output.length === 0) {
        output.push({
          type: 'message',
          id: messageId,
          status: 'completed',
          role: 'assistant',
          content: [{
            type: 'output_text',
            text: '',
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
      const output: ResponseOutputItemUnion[] = [];

      // Convert native tool calls from processChatRequest to ResponseFunctionCallItem
      const nativeToolCalls = chatResponse.choices[0]?.message?.tool_calls;
      if (nativeToolCalls && nativeToolCalls.length > 0) {
        for (const tc of nativeToolCalls) {
          const toolCall: ResponseFunctionCallItem = {
            type: 'function_call',
            id: generateId('fc'),
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
            status: 'completed'
          };
          output.push(toolCall);
        }
      }

      // Add text message if there's content
      if (rawContent.trim()) {
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

      // If no output at all, add an empty message
      if (output.length === 0) {
        output.push({
          type: 'message',
          id: messageId,
          status: 'completed',
          role: 'assistant',
          content: [{
            type: 'output_text',
            text: '',
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

app.post<{}, {}, ChatCompletionRequest>('/v1/chat/completions', async (req, res) => {
  const { model, stream, tools, tool_choice } = req.body;

  // Remove vendor prefixes so that only the actual model name is used.
  // For instance, "openrouter/anthropic/claude-3.5-sonnet" becomes "claude-3.5-sonnet".
  const cleanModel = model.split('/').pop()!;
  req.body.model = cleanModel;

  if (stream) {
    // Set headers for streaming.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      // Call processChatRequest — tools are passed natively through the request
      // and tool calls come back as proper delta.tool_calls chunks
      const streamIterator = await processChatRequest(req.body) as AsyncIterable<ChatCompletionChunk>;

      for await (const chunk of streamIterator) {
        // Forward the chunk directly to the client (tool calls are already in the chunk)
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }

      res.write("data: [DONE]\n\n");
      res.end();
    } catch (error) {
      console.error("Streaming error:", error);
      if (!res.headersSent) {
        return res.status(500).json(errorResponse('Streaming error', 'server_error'));
      } else {
        res.write(`data: ${JSON.stringify({ error: { message: 'Stream error', type: 'server_error' } })}\n\n`);
        res.end();
      }
    }
  } else {
    try {
      // For non-streaming, await a full response.
      // Tools are handled natively — tool_calls and finish_reason are already set by processChatRequest
      const fullResponse = await processChatRequest(req.body) as ChatCompletionResponse;
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

export function startServer(port: number = 3000, tokens: string[] = []) {
  setApiTokens(tokens);
  const server = app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
  return server;
}

// If running as a standalone Node process, start the server automatically.
if (require.main === module) {
  startServer();
}
