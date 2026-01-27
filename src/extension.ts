import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel;
import { startServer } from './server';
import {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  StructuredMessageContent
} from './types';
import { state, SerializedState } from './assistants';

let serverInstance: ReturnType<typeof startServer> | undefined;

// Model info interface for getAvailableModels
interface ModelInfo {
  vendor: string;
  family: string;
  id?: string;
}

// State persistence key
const STATE_KEY = 'copilotProxy.assistantsState';

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
 * Get available models from VS Code Language Model API
 */
export async function getAvailableModels(): Promise<ModelInfo[]> {
  const models = await vscode.lm.selectChatModels({});
  return models.map(m => ({
    vendor: m.vendor,
    family: m.family,
    id: (m as any).id
  }));
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
  state.setPersistCallback((data) => {
    context.globalState.update(STATE_KEY, data).then(
      () => outputChannel.appendLine('Assistants state saved.'),
      (err) => outputChannel.appendLine(`Error saving state: ${err}`)
    );
  }, 1000); // 1 second debounce

  // Register command to start the Express server.
  context.subscriptions.push(
    vscode.commands.registerCommand('copilotProxy.startServer', () => {
      if (!serverInstance) {
        const configPort = vscode.workspace.getConfiguration("copilotProxy").get("port", 3000);
        serverInstance = startServer(configPort);
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
          outputChannel.appendLine(`vendor: ${m.vendor}, family: ${m.family}${(m as any).id ? ', id: '+(m as any).id : ''}`);
        }
        vscode.window.showInformationMessage('Model info written to Copilot Proxy Log');
      } catch (err) {
        outputChannel.appendLine(`Error listing models: ${String(err)}`);
        vscode.window.showErrorMessage('Failed to list models (see Copilot Proxy Log).');
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

function extractMessageContent(content: string | StructuredMessageContent[]): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map(item => item.text).join('\n');
  }
  return String(content);
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
      // Assistant message
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

  if (request.stream) {
    // Streaming mode: call the real backend and yield response chunks.
    return (async function* () {
      try {
        const cancellationSource = new vscode.CancellationTokenSource();
        const chatResponse = await selectedModel.sendRequest(
          chatMessages,
          {},
          cancellationSource.token
        );
        let firstChunk = true;
        let chunkIndex = 0;
        // Iterate over the response fragments from the real backend.
        for await (const fragment of chatResponse.text) {
          const chunk: ChatCompletionChunk = {
            id: `chatcmpl-stream-${chunkIndex}`,
            object: "chat.completion.chunk",
            created: Date.now(),
            model: request.model,
            choices: [
              {
                delta: {
                  ...(firstChunk ? { role: "assistant" } : {}),
                  content: fragment,
                },
                index: 0,
                finish_reason: "",
              },
            ],
          };
          firstChunk = false;
          chunkIndex++;
          yield chunk;
        }
        // After finishing the iteration, yield a final chunk to indicate completion.
        const finalChunk: ChatCompletionChunk = {
          id: `chatcmpl-stream-final`,
          object: "chat.completion.chunk",
          created: Date.now(),
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
      } catch (error) {
        outputChannel.appendLine("ERROR: Error in streaming mode:");
        if (error instanceof Error) {
          outputChannel.appendLine(`Message: ${error.message}`);
          outputChannel.appendLine(`Stack: ${error.stack}`);
        } else {
          outputChannel.appendLine(`Unknown error type: ${JSON.stringify(error)}`);
        }
        throw error;
      }
    })();  // Add parentheses here to properly close and invoke the IIFE
  } else {
    // Non-streaming mode: call the real backend and accumulate the full response.
    try {
      const cancellationSource = new vscode.CancellationTokenSource();
      const chatResponse = await selectedModel.sendRequest(
        chatMessages,
        {},
        cancellationSource.token
      );
      let fullContent = "";
      for await (const fragment of chatResponse.text) {
        fullContent += fragment;
      }
      const response: ChatCompletionResponse = {
        id: "chatcmpl-nonstream",
        object: "chat.completion",
        created: Date.now(),
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: fullContent },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 0,
          completion_tokens: fullContent.length,
          total_tokens: fullContent.length,
        },
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
    }
  }
}
