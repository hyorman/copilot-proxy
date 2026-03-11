import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { startServer, setApiTokens, addApiToken as addServerToken, removeApiToken as removeServerToken } from './server';
import {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  StructuredMessageContent,
  ToolCall,
  ToolCallChunk
} from './types';
import { state, SerializedState } from './assistants';
import { skillsState, SerializedSkillsState, setSkillStorageDir } from './skills';
import { getSkillStorageDir } from './skills/storage';
import { toVSCodeTools, toToolMode } from './toolConvert';

let outputChannel: vscode.OutputChannel;

export function getOutputChannel(): vscode.OutputChannel {
  return outputChannel;
}

let serverInstance: ReturnType<typeof startServer> | undefined;

// Model info interface for getAvailableModels
interface ModelInfo {
  vendor: string;
  family: string;
  id?: string;
}

// Extended LanguageModelChat for optional id access
type LanguageModelChatWithId = vscode.LanguageModelChat & { id?: string };

// Token interface
interface TokenInfo {
  token: string;
  name: string;
  createdAt: number;
}

// State persistence keys
const STATE_KEY = 'copilotProxy.assistantsState';
const SKILLS_STATE_KEY = 'copilotProxy.skillsState';
const TOKENS_KEY = 'copilotProxy.apiTokens';

/**
 * Generate a secure random API token
 */
function generateToken(): string {
  return 'cpx_' + crypto.randomBytes(32).toString('hex');
}

/**
 * Get stored API tokens
 */
function getStoredTokens(context: vscode.ExtensionContext): TokenInfo[] {
  return context.globalState.get<TokenInfo[]>(TOKENS_KEY, []);
}

/**
 * Save API tokens to storage
 */
function saveTokens(context: vscode.ExtensionContext, tokens: TokenInfo[]) {
  context.globalState.update(TOKENS_KEY, tokens);
  // Update server with current tokens
  setApiTokens(tokens.map(t => t.token));
}

