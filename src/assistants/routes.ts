/**
 * Express Routes for OpenAI Assistants API
 * 
 * Implements all CRUD operations for:
 * - /v1/assistants
 * - /v1/threads
 * - /v1/threads/:thread_id/messages
 * - /v1/threads/:thread_id/runs
 * 
 * Future extensibility:
 * - /v1/threads/runs (create thread and run)
 * - /v1/threads/:thread_id/runs/:run_id/steps
 * - /v1/threads/:thread_id/runs/:run_id/submit_tool_outputs
 */

import { Router, Request, Response } from 'express';
import { state } from './state';
import { executeRun, executeRunNonStreaming, requestRunCancellation, continueRunWithToolOutputs, continueRunWithToolOutputsNonStreaming } from './runner';
import {
  Assistant,
  Thread,
  Run,
  Message,
  CreateAssistantRequest,
  UpdateAssistantRequest,
  CreateThreadRequest,
  CreateMessageRequest,
  CreateRunRequest,
  CreateThreadAndRunRequest,
  SubmitToolOutputsRequest,
  TextContent,
  PaginationParams,
  StreamEvent
} from './types';

const router = Router();

// ==================== Error Helpers ====================

interface OpenAIError {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

function errorResponse(message: string, type = 'invalid_request_error', param: string | null = null, code: string | null = null): OpenAIError {
  return {
    error: {
      message,
      type,
      param,
      code
    }
  };
}

function notFoundError(resource: string): OpenAIError {
  return errorResponse(`No ${resource} found`, 'invalid_request_error', null, 'resource_not_found');
}

// ==================== Validation Helpers ====================

function validateRequired<T extends object>(body: T, fields: (keyof T)[]): string | null {
  for (const field of fields) {
    if (body[field] === undefined || body[field] === null) {
      return `Missing required field: ${String(field)}`;
    }
  }
  return null;
}

function parsePaginationParams(query: Request['query']): PaginationParams {
  return {
    limit: query.limit ? Math.min(parseInt(query.limit as string, 10), 100) : 20,
    order: (query.order as 'asc' | 'desc') ?? 'desc',
    after: query.after as string | undefined,
    before: query.before as string | undefined
  };
}

// ==================== Assistants Routes ====================

// Create assistant
router.post('/v1/assistants', (req: Request, res: Response) => {
  const body = req.body as CreateAssistantRequest;
  
  const validationError = validateRequired(body, ['model']);
  if (validationError) {
    return res.status(400).json(errorResponse(validationError, 'invalid_request_error', 'model'));
  }

  const assistant: Assistant = {
    id: state.generateAssistantId(),
    object: 'assistant',
    created_at: Math.floor(Date.now() / 1000),
    name: body.name ?? null,
    description: body.description ?? null,
    model: body.model,
    instructions: body.instructions ?? null,
    tools: body.tools ?? [],
    metadata: body.metadata ?? {}
  };

  state.createAssistant(assistant);
  res.status(201).json(assistant);
});

// List assistants
router.get('/v1/assistants', (req: Request, res: Response) => {
  const params = parsePaginationParams(req.query);
  const result = state.listAssistants(params);
  res.json(result);
});

// Get assistant
router.get('/v1/assistants/:assistant_id', (req: Request, res: Response) => {
  const assistant = state.getAssistant(req.params.assistant_id);
  if (!assistant) {
    return res.status(404).json(notFoundError('assistant'));
  }
  res.json(assistant);
});

// Update assistant (POST for OpenAI compatibility)
router.post('/v1/assistants/:assistant_id', (req: Request, res: Response) => {
  const body = req.body as UpdateAssistantRequest;
  const updated = state.updateAssistant(req.params.assistant_id, body);
  if (!updated) {
    return res.status(404).json(notFoundError('assistant'));
  }
  res.json(updated);
});

// Delete assistant
router.delete('/v1/assistants/:assistant_id', (req: Request, res: Response) => {
  const deleted = state.deleteAssistant(req.params.assistant_id);
  res.json({
    id: req.params.assistant_id,
    object: 'assistant.deleted',
    deleted
  });
});

// ==================== Threads Routes ====================

// Create thread
router.post('/v1/threads', (req: Request, res: Response) => {
  const body = req.body as CreateThreadRequest || {};

  const thread: Thread = {
    id: state.generateThreadId(),
    object: 'thread',
    created_at: Math.floor(Date.now() / 1000),
    metadata: body.metadata ?? {}
  };

  state.createThread(thread);

  // Add initial messages if provided
  if (body.messages && Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      const content = typeof msg.content === 'string' 
        ? msg.content 
        : JSON.stringify(msg.content);
      
      const message: Message = {
        id: state.generateMessageId(),
        object: 'thread.message',
        created_at: Math.floor(Date.now() / 1000),
        thread_id: thread.id,
        status: 'completed',
        incomplete_details: null,
        completed_at: Math.floor(Date.now() / 1000),
        incomplete_at: null,
        role: msg.role || 'user',
        content: [{
          type: 'text',
          text: { value: content, annotations: [] }
        }],
        assistant_id: null,
        run_id: null,
        attachments: msg.attachments ?? [],
        metadata: msg.metadata ?? {}
      };
      state.addMessage(thread.id, message);
    }
  }

  res.status(201).json(thread);
});

