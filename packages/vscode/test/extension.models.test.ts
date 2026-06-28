import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSelectChatModels = vi.fn();
const mockComputeEmbeddings = vi.fn();
const mockSendRequest = vi.fn();
let mockEmbeddingModels: string[] = [];
let throwOnEmbeddingModelsAccess = false;

vi.mock('vscode', () => {
  class MockCancellationTokenSource {
    token = {};
    dispose() {}
  }

  class MockLanguageModelTextPart {
    constructor(public value: string) {}
  }

  class MockLanguageModelToolCallPart {
    constructor(
      public callId: string,
      public name: string,
      public input: unknown,
    ) {}
  }

  class MockLanguageModelToolResultPart {
    constructor(
      public callId: string,
      public parts: unknown[],
    ) {}
  }

  const MockLanguageModelChatMessage = {
    User: (content: unknown) => ({ role: 'user', content }),
    Assistant: (content: unknown) => ({ role: 'assistant', content }),
  };

  return {
    lm: {
      selectChatModels: mockSelectChatModels,
      get embeddingModels() {
        if (throwOnEmbeddingModelsAccess) {
          throw new Error('embedding models unavailable');
        }
        return mockEmbeddingModels;
      },
      computeEmbeddings: mockComputeEmbeddings,
    },
    window: {
      createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), show: vi.fn() })),
      showInformationMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      showInputBox: vi.fn(),
      showQuickPick: vi.fn(),
      showWarningMessage: vi.fn(),
    },
    workspace: {
      getConfiguration: vi.fn(() => ({
        get: vi.fn(),
        update: vi.fn(),
      })),
    },
    commands: {
      registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
    },
    env: {
      clipboard: {
        writeText: vi.fn(),
      },
    },
    ConfigurationTarget: {
      Global: 1,
    },
    CancellationTokenSource: MockCancellationTokenSource,
    LanguageModelTextPart: MockLanguageModelTextPart,
    LanguageModelToolCallPart: MockLanguageModelToolCallPart,
    LanguageModelToolResultPart: MockLanguageModelToolResultPart,
    LanguageModelChatMessage: MockLanguageModelChatMessage,
    LanguageModelChatToolMode: {
      Auto: 'Auto',
      Required: 'Required',
    },
  };
});

vi.mock('@hyorman/copilot-proxy-core', () => ({
  createApp: vi.fn(),
  setApiTokens: vi.fn(),
  addApiToken: vi.fn(),
  removeApiToken: vi.fn(),
  state: {
    restore: vi.fn(),
    setPersistCallback: vi.fn(),
  },
  skillsState: {
    restore: vi.fn(),
    setPersistCallback: vi.fn(),
  },
  setSkillStorageDir: vi.fn(),
}));

vi.mock('../src/toolConvert', () => ({
  toVSCodeTools: vi.fn(() => []),
  assistantToolsToVSCode: vi.fn(() => []),
  toToolMode: vi.fn(),
}));

