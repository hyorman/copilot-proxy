/**
 * Tool Calling Utilities
 * 
 * Implements prompt-based tool calling for VS Code LM API which doesn't have
 * native function calling support.
 * 
 * Approach:
 * 1. Inject tool definitions into system prompt
 * 2. Parse tool calls from model output using markers
 * 3. Resume run after tool outputs are submitted
 */

import { AssistantTool, ToolCall, ParsedToolCall } from './types';

// ==================== ID Generation ====================

let toolCallCounter = 0;

/**
 * Generate a unique tool call ID
 */
export function generateToolCallId(): string {
  return `call_${Date.now().toString(36)}${(++toolCallCounter).toString(36)}`;
}

// ==================== Prompt Injection ====================

/**
 * Format tool definitions for injection into system prompt
 */
export function formatToolsForPrompt(tools: AssistantTool[]): string {
  const functionTools = tools.filter(t => t.type === 'function' && t.function);
  
  if (functionTools.length === 0) {
    return '';
  }

  let prompt = '\n\n---\n\n## Available Tools\n\n';
  prompt += 'You have access to the following tools. When you need to use a tool, respond with a tool call block.\n\n';

  for (const tool of functionTools) {
    const func = tool.function!;
    prompt += `### ${func.name}\n`;
    
    if (func.description) {
      prompt += `${func.description}\n\n`;
    }
    
    if (func.parameters && Object.keys(func.parameters).length > 0) {
      prompt += '**Parameters:**\n';
      prompt += '```json\n';
      prompt += JSON.stringify(func.parameters, null, 2);
      prompt += '\n```\n\n';
    } else {
      prompt += '**Parameters:** None\n\n';
    }
  }

  prompt += `## How to Call Tools

When you need to use a tool, output EXACTLY this format:

<tool_call>
{"name": "tool_name", "arguments": {"param1": "value1", "param2": "value2"}}
</tool_call>

Important rules:
1. Output ONLY the tool_call block when calling a tool
2. Wait for tool results before continuing
3. You can call multiple tools by including multiple <tool_call> blocks
4. After receiving tool results, continue your response naturally
5. Only call tools that are listed above
6. Ensure the JSON inside <tool_call> is valid
`;

  return prompt;
}

/**
 * Format tool results for injection into conversation
 */
export function formatToolResultsForPrompt(
  toolCalls: ToolCall[], 
  outputs: { tool_call_id: string; output: string }[]
): string {
  const outputMap = new Map(outputs.map(o => [o.tool_call_id, o.output]));
  
  let prompt = 'Tool execution results:\n\n';
  
  for (const call of toolCalls) {
    const output = outputMap.get(call.id);
    prompt += `<tool_result name="${call.function.name}" id="${call.id}">\n`;
    prompt += output ?? '(no output)';
    prompt += '\n</tool_result>\n\n';
  }
  
  prompt += 'Please continue your response based on these results.';
  
  return prompt;
}

// ==================== Tool Call Parsing ====================

/**
 * Parse tool calls from model output
 * Returns extracted tool calls and the remaining text content
 */
export function parseToolCalls(content: string): {
  toolCalls: ParsedToolCall[];
  textContent: string;
  hasToolCalls: boolean;
} {
  const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  const toolCalls: ParsedToolCall[] = [];
  let match;

  while ((match = regex.exec(content)) !== null) {
    try {
      const jsonStr = match[1].trim();
      const parsed = JSON.parse(jsonStr);
      
      if (parsed.name && typeof parsed.name === 'string') {
        toolCalls.push({
          name: parsed.name,
          arguments: parsed.arguments ?? {}
        });
      }
    } catch (e) {
      // Skip malformed tool calls, continue parsing
      console.warn('Failed to parse tool call JSON:', e);
    }
  }

  // Remove tool call blocks from content
  const textContent = content.replace(regex, '').trim();

  return {
    toolCalls,
    textContent,
    hasToolCalls: toolCalls.length > 0
  };
}

/**
 * Convert parsed tool calls to ToolCall objects with IDs
 */
export function createToolCallObjects(parsedCalls: ParsedToolCall[]): ToolCall[] {
  return parsedCalls.map(pc => ({
    id: generateToolCallId(),
    type: 'function' as const,
    function: {
      name: pc.name,
      arguments: JSON.stringify(pc.arguments)
    }
  }));
}

/**
 * Validate that tool calls reference existing tools
 */
export function validateToolCalls(
  parsedCalls: ParsedToolCall[], 
  availableTools: AssistantTool[]
): { valid: ParsedToolCall[]; invalid: string[] } {
  const toolNames = new Set(
    availableTools
      .filter(t => t.type === 'function' && t.function)
      .map(t => t.function!.name)
  );

  const valid: ParsedToolCall[] = [];
  const invalid: string[] = [];

  for (const call of parsedCalls) {
    if (toolNames.has(call.name)) {
      valid.push(call);
    } else {
      invalid.push(call.name);
    }
  }

  return { valid, invalid };
}

// ==================== Streaming Support ====================

/**
 * Buffer for accumulating streamed content to detect tool calls
 * Tool calls need to be complete before we can parse them
 */
export class ToolCallBuffer {
  private content: string = '';
  private inToolCall: boolean = false;
  private toolCallDepth: number = 0;

  /**
   * Add content to buffer
   * Returns content that can be safely emitted (not part of a tool call)
   */
  append(chunk: string): { safeContent: string; complete: boolean } {
    this.content += chunk;
    
    // Check for tool call markers
    const openCount = (this.content.match(/<tool_call>/gi) || []).length;
    const closeCount = (this.content.match(/<\/tool_call>/gi) || []).length;
    
    this.inToolCall = openCount > closeCount;
    
    if (!this.inToolCall && openCount === closeCount) {
      // All tool calls are complete (or there are none)
      return { safeContent: '', complete: true };
    }
    
    // We're in the middle of a tool call, don't emit anything yet
    return { safeContent: '', complete: false };
  }

  /**
   * Get the full accumulated content
   */
  getContent(): string {
    return this.content;
  }

  /**
   * Check if we're currently inside a tool call block
   */
  isInToolCall(): boolean {
    return this.inToolCall;
  }

  /**
   * Reset the buffer
   */
  reset(): void {
    this.content = '';
    this.inToolCall = false;
    this.toolCallDepth = 0;
  }
}
