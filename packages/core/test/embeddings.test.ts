import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server.js';
import type { ChatBackend } from '../src/backend.js';
import type { EmbeddingRequest, EmbeddingResponse } from '../src/types.js';

// Minimal mock backend that supports embeddings
function createMockBackend(): ChatBackend {
  return {
    async processChatRequest() {
      throw new Error('not implemented');
    },
    getAvailableModels() {
      return [{ vendor: 'test', family: 'test-model' }];
    },
    async processEmbeddingRequest(request: EmbeddingRequest): Promise<EmbeddingResponse> {
      const inputs = Array.isArray(request.input) ? request.input : [request.input];
      return {
        object: 'list',
        data: inputs.map((_, i) => ({ object: 'embedding', embedding: [0.1, 0.2], index: i })),
        model: request.model,
        usage: { prompt_tokens: 10, total_tokens: 10 },
      };
    },
  };
}

const silentLogger = { log() {}, error() {} };

async function post(baseUrl: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('/v1/embeddings input validation', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = createApp(createMockBackend(), silentLogger);
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  // --- Cases that should be rejected (400) ---

  it('rejects empty string input', async () => {
    const res = await post(baseUrl, { input: '', model: 'test' });
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe('invalid_request_error');
  });

  it('accepts whitespace-only string input (matches OpenAI behavior)', async () => {
    const res = await post(baseUrl, { input: '   ', model: 'test' });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('rejects empty array input', async () => {
    const res = await post(baseUrl, { input: [], model: 'test' });
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe('invalid_request_error');
  });

  it('rejects array of all empty strings', async () => {
    const res = await post(baseUrl, { input: ['', ''], model: 'test' });
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe('invalid_request_error');
  });

  it('accepts array with whitespace strings (filters only empty)', async () => {
    const res = await post(baseUrl, { input: ['', ' ', 'hello'], model: 'test' });
    expect(res.status).toBe(200);
    // " " and "hello" survive, only "" is filtered
    expect(res.body.data).toHaveLength(2);
  });

  it('rejects missing input field', async () => {
    const res = await post(baseUrl, { model: 'test' });
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe('invalid_request_error');
  });

  // --- Cases that should succeed (200) with filtering ---

  it('accepts a valid string', async () => {
    const res = await post(baseUrl, { input: 'hello world', model: 'test' });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('accepts a valid array', async () => {
    const res = await post(baseUrl, { input: ['hello', 'world'], model: 'test' });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
  });

  it('filters empty strings from a mixed array', async () => {
    const res = await post(baseUrl, { input: ['', 'hello', '', 'world'], model: 'test' });
    expect(res.status).toBe(200);
    // Only "hello" and "world" survive filtering
    expect(res.body.data).toHaveLength(2);
  });

  // --- Shape preservation ---

  it('preserves string type when input was a single string', async () => {
    const captured: EmbeddingRequest[] = [];
    const app = createApp({
      ...createMockBackend(),
      async processEmbeddingRequest(req: EmbeddingRequest) {
        captured.push(req);
        return createMockBackend().processEmbeddingRequest!(req);
      },
    }, silentLogger);
    const srv = http.createServer(app);
    await new Promise<void>(resolve => srv.listen(0, resolve));
    const port = (srv.address() as AddressInfo).port;

    await post(`http://127.0.0.1:${port}`, { input: 'hello', model: 'test' });
    expect(typeof captured[0].input).toBe('string');

    await new Promise<void>(resolve => srv.close(() => resolve()));
  });

  it('preserves array type when input was an array', async () => {
    const captured: EmbeddingRequest[] = [];
    const app = createApp({
      ...createMockBackend(),
      async processEmbeddingRequest(req: EmbeddingRequest) {
        captured.push(req);
        return createMockBackend().processEmbeddingRequest!(req);
      },
    }, silentLogger);
    const srv = http.createServer(app);
    await new Promise<void>(resolve => srv.listen(0, resolve));
    const port = (srv.address() as AddressInfo).port;

    await post(`http://127.0.0.1:${port}`, { input: ['hello'], model: 'test' });
    expect(Array.isArray(captured[0].input)).toBe(true);

    await new Promise<void>(resolve => srv.close(() => resolve()));
  });
});