function configurePort() {
  const config = vscode.workspace.getConfiguration("copilotProxy");
  const currentPort = config.get<number>("port", 3000);
  vscode.window.showInputBox({
    prompt: "Enter the port for the Express server:",
    placeHolder: "e.g., 3000",
    value: String(currentPort),
    validateInput: (value: string): string | undefined => {
      const port = Number(value);
      if (isNaN(port) || port <= 0) {
        return "Please enter a valid positive integer for the port.";
      }
      return undefined;
    }
  }).then(newPortStr => {
    if (newPortStr !== undefined) {
      const newPort = Number(newPortStr);
      config.update("port", newPort, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Port updated to ${newPort}. Restart the server if it's running.`);
    }
  });
}

/**
 * Get available chat models from VS Code Language Model API.
 */
export async function getAvailableChatModels(): Promise<ModelInfo[]> {
  const chatModels = await vscode.lm.selectChatModels({});
  return (chatModels || []).map(m => {
    const model = m as LanguageModelChatWithId;
    return {
      vendor: model.vendor,
      family: model.family,
      id: model.id
    } as ModelInfo;
  });
}

/**
 * Get all available models from the VS Code LM APIs.
 * This mirrors OpenAI-style /v1/models behavior by returning both chat and
 * embedding models in one list, while dedicated helpers remain available for
 * clients that want a narrower view.
 */
export async function getAvailableModels(): Promise<ModelInfo[]> {
  const chatInfos = await getAvailableChatModels();
  const embedInfos: ModelInfo[] = getAvailableEmbeddingModels().map(name => ({
    vendor: 'copilot',
    family: name,
  }));

  const merged: ModelInfo[] = [...chatInfos];
  for (const embeddingModel of embedInfos) {
    if (!merged.find(model => model.family === embeddingModel.family)) {
      merged.push(embeddingModel);
    }
  }

  return merged;
}

/**
 * Get available embedding models from the proposed VS Code Embeddings API.
 */
export function getAvailableEmbeddingModels(): string[] {
  try {
    return vscode.lm.embeddingModels ?? [];
  } catch (error) {
    outputChannel?.appendLine(`Embedding model enumeration unavailable: ${String(error)}`);
    return [];
  }
}


export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('Copilot Proxy Log');
  outputChannel.show();
  context.subscriptions.push(outputChannel);
  outputChannel.appendLine('Extension "Copilot Proxy" is now active!');

  // ==================== State Persistence ====================

  // Restore state from globalState
  const savedState = context.globalState.get<SerializedState>(STATE_KEY);
  if (savedState) {
    try {
      state.restore(savedState);
      outputChannel.appendLine('Restored assistants state from previous session.');
    } catch (err) {
      outputChannel.appendLine(`Error restoring state: ${err}`);
    }
  }

  // Set up persistence callback with debounce
  state.setPersistCallback(async (data) => {
    try {
      await context.globalState.update(STATE_KEY, data);
      outputChannel.appendLine('Assistants state saved.');
    } catch (err) {
      outputChannel.appendLine(`Error saving state: ${err}`);
    }
  }, 1000); // 1 second debounce

  // ==================== Skills State Persistence ====================

  // Set skill storage directory
  const skillStorageDir = getSkillStorageDir(context.globalStorageUri.fsPath);
  setSkillStorageDir(skillStorageDir);

  // Restore skills state from globalState
  const savedSkillsState = context.globalState.get<SerializedSkillsState>(SKILLS_STATE_KEY);
  if (savedSkillsState) {
    try {
      skillsState.restore(savedSkillsState);
      outputChannel.appendLine('Restored skills state from previous session.');
    } catch (err) {
      outputChannel.appendLine(`Error restoring skills state: ${err}`);
    }
  }

  // Set up skills persistence callback
  skillsState.setPersistCallback(async (data) => {
    try {
      await context.globalState.update(SKILLS_STATE_KEY, data);
      outputChannel.appendLine('Skills state saved.');
    } catch (err) {
      outputChannel.appendLine(`Error saving skills state: ${err}`);
    }
  }, 1000);

  // Register command to start the Express server.
  context.subscriptions.push(
    vscode.commands.registerCommand('copilotProxy.startServer', () => {
      if (!serverInstance) {
        const config = vscode.workspace.getConfiguration("copilotProxy");
        const configPort = config.get("port", 3000);
        const tokens = getStoredTokens(context);
        serverInstance = startServer(configPort, tokens.map(t => t.token));
        vscode.window.showInformationMessage(`Express server started on port ${configPort}.`);
      } else {
        vscode.window.showInformationMessage('Express server is already running.');
      }
    })
  );

  // Register command to stop the Express server.
  context.subscriptions.push(
    vscode.commands.registerCommand('copilotProxy.stopServer', () => {
      if (serverInstance) {
        serverInstance.close();
        serverInstance = undefined;
        vscode.window.showInformationMessage('Express server stopped.');
      } else {
        vscode.window.showInformationMessage('No Express server is running.');
      }
    })
  );

  // Register command to configure the port.
  context.subscriptions.push(
    vscode.commands.registerCommand('copilotProxy.configurePort', () => {
      configurePort();
    })
  );

  // Register command to list available LLM models via the VS Code picker.
  context.subscriptions.push(
    vscode.commands.registerCommand('copilotProxy.listModels', async () => {
      try {
        const models = await vscode.lm.selectChatModels({});
        if (!models || models.length === 0) {
          vscode.window.showInformationMessage('No model selected.');
          return;
        }
        outputChannel.appendLine('Available/selected models:');
        for (const m of models) {
          const model = m as LanguageModelChatWithId;
          outputChannel.appendLine(`vendor: ${model.vendor}, family: ${model.family}${model.id ? ', id: '+model.id : ''}`);
        }
        vscode.window.showInformationMessage('Model info written to Copilot Proxy Log');
      } catch (err) {
        outputChannel.appendLine(`Error listing models: ${String(err)}`);
        vscode.window.showErrorMessage('Failed to list models (see Copilot Proxy Log).');
      }
    })
  );

  // ==================== API Token Management Commands ====================

  // Register command to create a new API token
  context.subscriptions.push(
    vscode.commands.registerCommand('copilotProxy.createApiToken', async () => {
      const name = await vscode.window.showInputBox({
        prompt: "Enter a name for this API token (e.g., 'aider', 'production'):",
        placeHolder: "Token name",
        validateInput: (value: string): string | undefined => {
          if (!value || value.trim().length === 0) {
            return "Token name cannot be empty.";
          }
          return undefined;
        }
      });

      if (!name) {
        return;
      }

      const token = generateToken();
      const tokens = getStoredTokens(context);
      tokens.push({
        token,
        name: name.trim(),
        createdAt: Date.now()
      });
      saveTokens(context, tokens);

      outputChannel.appendLine(`Created new API token: ${name}`);
      outputChannel.appendLine(`Token: ${token}`);

      const action = await vscode.window.showInformationMessage(
        `API token created: ${name}`,
        'Copy Token',
        'Show in Log'
      );

      if (action === 'Copy Token') {
        await vscode.env.clipboard.writeText(token);
        vscode.window.showInformationMessage('Token copied to clipboard!');
      } else if (action === 'Show in Log') {
        outputChannel.show();
      }
    })
  );

  // Register command to list all API tokens
  context.subscriptions.push(
    vscode.commands.registerCommand('copilotProxy.listApiTokens', async () => {
      const tokens = getStoredTokens(context);

      if (tokens.length === 0) {
        vscode.window.showInformationMessage('No API tokens found. Create one using "Copilot Proxy: Create API Token".');
        return;
      }

      outputChannel.appendLine('\n=== API Tokens ===');
      tokens.forEach((t, idx) => {
        const created = new Date(t.createdAt).toLocaleString();
        outputChannel.appendLine(`${idx + 1}. Name: ${t.name}`);
        outputChannel.appendLine(`   Token: ${t.token}`);
        outputChannel.appendLine(`   Created: ${created}`);
        outputChannel.appendLine('');
      });
      outputChannel.show();

      vscode.window.showInformationMessage(`Found ${tokens.length} API token(s). Check Copilot Proxy Log for details.`);
    })
  );

  // Register command to remove an API token
  context.subscriptions.push(
    vscode.commands.registerCommand('copilotProxy.removeApiToken', async () => {
      const tokens = getStoredTokens(context);

      if (tokens.length === 0) {
        vscode.window.showInformationMessage('No API tokens found.');
        return;
      }

      const items = tokens.map((t, idx) => ({
        label: t.name,
        description: t.token.substring(0, 16) + '...',
        detail: `Created: ${new Date(t.createdAt).toLocaleString()}`,
        token: t.token
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a token to remove',
        canPickMany: false
      });

      if (!selected) {
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to remove token "${selected.label}"?`,
        { modal: true },
        'Remove'
      );

      if (confirm === 'Remove') {
        const updatedTokens = tokens.filter(t => t.token !== selected.token);
        saveTokens(context, updatedTokens);
        outputChannel.appendLine(`Removed API token: ${selected.label}`);
        vscode.window.showInformationMessage(`Token "${selected.label}" removed successfully.`);
      }
    })
  );

  // Register a disposable to stop the server when the extension is deactivated.
  context.subscriptions.push({
    dispose: () => {
      if (serverInstance) {
        serverInstance.close();
        outputChannel.appendLine('Express server has been stopped.');
      }
    }
  });
}

export function deactivate() {
  if (serverInstance) {
    serverInstance.close();
    serverInstance = undefined;
    outputChannel.appendLine('Express server has been stopped on deactivation.');
  }
}

function extractMessageContent(content: string | StructuredMessageContent[] | null | undefined): string {
  if (content === null || content === undefined) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map(item => item.text).join('\n');
  }
  return String(content);
}

export async function processEmbeddingRequest(request: EmbeddingRequest): Promise<EmbeddingResponse> {
  // Normalize input to array
  const inputs = Array.isArray(request.input) ? request.input : [request.input];

  // Access proposed embeddings API
  const embeddingModels = getAvailableEmbeddingModels();
  if (embeddingModels.length === 0) {
    throw new Error(
      'No embedding models available. The VS Code Embeddings API is a proposed API and may not be enabled. ' +
      'Ensure your VS Code version supports it and the extension has "embeddings" in enabledApiProposals.'
    );
  }

  // Find matching model or use first available
  let selectedModel = embeddingModels[0];
  if (request.model) {
    const match = embeddingModels.find(m => m === request.model);
    if (match) {
      selectedModel = match;
    }
  }

  const result: vscode.Embedding[] = await vscode.lm.computeEmbeddings(selectedModel, inputs);

  // Estimate tokens (rough: ~4 chars per token)
  const totalChars = inputs.reduce((sum, s) => sum + s.length, 0);
  const estimatedTokens = Math.ceil(totalChars / 4);

  const data = result.map((embedding, index) => ({
    object: 'embedding' as const,
    embedding: Array.from(embedding.values) as number[],
    index,
  }));

  return {
    object: 'list',
    data,
    model: selectedModel,
    usage: {
      prompt_tokens: estimatedTokens,
      total_tokens: estimatedTokens,
    },
  };
}

export async function processChatRequest(request: ChatCompletionRequest): Promise<AsyncIterable<ChatCompletionChunk> | ChatCompletionResponse> {
  const userMessages = request.messages.filter(message => message.role.toLowerCase() === "user");
  const latestUserMessage = userMessages.length > 0 ? userMessages[userMessages.length - 1].content : '';
  const preview = typeof latestUserMessage === 'string'
    ? (latestUserMessage.length > 30 ? latestUserMessage.slice(0, 30) + '...' : latestUserMessage)
    : JSON.stringify(latestUserMessage);

  outputChannel.appendLine(`Request received. Model: ${request.model}. Preview: ${preview}`);
  outputChannel.appendLine(`Full messages: ${JSON.stringify(request.messages, null, 2)}`);

  // Extract system messages and combine their content
  const systemMessages = request.messages.filter(message => message.role.toLowerCase() === "system");
  const systemContent = systemMessages
    .map(msg => extractMessageContent(msg.content))
    .filter(content => content.length > 0)
    .join('\n\n');

  // Map request messages to vscode.LanguageModelChatMessage format
  // Prepend system content to the first user message (VS Code LM API has no SystemMessage)
  const chatMessages: vscode.LanguageModelChatMessage[] = [];
  let systemPrepended = false;

  for (const message of request.messages) {
    const role = message.role.toLowerCase();

    // Skip system messages as we'll prepend them to the first user message
    if (role === "system") {
      continue;
    }

    // Handle tool result messages
    if (role === 'tool' && message.tool_call_id) {
      const processedContent = extractMessageContent(message.content);
      const resultPart = new vscode.LanguageModelToolResultPart(
        message.tool_call_id,
        [new vscode.LanguageModelTextPart(processedContent)]
      );
      chatMessages.push(vscode.LanguageModelChatMessage.User([resultPart]));
      continue;
    }

    // Handle assistant messages with tool_calls
    if (role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
      const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
      const textContent = extractMessageContent(message.content);
      if (textContent) {
        parts.push(new vscode.LanguageModelTextPart(textContent));
      }
      for (const tc of message.tool_calls) {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          args = {};
        }
        parts.push(new vscode.LanguageModelToolCallPart(tc.id, tc.function.name, args));
      }
      chatMessages.push(vscode.LanguageModelChatMessage.Assistant(parts));
      continue;
    }

    const processedContent = extractMessageContent(message.content);

    if (role === "user") {
      if (!systemPrepended && systemContent) {
        // Prepend system instructions to first user message
        const combinedContent = `${systemContent}\n\n---\n\n${processedContent}`;
        chatMessages.push(vscode.LanguageModelChatMessage.User(combinedContent));
        systemPrepended = true;
      } else {
        chatMessages.push(vscode.LanguageModelChatMessage.User(processedContent));
      }
    } else {
      // Assistant message (without tool_calls)
      chatMessages.push(vscode.LanguageModelChatMessage.Assistant(processedContent));
    }
  }

  // If no user messages but we have system content, add it as a user message
  if (!systemPrepended && systemContent) {
    chatMessages.unshift(vscode.LanguageModelChatMessage.User(systemContent));
  }

  const [selectedModel] = await vscode.lm.selectChatModels({
    vendor: "copilot",
    family: request.model,
  });
  if (!selectedModel) {
    outputChannel.appendLine(`ERROR: No language model available for model: ${request.model}`);
    throw new Error(`No language model available for model: ${request.model}`);
  }

  // Build request options with native tool support
  const options: vscode.LanguageModelChatRequestOptions = {};
  if (request.tools?.length) {
    const toolMode = toToolMode(request.tool_choice);
    if (toolMode !== undefined) {
      options.tools = toVSCodeTools(request.tools);
      options.toolMode = toolMode;
    }
    // If toolMode is undefined (choice === 'none'), omit tools entirely
  }

  if (request.stream) {
    // Streaming mode: call the real backend and yield response chunks.
    return (async function* () {
      const cancellationSource = new vscode.CancellationTokenSource();
      try {
        const chatResponse = await selectedModel.sendRequest(
          chatMessages,
          options,
          cancellationSource.token
        );
        let firstChunk = true;
        let chunkIndex = 0;
        const accumulatedToolCalls: { callId: string; name: string; input: unknown }[] = [];

        // Iterate over the response stream (supports both text and tool call parts)
        for await (const part of chatResponse.stream) {
          if (part instanceof vscode.LanguageModelTextPart) {
            const chunk: ChatCompletionChunk = {
              id: `chatcmpl-stream-${chunkIndex}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: request.model,
              choices: [
                {
                  delta: {
                    ...(firstChunk ? { role: "assistant" } : {}),
                    content: part.value,
                  },
                  index: 0,
                  finish_reason: "",
                },
              ],
            };
            firstChunk = false;
            chunkIndex++;
            yield chunk;
          } else if (part instanceof vscode.LanguageModelToolCallPart) {
            accumulatedToolCalls.push({
              callId: part.callId,
              name: part.name,
              input: part.input,
            });
          }
        }

        // If tool calls were received, yield them as a tool_calls delta chunk
        if (accumulatedToolCalls.length > 0) {
          const toolCallChunks: ToolCallChunk[] = accumulatedToolCalls.map((tc, index) => ({
            index,
            id: tc.callId,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.input),
            },
          }));

          const toolCallsChunk: ChatCompletionChunk = {
            id: `chatcmpl-stream-${chunkIndex}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: request.model,
            choices: [
              {
                delta: {
                  ...(firstChunk ? { role: "assistant" } : {}),
                  tool_calls: toolCallChunks,
                },
                index: 0,
                finish_reason: "tool_calls",
              },
            ],
          };
          yield toolCallsChunk;
        } else {
          // After finishing the iteration with no tool calls, yield a final stop chunk.
          const finalChunk: ChatCompletionChunk = {
            id: `chatcmpl-stream-final`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: request.model,
            choices: [
              {
                delta: { content: "" },
                index: 0,
                finish_reason: "stop",
              },
            ],
          };
          yield finalChunk;
        }
      } catch (error) {
        outputChannel.appendLine("ERROR: Error in streaming mode:");
        if (error instanceof Error) {
          outputChannel.appendLine(`Message: ${error.message}`);
          outputChannel.appendLine(`Stack: ${error.stack}`);
        } else {
          outputChannel.appendLine(`Unknown error type: ${JSON.stringify(error)}`);
        }
        throw error;
      } finally {
        cancellationSource.dispose();
      }
    })();
  } else {
    // Non-streaming mode: call the real backend and accumulate the full response.
    const cancellationSource = new vscode.CancellationTokenSource();
    try {
      const chatResponse = await selectedModel.sendRequest(
        chatMessages,
        options,
        cancellationSource.token
      );
      let fullContent = "";
      const toolCalls: ToolCall[] = [];

      for await (const part of chatResponse.stream) {
        if (part instanceof vscode.LanguageModelTextPart) {
          fullContent += part.value;
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push({
            id: part.callId,
            type: 'function',
            function: {
              name: part.name,
              arguments: JSON.stringify(part.input),
            },
          });
        }
      }

      const hasToolCalls = toolCalls.length > 0;
      const completionTokens = Math.ceil(fullContent.length / 4);
      const response: ChatCompletionResponse = {
        id: `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: fullContent || null,
              refusal: null,
              annotations: [],
              ...(hasToolCalls ? { tool_calls: toolCalls } : {}),
            },
            logprobs: null,
            finish_reason: hasToolCalls ? "tool_calls" : "stop",
          },
        ],
        usage: {
          prompt_tokens: 0,
          completion_tokens: completionTokens,
          total_tokens: completionTokens,
          prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
        },
        service_tier: 'default',
        system_fingerprint: null,
      };
      return response;
    } catch (error) {
      outputChannel.appendLine("ERROR: Error in non-streaming mode:");
      if (error instanceof Error) {
        outputChannel.appendLine(`Message: ${error.message}`);
        outputChannel.appendLine(`Stack: ${error.stack}`);
      } else {
        outputChannel.appendLine(`Unknown error type: ${JSON.stringify(error)}`);
      }
      throw error;
    } finally {
      cancellationSource.dispose();
    }
  }
}
