import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSelectChatModels = vi.fn();
const mockComputeEmbeddings = vi.fn();
let mockEmbeddingModels: string[] = [];
let throwOnEmbeddingModelsAccess = false;

vi.mock('vscode', () => {
  class MockCancellationTokenSource {
    token = {};
    dispose() {}
  }

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
  };
});

vi.mock('../src/server', () => ({
  startServer: vi.fn(),
  setApiTokens: vi.fn(),
  addApiToken: vi.fn(),
  removeApiToken: vi.fn(),
}));

vi.mock('../src/assistants', () => ({
  state: {
    restore: vi.fn(),
    setPersistCallback: vi.fn(),
  },
}));

vi.mock('../src/skills', () => ({
  skillsState: {
    restore: vi.fn(),
    setPersistCallback: vi.fn(),
  },
  setSkillStorageDir: vi.fn(),
}));

vi.mock('../src/skills/storage', () => ({
  getSkillStorageDir: vi.fn(() => '/tmp/copilot-proxy-skills'),
}));

vi.mock('../src/toolConvert', () => ({
  toVSCodeTools: vi.fn(() => []),
  toToolMode: vi.fn(),
}));

describe('model listing helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEmbeddingModels = [];
    throwOnEmbeddingModelsAccess = false;
    mockSelectChatModels.mockResolvedValue([]);
    mockComputeEmbeddings.mockResolvedValue([]);
  });

  it('lists only chat models from getAvailableChatModels', async () => {
    mockSelectChatModels.mockResolvedValue([
      { vendor: 'copilot', family: 'gpt-4o', id: 'gpt-4o' },
      { vendor: 'copilot', family: 'gpt-5-mini', id: 'gpt-5-mini' },
    ]);
    mockEmbeddingModels = ['text-embedding-3-small'];

    const extension = await import('../src/extension');
    const models = await extension.getAvailableChatModels();

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
    mockEmbeddingModels = ['text-embedding-3-small'];

    const extension = await import('../src/extension');
    const models = await extension.getAvailableModels();

    expect(models).toEqual([
      { vendor: 'copilot', family: 'gpt-4o', id: 'gpt-4o' },
      { vendor: 'copilot', family: 'gpt-5-mini', id: 'gpt-5-mini' },
      { vendor: 'copilot', family: 'text-embedding-3-small' },
    ]);
  });

  it('exposes embedding models separately', async () => {
    mockEmbeddingModels = ['text-embedding-3-small', 'text-embedding-3-large'];

    const extension = await import('../src/extension');

    expect(extension.getAvailableEmbeddingModels()).toEqual([
      'text-embedding-3-small',
      'text-embedding-3-large',
    ]);
  });

  it('falls back to chat models when embedding enumeration is unavailable', async () => {
    mockSelectChatModels.mockResolvedValue([
      { vendor: 'copilot', family: 'gpt-4o', id: 'gpt-4o' },
    ]);
    throwOnEmbeddingModelsAccess = true;

    const extension = await import('../src/extension');
    const models = await extension.getAvailableModels();

    expect(models).toEqual([
      { vendor: 'copilot', family: 'gpt-4o', id: 'gpt-4o' },
    ]);
    expect(extension.getAvailableEmbeddingModels()).toEqual([]);
  });

  it('surfaces an actionable error when proposed embeddings API is unavailable', async () => {
    throwOnEmbeddingModelsAccess = true;

    const extension = await import('../src/extension');

    await expect(
      extension.processEmbeddingRequest({
        model: 'text-embedding-3-small',
        input: 'hello world',
      })
    ).rejects.toThrow(/embeddings.*enabledApiProposals/);
  });

  it('uses embedding models for embedding requests', async () => {
    mockEmbeddingModels = ['text-embedding-3-small', 'text-embedding-3-large'];
    mockComputeEmbeddings.mockResolvedValue([{ values: [0.1, 0.2, 0.3] }]);

    const extension = await import('../src/extension');
    const response = await extension.processEmbeddingRequest({
      model: 'text-embedding-3-large',
      input: 'hello world',
    });

    expect(mockComputeEmbeddings).toHaveBeenCalledWith('text-embedding-3-large', ['hello world']);
    expect(response.model).toBe('text-embedding-3-large');
    expect(response.data).toEqual([
      {
        object: 'embedding',
        embedding: [0.1, 0.2, 0.3],
        index: 0,
      },
    ]);
  });
});