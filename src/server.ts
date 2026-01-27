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
  OpenAIErrorResponse
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

// ==================== Chat Completions Endpoint ====================
app.post<{}, {}, ChatCompletionRequest>('/v1/chat/completions', async (req, res) => {
  const { model, stream } = req.body;

// Remove vendor prefixes so that only the actual model name is used.
  // For instance, "openrouter/anthropic/claude-3.5-sonnet" becomes "claude-3.5-sonnet".
  req.body.model = model.split('/').pop()!;

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