// Get thread
router.get('/v1/threads/:thread_id', (req: Request, res: Response) => {
  const thread = state.getThread(req.params.thread_id);
  if (!thread) {
    return res.status(404).json(notFoundError('thread'));
  }
  res.json(thread);
});

// Update thread (POST for OpenAI compatibility)
router.post('/v1/threads/:thread_id', (req: Request, res: Response) => {
  const updated = state.updateThread(req.params.thread_id, req.body);
  if (!updated) {
    return res.status(404).json(notFoundError('thread'));
  }
  res.json(updated);
});

// Delete thread
router.delete('/v1/threads/:thread_id', (req: Request, res: Response) => {
  const deleted = state.deleteThread(req.params.thread_id);
  res.json({
    id: req.params.thread_id,
    object: 'thread.deleted',
    deleted
  });
});

// ==================== Messages Routes ====================

// Create message
router.post('/v1/threads/:thread_id/messages', (req: Request, res: Response) => {
  const { thread_id } = req.params;
  const thread = state.getThread(thread_id);
  if (!thread) {
    return res.status(404).json(notFoundError('thread'));
  }

  const body = req.body as CreateMessageRequest;
  
  const validationError = validateRequired(body, ['role', 'content']);
  if (validationError) {
    return res.status(400).json(errorResponse(validationError));
  }

  const content = typeof body.content === 'string' 
    ? body.content 
    : JSON.stringify(body.content);

  const message: Message = {
    id: state.generateMessageId(),
    object: 'thread.message',
    created_at: Math.floor(Date.now() / 1000),
    thread_id,
    status: 'completed',
    incomplete_details: null,
    completed_at: Math.floor(Date.now() / 1000),
    incomplete_at: null,
    role: body.role,
    content: [{
      type: 'text',
      text: { value: content, annotations: [] }
    }],
    assistant_id: null,
    run_id: null,
    attachments: body.attachments ?? [],
    metadata: body.metadata ?? {}
  };

  state.addMessage(thread_id, message);
  res.status(201).json(message);
});

// List messages
router.get('/v1/threads/:thread_id/messages', (req: Request, res: Response) => {
  const { thread_id } = req.params;
  const thread = state.getThread(thread_id);
  if (!thread) {
    return res.status(404).json(notFoundError('thread'));
  }

  const params = {
    ...parsePaginationParams(req.query),
    run_id: req.query.run_id as string | undefined
  };
  const result = state.getMessages(thread_id, params);
  res.json(result);
});

// Get message
router.get('/v1/threads/:thread_id/messages/:message_id', (req: Request, res: Response) => {
  const { thread_id, message_id } = req.params;
  const thread = state.getThread(thread_id);
  if (!thread) {
    return res.status(404).json(notFoundError('thread'));
  }

  const message = state.getMessage(thread_id, message_id);
  if (!message) {
    return res.status(404).json(notFoundError('message'));
  }
  res.json(message);
});

// Update message (POST for OpenAI compatibility) - only metadata can be updated
router.post('/v1/threads/:thread_id/messages/:message_id', (req: Request, res: Response) => {
  const { thread_id, message_id } = req.params;
  const thread = state.getThread(thread_id);
  if (!thread) {
    return res.status(404).json(notFoundError('thread'));
  }

  // Only metadata updates allowed
  const updated = state.updateMessage(thread_id, message_id, {
    metadata: req.body.metadata
  });
  if (!updated) {
    return res.status(404).json(notFoundError('message'));
  }
  res.json(updated);
});

