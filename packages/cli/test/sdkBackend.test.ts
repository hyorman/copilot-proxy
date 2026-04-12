import { describe, it, expect, beforeEach, vi } from 'vitest';

// --------------- Module mocks ---------------

vi.mock('@github/copilot-sdk', () => {
  const CopilotClient = vi.fn().mockImplementation(function (this: any, opts: any) {
    this._opts = opts;
    this.start = vi.fn().mockResolvedValue(undefined);
    this.stop = vi.fn().mockResolvedValue(undefined);
    this.createSession = vi.fn();
    this.listModels = vi.fn().mockResolvedValue([
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
    ]);
  });
  return { CopilotClient, approveAll: vi.fn() };
});

vi.mock('@hyorman/copilot-proxy-core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hyorman/copilot-proxy-core')>();
  let counter = 0;
  return {
    ...original,
    generateId: vi.fn((prefix: string) => `${prefix}_${++counter}`),
  };
});

import { SdkBackend, type SdkOptions } from '../src/sdkBackend.js';
import { CopilotClient } from '@github/copilot-sdk';
import { generateId } from '@hyorman/copilot-proxy-core';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from '@hyorman/copilot-proxy-core';

// --------------- Mock session factory ---------------

function createMockSession(options: { responseContent?: string; messages?: any[] } = {}) {
  const handlers: Record<string, Function[]> = {};
  const responseContent = options.responseContent ?? 'Hello!';
  const messages = options.messages ?? [
    { type: 'assistant.message', data: { content: responseContent } },
  ];

  const session = {
    on: vi.fn((event: string, handler: Function) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
      return vi.fn(); // unsubscribe
    }),
    send: vi.fn((_payload: any) => {
      setTimeout(() => {
        const deltaHandlers = handlers['assistant.message_delta'] ?? [];
        for (const h of deltaHandlers) {
          h({ data: { deltaContent: responseContent } });
        }
        const idleHandlers = handlers['session.idle'] ?? [];
        for (const h of idleHandlers) {
          h();
        }
      }, 0);
      return Promise.resolve();
    }),
    sendAndWait: vi.fn().mockResolvedValue({ data: { content: responseContent } }),
    getMessages: vi.fn().mockResolvedValue(messages),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };

  return session;
}

// --------------- Helpers ---------------

const logger = { log: vi.fn(), error: vi.fn() };

function makeRequest(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Hi' }],
    stream: false,
    ...overrides,
  } as ChatCompletionRequest;
}

// --------------- Tests ---------------

