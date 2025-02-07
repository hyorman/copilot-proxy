/**
 * VS Code-Specific Tool Conversion Utilities
 *
 * Converts between OpenAI tool formats and VS Code Language Model API tool types.
 * Platform-independent conversions live in @copilot-proxy/core.
 */

import * as vscode from 'vscode';
import { FunctionTool, ChatCompletionRequest, AssistantTool } from '@copilot-proxy/core';

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
