import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  createApp,
  generateApiToken,
  setApiTokens,
  addApiToken as addServerToken,
  removeApiToken as removeServerToken,
  state,
  SerializedState,
  skillsState,
  SerializedSkillsState,
  setSkillStorageDir,
  Logger,
} from '@hyorman/copilot-proxy-core';
import { VSCodeBackend } from './vscodeBackend';

let outputChannel: vscode.OutputChannel;

export function getOutputChannel(): vscode.OutputChannel {
  return outputChannel;
}

let serverInstance: ReturnType<typeof import('http').createServer> | undefined;

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
  return generateApiToken();
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
 * Compute skill storage directory from extension global storage path
 */
function getSkillStorageDir(globalStoragePath: string): string {
  const storageDir = path.join(globalStoragePath, 'skill-bundles');
  fs.mkdirSync(storageDir, { recursive: true });
  return storageDir;
}

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('Copilot Proxy Log');
  outputChannel.show();
  context.subscriptions.push(outputChannel);
  outputChannel.appendLine('Extension "Copilot Proxy" is now active!');

  const logger: Logger = {
    log: (msg: string) => outputChannel.appendLine(msg),
  };

  // Create backend and app
  const backend = new VSCodeBackend(logger);
  const app = createApp(backend, logger);

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
  }, 1000);

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

  // ==================== Server Commands ====================

  // Register command to start the Express server.
  context.subscriptions.push(
    vscode.commands.registerCommand('copilotProxy.startServer', () => {
      if (!serverInstance) {
        const config = vscode.workspace.getConfiguration("copilotProxy");
        const configPort = config.get("port", 3000);
        const tokens = getStoredTokens(context);
        setApiTokens(tokens.map(t => t.token));
        serverInstance = app.listen(configPort, () => {
          outputChannel.appendLine(`Express server listening on port ${configPort}`);
        });
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
    outputChannel?.appendLine('Express server has been stopped on deactivation.');
  }
}
