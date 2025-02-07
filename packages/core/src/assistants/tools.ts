/**
 * Tool Calling Utilities
 */

let toolCallCounter = 0;

export function generateToolCallId(): string {
  return `call_${Date.now().toString(36)}${(++toolCallCounter).toString(36)}`;
}
