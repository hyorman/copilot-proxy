/**
 * Tool Conversion Utilities
 *
 * Converts between OpenAI tool formats and VS Code Language Model API tool types.
 * Used by all three calling contexts:
 * - Chat Completions API (extension.ts)
 * - Responses API (server.ts)
 * - Assistants runner (assistants/runner.ts)
 */

import * as vscode from 'vscode';
import { FunctionTool, ChatCompletionRequest } from './types';
import { AssistantTool } from './assistants/types';

/**
 * Convert OpenAI FunctionTool[] to VS Code LanguageModelChatTool[]
 */
export function toVSCodeTools(tools: FunctionTool[]): vscode.LanguageModelChatTool[] {
  return tools
    .filter(t => t.type === 'function')
    .map(t => ({
      name: t.function.name,
      description: t.function.description ?? '',
      inputSchema: t.function.parameters,
    }));
}

/**
 * Convert Assistants API AssistantTool[] to VS Code LanguageModelChatTool[]
 */
export function assistantToolsToVSCode(tools: AssistantTool[]): vscode.LanguageModelChatTool[] {
  return tools
    .filter(t => t.type === 'function' && t.function)
    .map(t => ({
      name: t.function!.name,
      description: t.function!.description ?? '',
      inputSchema: t.function!.parameters,
    }));
}

/**
 * Convert Assistants API AssistantTool[] to OpenAI FunctionTool[] for chat requests
 */
export function assistantToolsToFunctionTools(tools: AssistantTool[]): FunctionTool[] {
  return tools
    .filter(t => t.type === 'function' && t.function)
    .map(t => ({
      type: 'function' as const,
      function: {
        name: t.function!.name,
        description: t.function!.description,
        parameters: t.function!.parameters,
      },
    }));
}

/**
 * Convert OpenAI tool_choice to VS Code LanguageModelChatToolMode
 * Returns undefined when tools should be omitted entirely (choice === 'none')
 */
export function toToolMode(
  choice?: ChatCompletionRequest['tool_choice']
): vscode.LanguageModelChatToolMode | undefined {
  if (choice === 'none') {
    return undefined; // omit tools entirely
  }
  if (typeof choice === 'object') {
    return vscode.LanguageModelChatToolMode.Required;
  }
  // 'auto' or undefined
  return vscode.LanguageModelChatToolMode.Auto;
}
