/**
 * Express Server Factory
 *
 * Creates a configured Express application using an injected ChatBackend.
 * This factory pattern lets both VS Code and CLI platforms share the same
 * server code while using different LLM backends.
 */

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
  ChatMessage,
} from './types.js';
import { ChatBackend, Logger } from './backend.js';
import { responsesToolsToFunctionTools } from './toolConvert.js';
import { assistantsRouter } from './assistants/index.js';
import { skillsRouter } from './skills/index.js';
import { resolveSkills, buildSkillInstructions } from './skills/resolver.js';
import { generateId, errorResponse, setApiTokens, addApiToken, removeApiToken, authMiddleware } from './utils.js';
import { setRunnerBackend } from './assistants/runner.js';

export { setApiTokens, addApiToken, removeApiToken };

function isEmbeddingsProposalUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('CANNOT use API proposal: embeddings')
    || message.includes('No embedding models available')
    || message.includes('embeddings_not_supported');
}

export function createApp(backend: ChatBackend, logger: Logger) {
  const app = express();

  // Inject backend into the runner module so assistants can call processChatRequest
  setRunnerBackend(backend);

  // Parse JSON bodies (50MB limit)
  app.use(express.json({ limit: '50mb' }));

  // Request logging
  app.use((req: Request, _res: Response, next) => {
    const timestamp = new Date().toISOString();
    logger.log(`\n[${timestamp}] ${req.method} ${req.path}`);

    if (Object.keys(req.query).length > 0) {
      logger.log(`  Query: ${JSON.stringify(req.query)}`);
    }

    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
      const contentLength = req.headers['content-length'];
      const isArray = Array.isArray(req.body);
      const bodyType = isArray ? 'array' : typeof req.body;
      let details = `type=${bodyType}`;
      if (bodyType === 'object' && req.body && !isArray) {
        const keys = Object.keys(req.body);
        details += `, keys=[${keys.slice(0, 20).join(', ')}]`;
        if (keys.length > 20) {
          details += `, +${keys.length - 20} more`;
        }
      }
      if (contentLength) {
        details += `, content-length=${contentLength}`;
      }
      logger.log(`  Body: ${details}`);
    }

    next();
  });

  app.use(morgan('combined'));
  app.use(authMiddleware);

  // ==================== Models Endpoints ====================

  app.get('/v1/models', async (req: Request, res: Response) => {
    try {
      const models = await backend.getAvailableModels();
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

  app.get('/v1/models/:model', async (req: Request, res: Response) => {
    try {
      const models = await backend.getAvailableModels();
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

  // ==================== Embeddings Endpoint ====================

  app.post('/v1/embeddings', async (req: Request<{}, {}, EmbeddingRequest>, res: Response) => {
    if (!backend.processEmbeddingRequest) {
      return res.status(501).json(
        errorResponse(
          'Embeddings are not supported by this backend. Use the VS Code extension variant for embeddings support.',
          'not_implemented',
          null,
          'embeddings_not_supported'
        )
      );
    }

    const { input } = req.body;
    const raw = Array.isArray(input) ? input : [input];
    const filtered = raw.filter(s => typeof s === 'string' && s.length > 0);
    if (filtered.length === 0) {
      return res.status(400).json(
        errorResponse(
          'Embedding input must be a non-empty string or an array of non-empty strings.',
          'invalid_request_error'
        )
      );
    }
    req.body.input = filtered.length === 1 && !Array.isArray(input) ? filtered[0] : filtered;

    try {
      const result = await backend.processEmbeddingRequest(req.body);
      res.json(result);
    } catch (err: any) {
      const message = err?.message ?? 'Unknown error computing embeddings';
      const proposalUnavailable = isEmbeddingsProposalUnavailable(err);
      res.status(proposalUnavailable ? 501 : 500).json(
        errorResponse(
          message,
          proposalUnavailable ? 'not_implemented' : 'server_error',
          null,
          proposalUnavailable ? 'embeddings_proposal_not_enabled' : 'embedding_error'
        )
      );
    }
  });

  // ==================== Legacy Completions Endpoint ====================

  app.post<{}, {}, CompletionRequest>('/v1/completions', async (req: Request, res: Response) => {
    const { model, prompt, stream } = req.body;
    const promptText = Array.isArray(prompt) ? prompt.join('\n') : prompt;
    const cleanModel = model.split('/').pop()!;

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
        const streamIterator = await backend.processChatRequest(chatRequest) as AsyncIterable<ChatCompletionChunk>;
        for await (const chunk of streamIterator) {
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
        const chatResponse = await backend.processChatRequest(chatRequest) as ChatCompletionResponse;
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

  app.post<{}, {}, CreateResponseRequest>('/v1/responses', async (req, res) => {
    const { model, input, instructions, stream, temperature, max_output_tokens, metadata, tools, tool_choice, skills } = req.body;

    if (!model) {
      return res.status(400).json(errorResponse('Missing required field: model', 'invalid_request_error', 'model'));
    }

    const cleanModel = model.split('/').pop()!;

    let skillInstructions = '';
    if (skills && skills.length > 0) {
      try {
        const resolved = resolveSkills(skills);
        skillInstructions = buildSkillInstructions(resolved);
      } catch (err) {
        return res.status(400).json(
          errorResponse(err instanceof Error ? err.message : 'Failed to resolve skills', 'invalid_request_error', 'skills')
        );
      }
    }

    if (tools) {
      for (const tool of tools) {
        if (tool.environment?.skills && Array.isArray(tool.environment.skills)) {
          try {
            const resolved = resolveSkills(tool.environment.skills);
            skillInstructions += buildSkillInstructions(resolved);
          } catch (err) {
            return res.status(400).json(
              errorResponse(err instanceof Error ? err.message : 'Failed to resolve skills', 'invalid_request_error', 'tools')
            );
          }
        }
      }
    }

    const messages: ChatMessage[] = [];

    const combinedInstructions = (instructions ?? '') + skillInstructions;
    if (combinedInstructions) {
      messages.push({ role: 'system', content: combinedInstructions });
    }

    if (typeof input === 'string') {
      messages.push({ role: 'user', content: input });
    } else if (Array.isArray(input)) {
      for (const item of input) {
        if (item.type === 'message' || ('role' in item && !('call_id' in item))) {
          const content = typeof item.content === 'string'
            ? item.content
            : item.content.map((c: any) => c.text).join('');
          messages.push({ role: item.role, content });
        } else if ('call_id' in item && 'output' in item) {
          const toolOutput = item as unknown as ResponseFunctionCallOutputItem;
          messages.push({
            role: 'user',
            content: `Tool result for call_id ${toolOutput.call_id}:\n${toolOutput.output}`
          });
        }
      }
    }

    const functionTools = tools
      ? responsesToolsToFunctionTools(tools.filter((t: any) => t.type === 'function'))
      : undefined;

    const chatRequest: ChatCompletionRequest = {
      model: cleanModel,
      messages,
      stream: stream ?? false,
      temperature,
      max_tokens: max_output_tokens,
      tools: functionTools?.length ? functionTools : undefined,
      tool_choice: (tool_choice === 'required' ? 'auto' : tool_choice) as ChatCompletionRequest['tool_choice'],
    };

    const responseId = `resp_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
    const createdAt = Math.floor(Date.now() / 1000);

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      try {
        const initialResponse: ResponseObject = {
          id: responseId,
          object: 'response',
          created_at: createdAt,
          status: 'in_progress',
          background: false,
          completed_at: null,
          conversation: null,
          error: null,
          incomplete_details: null,
          instructions: instructions ?? null,
          max_output_tokens: max_output_tokens ?? null,
          max_tool_calls: null,
          model: cleanModel,
          output: [],
          output_text: '',
          parallel_tool_calls: req.body.parallel_tool_calls ?? true,
          previous_response_id: req.body.previous_response_id ?? null,
          reasoning: null,
          service_tier: 'default',
          temperature: temperature ?? 1,
          text: null,
          tool_choice: tool_choice ?? 'auto',
          tools: tools ?? [],
          top_p: req.body.top_p ?? 1,
          truncation: 'disabled',
          usage: null,
          user: req.body.user ?? null,
          metadata: metadata ?? {}
        };

        res.write(`event: response.created\ndata: ${JSON.stringify(initialResponse)}\n\n`);

        const streamIterator = await backend.processChatRequest(chatRequest) as AsyncIterable<ChatCompletionChunk>;
        let fullContent = '';
        const messageId = generateId('msg');
        const output: ResponseOutputItemUnion[] = [];

        for await (const chunk of streamIterator) {
          const deltaContent = chunk.choices[0]?.delta?.content ?? '';
          fullContent += deltaContent;

          if (deltaContent) {
            res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ delta: deltaContent })}\n\n`);
          }

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
                res.write(`event: response.function_call_arguments.done\ndata: ${JSON.stringify(toolCall)}\n\n`);
                output.push(toolCall);
              }
            }
          }
        }

        if (fullContent.trim()) {
          output.push({
            type: 'message',
            id: messageId,
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: fullContent, annotations: [] }]
          });
        }

        if (output.length === 0) {
          output.push({
            type: 'message',
            id: messageId,
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: '', annotations: [] }]
          });
        }

        const completedResponse: ResponseObject = {
          ...initialResponse,
          status: 'completed' as const,
          completed_at: Math.floor(Date.now() / 1000),
          output,
          output_text: fullContent,
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
      try {
        const chatResponse = await backend.processChatRequest(chatRequest) as ChatCompletionResponse;
        const rawContent = typeof chatResponse.choices[0]?.message?.content === 'string'
          ? chatResponse.choices[0].message.content
          : JSON.stringify(chatResponse.choices[0]?.message?.content ?? '');

        const messageId = generateId('msg');
        const output: ResponseOutputItemUnion[] = [];

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

        if (rawContent.trim()) {
          output.push({
            type: 'message',
            id: messageId,
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: rawContent, annotations: [] }]
          });
        }

        if (output.length === 0) {
          output.push({
            type: 'message',
            id: messageId,
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: '', annotations: [] }]
          });
        }

        const response: ResponseObject = {
          id: responseId,
          object: 'response',
          created_at: createdAt,
          status: 'completed',
          background: false,
          completed_at: Math.floor(Date.now() / 1000),
          conversation: null,
          error: null,
          incomplete_details: null,
          instructions: instructions ?? null,
          max_output_tokens: max_output_tokens ?? null,
          max_tool_calls: null,
          model: cleanModel,
          output,
          output_text: rawContent,
          parallel_tool_calls: req.body.parallel_tool_calls ?? true,
          previous_response_id: req.body.previous_response_id ?? null,
          reasoning: null,
          service_tier: 'default',
          temperature: temperature ?? 1,
          text: null,
          tool_choice: tool_choice ?? 'auto',
          tools: tools ?? [],
          top_p: req.body.top_p ?? 1,
          truncation: 'disabled',
          usage: {
            input_tokens: chatResponse.usage?.prompt_tokens ?? 0,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: chatResponse.usage?.completion_tokens ?? rawContent.length,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: chatResponse.usage?.total_tokens ?? rawContent.length
          },
          user: req.body.user ?? null,
          metadata: metadata ?? {}
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
    const { model, stream } = req.body;
    const cleanModel = model.split('/').pop()!;
    req.body.model = cleanModel;

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      try {
        const streamIterator = await backend.processChatRequest(req.body) as AsyncIterable<ChatCompletionChunk>;
        for await (const chunk of streamIterator) {
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
        const fullResponse = await backend.processChatRequest(req.body) as ChatCompletionResponse;
        return res.json(fullResponse);
      } catch (error) {
        console.error("Non-streaming error:", error);
        return res.status(500).json(errorResponse('Error processing request', 'server_error'));
      }
    }
  });

  // ==================== Assistants API Routes ====================

  app.use(assistantsRouter);

  // ==================== Skills API Routes ====================

  app.use('/v1/skills', skillsRouter);

  // ==================== Health Check ====================

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ==================== 404 Handler ====================

  app.use((req: Request, res: Response) => {
    logger.log(`\n⚠️  UNIMPLEMENTED ENDPOINT: ${req.method} ${req.path}`);
    res.status(404).json(
      errorResponse(
        `Unknown endpoint: ${req.method} ${req.path}`,
        'invalid_request_error',
        null,
        'unknown_endpoint'
      )
    );
  });

  return app;
}

export function startServer(backend: ChatBackend, logger: Logger, port: number = 3000, tokens: string[] = []) {
  setApiTokens(tokens);
  const app = createApp(backend, logger);
  const server = app.listen(port, () => {
    logger.log(`Server is running on port ${port}`);
  });
  return server;
}
