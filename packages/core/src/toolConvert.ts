/**
 * Tool Conversion Utilities (Core / Platform-Independent)
 *
 * Converts between different OpenAI tool formats.
 * Platform-specific conversions (e.g., to VS Code LanguageModelChatTool)
 * live in their respective packages.
 */

import { FunctionTool, ChatCompletionRequest } from './types.js';
import { AssistantTool } from './assistants/types.js';

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
 * Convert Responses API tools (flat format) to OpenAI FunctionTool[] (nested format).
 * Responses API: { type: "function", name, description, parameters }
 * Chat Completions: { type: "function", function: { name, description, parameters } }
 */
export function responsesToolsToFunctionTools(tools: any[]): FunctionTool[] {
  return tools.map(tool => {
    if (tool.type === 'function' && tool.function) {
      return tool as FunctionTool;
    }
    return {
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    };
  });
}

/**
 * Map OpenAI tool_choice to a simplified mode string.
 * Returns 'none' when tools should be omitted, 'auto' for default, 'required' for forced.
 */
export function toToolMode(
  choice?: ChatCompletionRequest['tool_choice']
): 'none' | 'auto' | 'required' {
  if (choice === 'none') {
    return 'none';
  }
  if (typeof choice === 'object') {
    return 'required';
  }
  return 'auto';
}
