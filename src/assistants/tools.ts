/**
 * Tool Calling Utilities
 *
 * Provides ID generation for tool calls.
 *
 * Native tool calling is handled by the VS Code Language Model API —
 * tool definitions are passed via LanguageModelChatRequestOptions.tools,
 * and tool call results come back as LanguageModelToolCallPart from the stream.
 */

// ==================== ID Generation ====================

let toolCallCounter = 0;

/**
 * Generate a unique tool call ID
 */
export function generateToolCallId(): string {
  return `call_${Date.now().toString(36)}${(++toolCallCounter).toString(36)}`;
}