// ==================== Runs Routes ====================

// Create run
router.post('/v1/threads/:thread_id/runs', async (req: Request, res: Response) => {
  const { thread_id } = req.params;
  const thread = state.getThread(thread_id);
  if (!thread) {
    return res.status(404).json(notFoundError('thread'));
  }

  const body = req.body as CreateRunRequest;
  
  const validationError = validateRequired(body, ['assistant_id']);
  if (validationError) {
    return res.status(400).json(errorResponse(validationError, 'invalid_request_error', 'assistant_id'));
  }

  const assistant = state.getAssistant(body.assistant_id);
  if (!assistant) {
    return res.status(404).json(notFoundError('assistant'));
  }

  // Add additional messages if provided
  if (body.additional_messages && Array.isArray(body.additional_messages)) {
    for (const msg of body.additional_messages) {
      const content = typeof msg.content === 'string' 
        ? msg.content 
        : JSON.stringify(msg.content);
      
      const message: Message = {
        id: state.generateMessageId(),
        object: 'thread.message',
        created_at: Math.floor(Date.now() / 1000),
        thread_id,
        status: 'completed',
        incomplete_details: null,
        completed_at: Math.floor(Date.now() / 1000),
        incomplete_at: null,
        role: msg.role || 'user',
        content: [{
          type: 'text',
          text: { value: content, annotations: [] }
        }],
        assistant_id: null,
        run_id: null,
        attachments: msg.attachments ?? [],
        metadata: msg.metadata ?? {}
      };
      state.addMessage(thread_id, message);
    }
  }

  const run: Run = {
    id: state.generateRunId(),
    object: 'thread.run',
    created_at: Math.floor(Date.now() / 1000),
    thread_id,
    assistant_id: body.assistant_id,
    status: 'queued',
    required_action: null,
    last_error: null,
    expires_at: Math.floor(Date.now() / 1000) + 600, // 10 minutes
    started_at: null,
    cancelled_at: null,
    failed_at: null,
    completed_at: null,
    incomplete_details: null,
    model: body.model ?? assistant.model,
    instructions: body.instructions ?? null,
    tools: body.tools ?? assistant.tools,
    metadata: body.metadata ?? {},
    usage: null
  };

  state.addRun(thread_id, run);

  // Check if streaming is requested
  if (body.stream) {
    // Streaming mode: use SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // Execute run with streaming
    (async () => {
      try {
        const generator = executeRun(thread_id, run.id, true);
        for await (const event of generator) {
          if (event.event === 'done') {
            res.write(`event: done\ndata: [DONE]\n\n`);
          } else {
            res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
          }
        }
      } catch (err) {
        console.error('Streaming run error:', err);
        res.write(`event: error\ndata: ${JSON.stringify({ error: { message: 'Stream error' } })}\n\n`);
      } finally {
        res.end();
      }
    })();
  } else {
    // Non-streaming mode: return immediately, execute async
    res.status(201).json(run);

    // Execute in background (don't await)
    executeRunNonStreaming(thread_id, run.id).catch(err => {
      console.error('Run execution failed:', err);
    });
  }
});

// List runs
router.get('/v1/threads/:thread_id/runs', (req: Request, res: Response) => {
  const { thread_id } = req.params;
  const thread = state.getThread(thread_id);
  if (!thread) {
    return res.status(404).json(notFoundError('thread'));
  }

  const params = parsePaginationParams(req.query);
  const result = state.getRuns(thread_id, params);
  res.json(result);
});

// Get run
router.get('/v1/threads/:thread_id/runs/:run_id', (req: Request, res: Response) => {
  const { thread_id, run_id } = req.params;
  const thread = state.getThread(thread_id);
  if (!thread) {
    return res.status(404).json(notFoundError('thread'));
  }

  const run = state.getRun(thread_id, run_id);
  if (!run) {
    return res.status(404).json(notFoundError('run'));
  }
  res.json(run);
});