describe('model listing helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEmbeddingModels = [];
    mockSendRequest.mockReset();
    throwOnEmbeddingModelsAccess = false;
    mockSelectChatModels.mockResolvedValue([]);
    mockComputeEmbeddings.mockResolvedValue([]);
  });

  it('lists only chat models from getAvailableChatModels', async () => {
    mockSelectChatModels.mockResolvedValue([
      { vendor: 'copilot', family: 'gpt-4o', id: 'gpt-4o' },
      { vendor: 'copilot', family: 'gpt-5-mini', id: 'gpt-5-mini' },
    ]);
    mockEmbeddingModels = ['copilot.text-embedding-3-small'];

    const { VSCodeBackend } = await import('../src/vscodeBackend');
    const backend = new VSCodeBackend({ log: vi.fn() });
    const models = await backend.getAvailableChatModels();

    expect(models).toEqual([
      { vendor: 'copilot', family: 'gpt-4o', id: 'gpt-4o' },
      { vendor: 'copilot', family: 'gpt-5-mini', id: 'gpt-5-mini' },
    ]);
  });

  it('lists chat and embedding models from getAvailableModels', async () => {
    mockSelectChatModels.mockResolvedValue([
      { vendor: 'copilot', family: 'gpt-4o', id: 'gpt-4o' },
      { vendor: 'copilot', family: 'gpt-5-mini', id: 'gpt-5-mini' },
    ]);
    mockEmbeddingModels = ['copilot.text-embedding-3-small'];

    const { VSCodeBackend } = await import('../src/vscodeBackend');
    const backend = new VSCodeBackend({ log: vi.fn() });
    const models = await backend.getAvailableModels();

    expect(models).toEqual([
      { vendor: 'copilot', family: 'gpt-4o', id: 'gpt-4o' },
      { vendor: 'copilot', family: 'gpt-5-mini', id: 'gpt-5-mini' },
      { vendor: 'copilot', family: 'text-embedding-3-small' },
    ]);
  });

  it('exposes embedding models separately', async () => {
    mockEmbeddingModels = ['copilot.text-embedding-3-small', 'copilot.text-embedding-3-large'];

    const { VSCodeBackend } = await import('../src/vscodeBackend');
    const backend = new VSCodeBackend({ log: vi.fn() });

    expect(backend.getAvailableEmbeddingModels()).toEqual([
      'copilot.text-embedding-3-small',
      'copilot.text-embedding-3-large',
    ]);
  });

  it('falls back to chat models when embedding enumeration is unavailable', async () => {
    mockSelectChatModels.mockResolvedValue([
      { vendor: 'copilot', family: 'gpt-4o', id: 'gpt-4o' },
    ]);
    throwOnEmbeddingModelsAccess = true;

    const { VSCodeBackend } = await import('../src/vscodeBackend');
    const backend = new VSCodeBackend({ log: vi.fn() });
    const models = await backend.getAvailableModels();

    expect(models).toEqual([
      { vendor: 'copilot', family: 'gpt-4o', id: 'gpt-4o' },
    ]);
    expect(backend.getAvailableEmbeddingModels()).toEqual([]);
  });

  it('surfaces an actionable error when proposed embeddings API is unavailable', async () => {
    throwOnEmbeddingModelsAccess = true;

    const { VSCodeBackend } = await import('../src/vscodeBackend');
    const backend = new VSCodeBackend({ log: vi.fn() });

    await expect(
      backend.processEmbeddingRequest({
        model: 'text-embedding-3-small',
        input: 'hello world',
      })
    ).rejects.toThrow(/embeddings.*enabledApiProposals/);
  });

  it('uses embedding models for embedding requests', async () => {
    mockEmbeddingModels = ['copilot.text-embedding-3-small', 'copilot.text-embedding-3-large'];
    mockComputeEmbeddings.mockResolvedValue([{ values: [0.1, 0.2, 0.3] }]);

    const { VSCodeBackend } = await import('../src/vscodeBackend');
    const backend = new VSCodeBackend({ log: vi.fn() });
    const response = await backend.processEmbeddingRequest({
      model: 'text-embedding-3-large',
      input: 'hello world',
    });

    expect(mockComputeEmbeddings).toHaveBeenCalledWith('copilot.text-embedding-3-large', ['hello world']);
    expect(response.model).toBe('text-embedding-3-large');
    expect(response.data).toEqual([
      {
        object: 'embedding',
        embedding: [0.1, 0.2, 0.3],
        index: 0,
      },
    ]);
  });

  it('streams a stop chunk with an empty delta object', async () => {
    const vscode = await import('vscode');
    mockSendRequest.mockResolvedValue({
      stream: (async function* () {
        yield new vscode.LanguageModelTextPart('Hello from VS Code');
      })(),
    });
    mockSelectChatModels.mockResolvedValue([
      { vendor: 'copilot', family: 'gpt-4o', id: 'gpt-4o', sendRequest: mockSendRequest },
    ]);

    const { VSCodeBackend } = await import('../src/vscodeBackend');
    const backend = new VSCodeBackend({ log: vi.fn() });
    const result = await backend.processChatRequest({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });

    const chunks: any[] = [];
    for await (const chunk of result as AsyncIterable<any>) {
      chunks.push(chunk);
    }

    expect(chunks[0].choices[0].delta.content).toBe('Hello from VS Code');
    expect(chunks[0].choices[0].delta.role).toBe('assistant');
    expect(chunks[1].choices[0].delta).toEqual({});
    expect(chunks[1].choices[0].finish_reason).toBe('stop');
  });

  it('still emits a valid stop chunk when no text parts are streamed', async () => {
    mockSendRequest.mockResolvedValue({
      stream: (async function* () {
        return;
      })(),
    });
    mockSelectChatModels.mockResolvedValue([
      { vendor: 'copilot', family: 'gpt-4o', id: 'gpt-4o', sendRequest: mockSendRequest },
    ]);

    const { VSCodeBackend } = await import('../src/vscodeBackend');
    const backend = new VSCodeBackend({ log: vi.fn() });
    const result = await backend.processChatRequest({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });

    const chunks: any[] = [];
    for await (const chunk of result as AsyncIterable<any>) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0].choices[0].delta).toEqual({});
    expect(chunks[0].choices[0].finish_reason).toBe('stop');
  });
});