describe('SdkBackend', () => {
  let backend: SdkBackend;

  beforeEach(() => {
    vi.clearAllMocks();
    backend = new SdkBackend(logger as any);
  });

  // ==================== parseToolCalls ====================

  describe('parseToolCalls', () => {
    const parse = (content: string) => (backend as any)['parseToolCalls'](content);

    it('parses valid tool_calls JSON', () => {
      const input = JSON.stringify({
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'search', arguments: '{"q":"test"}' },
        }],
      });

      const result = parse(input);
      expect(result.text).toBe('');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]).toEqual({
        id: 'call_1',
        type: 'function',
        function: { name: 'search', arguments: '{"q":"test"}' },
      });
    });

    it('extracts tool calls embedded after text', () => {
      const toolJson = JSON.stringify({
        tool_calls: [{
          id: 'call_2',
          type: 'function',
          function: { name: 'lookup', arguments: '{}' },
        }],
      });
      const input = `Here is my response\n${toolJson}`;

      const result = parse(input);
      expect(result.text).toBe('Here is my response');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].function.name).toBe('lookup');
    });

    it('returns plain text as-is when no tool calls present', () => {
      const result = parse('Just a normal message');
      expect(result.text).toBe('Just a normal message');
      expect(result.toolCalls).toEqual([]);
    });

    it('stringifies object arguments', () => {
      const input = JSON.stringify({
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'search', arguments: { q: 'test' } },
        }],
      });

      const result = parse(input);
      expect(result.toolCalls[0].function.arguments).toBe('{"q":"test"}');
    });

    it('auto-generates id when missing', () => {
      const input = JSON.stringify({
        tool_calls: [{
          type: 'function',
          function: { name: 'search', arguments: '{}' },
        }],
      });

      const result = parse(input);
      expect(result.toolCalls[0].id).toMatch(/^call/);
      expect(generateId).toHaveBeenCalled();
    });
  });

  // ==================== buildPrompt ====================

  describe('buildPrompt', () => {
    const build = (req: ChatCompletionRequest) => (backend as any)['buildPrompt'](req);

    it('puts system messages into systemMessage', () => {
      const result = build(makeRequest({
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hi' },
        ],
      }));

      expect(result.systemMessage).toContain('You are helpful.');
      expect(result.prompt).toContain('[user]\nHi');
    });

    it('formats user and assistant messages in prompt', () => {
      const result = build(makeRequest({
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there' },
        ],
      }));

      expect(result.prompt).toContain('[user]\nHello');
      expect(result.prompt).toContain('[assistant]\nHi there');
    });

    it('formats tool result messages as XML blocks', () => {
      const result = build(makeRequest({
        messages: [
          { role: 'tool', content: 'result data', tool_call_id: 'call_42' },
        ],
      }));

      expect(result.prompt).toContain('<tool_result tool_call_id="call_42">');
      expect(result.prompt).toContain('result data');
      expect(result.prompt).toContain('</tool_result>');
    });

    it('formats assistant messages with tool_calls as XML blocks', () => {
      const result = build(makeRequest({
        messages: [{
          role: 'assistant',
          content: 'I will search',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"x"}' },
          }],
        }],
      }));

      expect(result.prompt).toContain('[assistant]');
      expect(result.prompt).toContain('I will search');
      expect(result.prompt).toContain('<tool_call id="call_1" name="search">');
      expect(result.prompt).toContain('{"q":"x"}');
    });

    it('joins structured content array with newline', () => {
      const result = build(makeRequest({
        messages: [
          { role: 'user', content: [{ text: 'hello' }, { text: 'world' }] },
        ],
      }));

      expect(result.prompt).toContain('hello\nworld');
    });

    it('treats null/undefined content as empty string', () => {
      const result = build(makeRequest({
        messages: [
          { role: 'user', content: null },
          { role: 'user', content: undefined },
        ],
      }));

      expect(result.prompt).toContain('[user]\n');
    });

    it('appends tool descriptions to systemMessage when tools present', () => {
      const result = build(makeRequest({
        messages: [{ role: 'user', content: 'run tool' }],
        tools: [{
          type: 'function',
          function: {
            name: 'calculator',
            description: 'Does math',
            parameters: { type: 'object' },
          },
        }],
      }));

      expect(result.systemMessage).toContain('calculator');
      expect(result.systemMessage).toContain('Does math');
      expect(result.systemMessage).toContain('Available tools');
    });
  });

  // ==================== Lifecycle ====================

  describe('lifecycle', () => {
    it('init() creates CopilotClient and calls start()', async () => {
      await backend.init({ githubToken: 'tok_123' });

      expect(CopilotClient).toHaveBeenCalledWith(
        expect.objectContaining({ githubToken: 'tok_123', autoStart: true }),
      );
      const instance = (CopilotClient as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
      expect(instance.start).toHaveBeenCalled();
      expect(logger.log).toHaveBeenCalledWith('CopilotClient started');
    });

    it('stop() calls client.stop() and nulls client', async () => {
      await backend.init();
      const instance = (CopilotClient as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

      await backend.stop();
      expect(instance.stop).toHaveBeenCalled();
      expect(logger.log).toHaveBeenCalledWith('CopilotClient stopped');
    });

    it('stop() on uninitialized client is a no-op', async () => {
      await expect(backend.stop()).resolves.toBeUndefined();
    });

    it('processChatRequest before init() throws not initialized', async () => {
      await expect(backend.processChatRequest(makeRequest())).rejects.toThrow(
        'CopilotClient not initialized. Call init() first.',
      );
    });
  });

  // ==================== processNonStreaming ====================

  describe('processNonStreaming', () => {
    beforeEach(async () => {
      await backend.init();
    });

    function setupSession(responseContent: string) {
      const session = createMockSession({ responseContent });
      const instance = (CopilotClient as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
      instance.createSession.mockResolvedValue(session);
      return session;
    }

    it('returns correctly shaped ChatCompletionResponse', async () => {
      setupSession('Hello!');
      const result = await backend.processChatRequest(makeRequest()) as ChatCompletionResponse;

      expect(result.object).toBe('chat.completion');
      expect(result.model).toBe('gpt-4o');
      expect(result.choices).toHaveLength(1);
      expect(result.choices[0].message.role).toBe('assistant');
      expect(result.choices[0].message.content).toBe('Hello!');
      expect(result.usage).toBeDefined();
    });

    it('parses tool calls when tools present in request', async () => {
      const toolCallJson = JSON.stringify({
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'search', arguments: '{"q":"test"}' },
        }],
      });
      setupSession(toolCallJson);

      const result = await backend.processChatRequest(makeRequest({
        tools: [{ type: 'function', function: { name: 'search', description: 'Search', parameters: {} } }],
      })) as ChatCompletionResponse;

      expect(result.choices[0].finish_reason).toBe('tool_calls');
      expect(result.choices[0].message.tool_calls).toHaveLength(1);
      expect(result.choices[0].message.tool_calls![0].function.name).toBe('search');
    });

    it('returns stop when no tool calls in response', async () => {
      setupSession('Just text, no tools.');
      const result = await backend.processChatRequest(makeRequest({
        tools: [{ type: 'function', function: { name: 'search', description: 'Search', parameters: {} } }],
      })) as ChatCompletionResponse;

      expect(result.choices[0].finish_reason).toBe('stop');
    });

    it('returns null content for empty response', async () => {
      setupSession('');
      const result = await backend.processChatRequest(makeRequest()) as ChatCompletionResponse;

      expect(result.choices[0].message.content).toBeNull();
      expect(result.choices[0].finish_reason).toBe('stop');
    });

    it('skips tool parsing when request has no tools', async () => {
      const toolCallJson = JSON.stringify({
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{}' } }],
      });
      setupSession(toolCallJson);

      const result = await backend.processChatRequest(makeRequest()) as ChatCompletionResponse;

      // Content is the raw JSON since no tools were in the request
      expect(result.choices[0].finish_reason).toBe('stop');
      expect(result.choices[0].message.content).toBe(toolCallJson);
    });

    it('calls session.disconnect() after processing', async () => {
      const session = setupSession('done');
      await backend.processChatRequest(makeRequest());
      expect(session.disconnect).toHaveBeenCalled();
    });
  });

  // ==================== processStreaming ====================

  describe('processStreaming', () => {
    beforeEach(async () => {
      await backend.init();
    });

    function setupSession(responseContent: string, messages?: any[]) {
      const session = createMockSession({
        responseContent,
        messages: messages ?? [
          { type: 'assistant.message', data: { content: responseContent } },
        ],
      });
      const instance = (CopilotClient as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
      instance.createSession.mockResolvedValue(session);
      return session;
    }

    async function collectChunks(iterable: AsyncIterable<ChatCompletionChunk>): Promise<ChatCompletionChunk[]> {
      const chunks: ChatCompletionChunk[] = [];
      for await (const chunk of iterable) {
        chunks.push(chunk);
      }
      return chunks;
    }

    it('yields chunks with correct shape', async () => {
      setupSession('Hello streaming');
      const result = await backend.processChatRequest(makeRequest({ stream: true }));
      const chunks = await collectChunks(result as AsyncIterable<ChatCompletionChunk>);

      expect(chunks.length).toBeGreaterThanOrEqual(2); // at least content + final
      for (const chunk of chunks) {
        expect(chunk.object).toBe('chat.completion.chunk');
        expect(chunk.model).toBe('gpt-4o');
        expect(chunk.choices).toHaveLength(1);
      }
    });

    it('first chunk includes role: assistant in delta', async () => {
      setupSession('Hi');
      const result = await backend.processChatRequest(makeRequest({ stream: true }));
      const chunks = await collectChunks(result as AsyncIterable<ChatCompletionChunk>);

      expect(chunks[0].choices[0].delta.role).toBe('assistant');
    });

    it('subsequent chunks omit role', async () => {
      setupSession('Hi there');
      const result = await backend.processChatRequest(makeRequest({ stream: true }));
      const chunks = await collectChunks(result as AsyncIterable<ChatCompletionChunk>);

      // The final (stop) chunk should not have a role
      const lastChunk = chunks[chunks.length - 1];
      expect(lastChunk.choices[0].delta.role).toBeUndefined();
    });

    it('final chunk has finish_reason stop', async () => {
      setupSession('Hello');
      const result = await backend.processChatRequest(makeRequest({ stream: true }));
      const chunks = await collectChunks(result as AsyncIterable<ChatCompletionChunk>);

      const lastChunk = chunks[chunks.length - 1];
      expect(lastChunk.choices[0].finish_reason).toBe('stop');
    });

    it('calls session.disconnect() after iteration', async () => {
      const session = setupSession('bye');
      const result = await backend.processChatRequest(makeRequest({ stream: true }));
      await collectChunks(result as AsyncIterable<ChatCompletionChunk>);

      expect(session.disconnect).toHaveBeenCalled();
    });
  });

  // ==================== getAvailableModels ====================

  describe('getAvailableModels', () => {
    it('returns models from SDK listModels with inferred vendors', async () => {
      await backend.init();
      const models = await backend.getAvailableModels();
      expect(models).toEqual([
        { vendor: 'openai', family: 'gpt-4o', id: 'gpt-4o' },
        { vendor: 'anthropic', family: 'claude-sonnet-4', id: 'claude-sonnet-4' },
      ]);
    });

    it('infers vendor from model id prefix', async () => {
      await backend.init();
      const instance = (CopilotClient as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
      instance.listModels.mockResolvedValueOnce([
        { id: 'gpt-5', name: 'GPT-5' },
        { id: 'claude-opus-4', name: 'Claude Opus 4' },
        { id: 'o4-mini', name: 'O4 Mini' },
        { id: 'gemini-2', name: 'Gemini 2' },
        { id: 'unknown-model', name: 'Unknown' },
      ]);
      const models = await backend.getAvailableModels();
      expect(models.map(m => m.vendor)).toEqual([
        'openai', 'anthropic', 'openai', 'google', 'copilot',
      ]);
    });
  });
});