// Update run (POST for OpenAI compatibility) - only metadata can be updated
router.post('/v1/threads/:thread_id/runs/:run_id', (req: Request, res: Response) => {
  const { thread_id, run_id } = req.params;
  const thread = state.getThread(thread_id);
  if (!thread) {
    return res.status(404).json(notFoundError('thread'));
  }

  const updated = state.updateRun(thread_id, run_id, {
    metadata: req.body.metadata
  });
  if (!updated) {
    return res.status(404).json(notFoundError('run'));
  }
  res.json(updated);
});

// Cancel run
router.post('/v1/threads/:thread_id/runs/:run_id/cancel', (req: Request, res: Response) => {
  const { thread_id, run_id } = req.params;
  const thread = state.getThread(thread_id);
  if (!thread) {
    return res.status(404).json(notFoundError('thread'));
  }

  const run = state.getRun(thread_id, run_id);
  if (!run) {
    return res.status(404).json(notFoundError('run'));
  }

  // Check if run can be cancelled
  const cancellableStatuses = ['queued', 'in_progress', 'requires_action'];
  if (!cancellableStatuses.includes(run.status)) {
    return res.status(400).json(
      errorResponse(`Cannot cancel run with status: ${run.status}`, 'invalid_request_error', 'status')
    );
  }

  // Request cancellation
  requestRunCancellation(thread_id, run_id);

  const updated = state.updateRun(thread_id, run_id, {
    status: 'cancelling',
    cancelled_at: Math.floor(Date.now() / 1000)
  });

  // After a short delay, mark as cancelled
  setTimeout(() => {
    const currentRun = state.getRun(thread_id, run_id);
    if (currentRun?.status === 'cancelling') {
      state.updateRun(thread_id, run_id, { status: 'cancelled' });
    }
  }, 100);

  res.json(updated);
});

// ==================== Create Thread and Run ====================

router.post('/v1/threads/runs', async (req: Request, res: Response) => {
  const body = req.body as CreateThreadAndRunRequest;
  
  const validationError = validateRequired(body, ['assistant_id']);
  if (validationError) {
    return res.status(400).json(errorResponse(validationError, 'invalid_request_error', 'assistant_id'));
  }

  const assistant = state.getAssistant(body.assistant_id);
  if (!assistant) {
    return res.status(404).json(notFoundError('assistant'));
  }

  // Create thread
  const threadBody = body.thread ?? {};
  const thread: Thread = {
    id: state.generateThreadId(),
    object: 'thread',
    created_at: Math.floor(Date.now() / 1000),
    metadata: threadBody.metadata ?? {}
  };

  state.createThread(thread);

  // Add initial messages if provided
  if (threadBody.messages && Array.isArray(threadBody.messages)) {
    for (const msg of threadBody.messages) {
      const content = typeof msg.content === 'string' 
        ? msg.content 
        : JSON.stringify(msg.content);
      
      const message: Message = {
        id: state.generateMessageId(),
        object: 'thread.message',
        created_at: Math.floor(Date.now() / 1000),
        thread_id: thread.id,
        status: 'completed',
        incomplete_details: null,
        completed_at: Math.floor(Date.now() / 1000),
        incomplete_at: null,
        role: msg.role || 'user',
        content: [{
          type: 'text',
          text: { value: content, annotations: [] }
        }],
        assistant_id: null,
        run_id: null,
        attachments: msg.attachments ?? [],
        metadata: msg.metadata ?? {}
      };
      state.addMessage(thread.id, message);
    }
  }

  // Create run
  const run: Run = {
    id: state.generateRunId(),
    object: 'thread.run',
    created_at: Math.floor(Date.now() / 1000),
    thread_id: thread.id,
    assistant_id: body.assistant_id,
    status: 'queued',
    required_action: null,
    last_error: null,
    expires_at: Math.floor(Date.now() / 1000) + 600,
    started_at: null,
    cancelled_at: null,
    failed_at: null,
    completed_at: null,
    incomplete_details: null,
    model: body.model ?? assistant.model,
    instructions: body.instructions ?? null,
    tools: body.tools ?? assistant.tools,
    metadata: body.metadata ?? {},
    usage: null
  };

  state.addRun(thread.id, run);

  // Check if streaming is requested
  if (body.stream) {
    // Streaming mode: use SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // Execute run with streaming
    (async () => {
      try {
        const generator = executeRun(thread.id, run.id, true);
        for await (const event of generator) {
          if (event.event === 'done') {
            res.write(`event: done\ndata: [DONE]\n\n`);
          } else {
            res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
          }
        }
      } catch (err) {
        console.error('Streaming run error:', err);
        res.write(`event: error\ndata: ${JSON.stringify({ error: { message: 'Stream error' } })}\n\n`);
      } finally {
        res.end();
      }
    })();
  } else {
    // Non-streaming mode: return immediately, execute async
    res.status(201).json(run);

    // Execute in background
    executeRunNonStreaming(thread.id, run.id).catch(err => {
      console.error('Run execution failed:', err);
    });
  }
});

