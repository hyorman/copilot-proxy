/**
 * Shared Utilities
 *
 * Common helpers used across the server, routes, and runner modules.
 */

import type { NextFunction, Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { OpenAIErrorResponse } from './types.js';
import { Message, MessageAttachment } from './assistants/types.js';

// ==================== ID Generation ====================

const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const ID_LENGTH = 24;

export function generateId(prefix: string): string {
  let id = '';
  for (let i = 0; i < ID_LENGTH; i++) {
    id += ID_CHARS.charAt(Math.floor(Math.random() * ID_CHARS.length));
  }
  return `${prefix}_${id}`;
}

// ==================== Error Response ====================

export function errorResponse(
  message: string,
  type = 'invalid_request_error',
  param: string | null = null,
  code: string | null = null
): OpenAIErrorResponse {
  return {
    error: { message, type, param, code }
  };
}

export function notFoundError(resource: string): OpenAIErrorResponse {
  return errorResponse(`No ${resource} found`, 'invalid_request_error', null, 'resource_not_found');
}

// ==================== Message Factory ====================

export interface CreateMessageOptions {
  threadId: string;
  messageId: string;
  content: string;
  role?: 'user' | 'assistant';
  assistantId?: string | null;
  runId?: string | null;
  attachments?: MessageAttachment[];
  metadata?: Record<string, string>;
  status?: 'completed' | 'in_progress' | 'incomplete';
}

export function createMessage(opts: CreateMessageOptions): Message {
  const now = Math.floor(Date.now() / 1000);
  const isCompleted = (opts.status ?? 'completed') === 'completed';
  return {
    id: opts.messageId,
    object: 'thread.message',
    created_at: now,
    thread_id: opts.threadId,
    status: opts.status ?? 'completed',
    incomplete_details: null,
    completed_at: isCompleted ? now : null,
    incomplete_at: null,
    role: opts.role ?? 'user',
    content: [{
      type: 'text',
      text: { value: opts.content, annotations: [] }
    }],
    assistant_id: opts.assistantId ?? null,
    run_id: opts.runId ?? null,
    attachments: opts.attachments ?? [],
    metadata: opts.metadata ?? {}
  };
}

// ==================== Auth Middleware ====================

export function generateApiToken(): string {
  return 'cpx_' + randomBytes(32).toString('hex');
}

let validTokens: Set<string> = new Set();

export function setApiTokens(tokens: string[]) {
  validTokens = new Set(tokens);
}

export function addApiToken(token: string) {
  validTokens.add(token);
}

export function removeApiToken(token: string) {
  validTokens.delete(token);
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (validTokens.size === 0) {
    return next();
  }

  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json(
      errorResponse(
        'Missing authorization header. Include "Authorization: Bearer <token>" header.',
        'authentication_error',
        'authorization',
        'missing_authorization'
      )
    );
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json(
      errorResponse(
        'Invalid authorization header format. Use "Authorization: Bearer <token>".',
        'authentication_error',
        'authorization',
        'invalid_authorization_format'
      )
    );
  }

  const token = parts[1];
  if (!validTokens.has(token)) {
    return res.status(401).json(
      errorResponse(
        'Invalid API token.',
        'authentication_error',
        'authorization',
        'invalid_token'
      )
    );
  }

  next();
}