// ==================== Submit Tool Outputs ====================

router.post('/v1/threads/:thread_id/runs/:run_id/submit_tool_outputs', async (req: Request, res: Response) => {
  const { thread_id, run_id } = req.params;
  const thread = state.getThread(thread_id);
  if (!thread) {
    return res.status(404).json(notFoundError('thread'));
  }

  const run = state.getRun(thread_id, run_id);
  if (!run) {
    return res.status(404).json(notFoundError('run'));
  }

  // Check if run is in requires_action status
  if (run.status !== 'requires_action') {
    return res.status(400).json(
      errorResponse(
        `Run is not in requires_action status. Current status: ${run.status}`,
        'invalid_request_error',
        'status'
      )
    );
  }

  const body = req.body as SubmitToolOutputsRequest;

  const validationError = validateRequired(body, ['tool_outputs']);
  if (validationError) {
    return res.status(400).json(errorResponse(validationError, 'invalid_request_error', 'tool_outputs'));
  }

  // Validate that all required tool calls are provided
  const requiredToolCallIds = new Set(
    run.required_action?.submit_tool_outputs.tool_calls.map(tc => tc.id) ?? []
  );
  const providedToolCallIds = new Set(body.tool_outputs.map(o => o.tool_call_id));

  for (const requiredId of requiredToolCallIds) {
    if (!providedToolCallIds.has(requiredId)) {
      return res.status(400).json(
        errorResponse(
          `Missing output for tool call: ${requiredId}`,
          'invalid_request_error',
          'tool_outputs'
        )
      );
    }
  }

  // Check if streaming is requested
  if (body.stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    (async () => {
      try {
        const generator = continueRunWithToolOutputs(thread_id, run_id, body.tool_outputs, true);
        for await (const event of generator) {
          if (event.event === 'done') {
            res.write(`event: done\ndata: [DONE]\n\n`);
          } else {
            res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
          }
        }
      } catch (err) {
        console.error('Streaming continue error:', err);
        res.write(`event: error\ndata: ${JSON.stringify({ error: { message: 'Stream error' } })}\n\n`);
      } finally {
        res.end();
      }
    })();
  } else {
    // Non-streaming mode: return the run immediately, execute async
    const updatedRun = state.updateRun(thread_id, run_id, {
      status: 'in_progress',
      required_action: null
    });
    res.json(updatedRun);

    // Continue execution in background
    continueRunWithToolOutputsNonStreaming(thread_id, run_id, body.tool_outputs).catch(err => {
      console.error('Continue run failed:', err);
    });
  }
});

// ==================== Run Steps ====================

// List run steps
router.get('/v1/threads/:thread_id/runs/:run_id/steps', (req: Request, res: Response) => {
  const { thread_id, run_id } = req.params;
  const thread = state.getThread(thread_id);
  if (!thread) {
    return res.status(404).json(notFoundError('thread'));
  }

  const run = state.getRun(thread_id, run_id);
  if (!run) {
    return res.status(404).json(notFoundError('run'));
  }

  const params = parsePaginationParams(req.query);
  const result = state.getRunSteps(run_id, params);
  res.json(result);
});

// Get run step
router.get('/v1/threads/:thread_id/runs/:run_id/steps/:step_id', (req: Request, res: Response) => {
  const { thread_id, run_id, step_id } = req.params;
  const thread = state.getThread(thread_id);
  if (!thread) {
    return res.status(404).json(notFoundError('thread'));
  }

  const run = state.getRun(thread_id, run_id);
  if (!run) {
    return res.status(404).json(notFoundError('run'));
  }

  const step = state.getRunStep(run_id, step_id);
  if (!step) {
    return res.status(404).json(notFoundError('run step'));
  }
  res.json(step);
});

export default router;
