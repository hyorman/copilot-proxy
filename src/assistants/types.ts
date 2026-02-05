/**
 * OpenAI Assistants API Types
 *
 * Full stateful implementation supporting:
 * - Assistants (create, get, list, update, delete)
 * - Threads (create, get, delete)
 * - Messages (create, get, list)
 * - Runs (create, get, list, cancel)
 *
 * Future extensibility:
 * - Tool calling (code_interpreter, file_search, function)
 * - Streaming runs (SSE)
 * - Run steps
 */

import { ToolCall } from '../types';

// Re-export ToolCall so consumers don't need to change imports
export { ToolCall };

// ==================== Common Types ====================

export interface OpenAIListResponse<T> {
  object: 'list';
  data: T[];
  first_id: string | null;
  last_id: string | null;
  has_more: boolean;
}

export interface PaginationParams {
  limit?: number;       // Default 20, max 100
  order?: 'asc' | 'desc';
  after?: string;       // Cursor for pagination
  before?: string;
}

// ==================== Tool Types (Future Extension) ====================

export type ToolType = 'code_interpreter' | 'file_search' | 'function';

export interface FunctionDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface AssistantTool {
  type: ToolType;
  function?: FunctionDefinition;
}

export interface ToolOutput {
  tool_call_id: string;
  output: string;
}

// ==================== Assistant Types ====================

export interface Assistant {
  id: string;                              // "asst_abc123"
  object: 'assistant';
  created_at: number;                      // Unix timestamp (seconds)
  name: string | null;
  description: string | null;
  model: string;                           // e.g., "gpt-4o", "claude-3.5-sonnet"
  instructions: string | null;             // System prompt
  tools: AssistantTool[];
  metadata: Record<string, string>;        // User-defined key-value pairs (max 16)
  // Future: tool_resources, temperature, top_p, response_format
}

export interface CreateAssistantRequest {
  model: string;
  name?: string;
  description?: string;
  instructions?: string;
  tools?: AssistantTool[];
  metadata?: Record<string, string>;
  // Future: tool_resources, temperature, top_p, response_format
}

export interface UpdateAssistantRequest {
  model?: string;
  name?: string | null;
  description?: string | null;
  instructions?: string | null;
  tools?: AssistantTool[];
  metadata?: Record<string, string>;
}

// ==================== Thread Types ====================

export interface Thread {
  id: string;                              // "thread_abc123"
  object: 'thread';
  created_at: number;
  metadata: Record<string, string>;
  // Future: tool_resources
}

export interface CreateThreadRequest {
  messages?: CreateMessageRequest[];       // Initial messages
  metadata?: Record<string, string>;
  // Future: tool_resources
}

// ==================== Message Types ====================

export type MessageRole = 'user' | 'assistant';
export type MessageStatus = 'in_progress' | 'incomplete' | 'completed';

export interface TextContent {
  type: 'text';
  text: {
    value: string;
    annotations: TextAnnotation[];
  };
}

// Future: Support for images and file attachments
export interface ImageFileContent {
  type: 'image_file';
  image_file: {
    file_id: string;
    detail?: 'auto' | 'low' | 'high';
  };
}

export interface ImageUrlContent {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
}

// Annotations for citations (future)
export interface TextAnnotation {
  type: 'file_citation' | 'file_path';
  text: string;
  start_index: number;
  end_index: number;
  file_citation?: {
    file_id: string;
    quote?: string;
  };
  file_path?: {
    file_id: string;
  };
}

export type MessageContent = TextContent | ImageFileContent | ImageUrlContent;

export interface Message {
  id: string;                              // "msg_abc123"
  object: 'thread.message';
  created_at: number;
  thread_id: string;
  status: MessageStatus;
  incomplete_details: { reason: string } | null;
  completed_at: number | null;
  incomplete_at: number | null;
  role: MessageRole;
  content: MessageContent[];
  assistant_id: string | null;             // Set if created by a run
  run_id: string | null;                   // Set if created by a run
  attachments: MessageAttachment[];
  metadata: Record<string, string>;
}

export interface MessageAttachment {
  file_id: string;
  tools: Array<{ type: ToolType }>;
}

export interface CreateMessageRequest {
  role: 'user' | 'assistant';
  content: string | MessageContent[];
  attachments?: MessageAttachment[];
  metadata?: Record<string, string>;
}

// ==================== Run Types ====================

export type RunStatus =
  | 'queued'
  | 'in_progress'
  | 'requires_action'    // Future: tool calling
  | 'cancelling'
  | 'cancelled'
  | 'failed'
  | 'completed'
  | 'incomplete'
  | 'expired';

export interface RunError {
  code: 'server_error' | 'rate_limit_exceeded' | 'invalid_prompt';
  message: string;
}

export interface RunUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// Future: For tool calling support
export interface RequiredAction {
  type: 'submit_tool_outputs';
  submit_tool_outputs: {
    tool_calls: ToolCall[];
  };
}

export interface Run {
  id: string;                              // "run_abc123"
  object: 'thread.run';
  created_at: number;
  thread_id: string;
  assistant_id: string;
  status: RunStatus;
  required_action: RequiredAction | null;  // Future: tool calling
  last_error: RunError | null;
  expires_at: number | null;               // 10 minute timeout
  started_at: number | null;
  cancelled_at: number | null;
  failed_at: number | null;
  completed_at: number | null;
  incomplete_details: { reason: string } | null;
  model: string;
  instructions: string | null;             // Override assistant instructions
  tools: AssistantTool[];
  metadata: Record<string, string>;
  usage: RunUsage | null;
  // Future: temperature, top_p, max_prompt_tokens, max_completion_tokens,
  //         truncation_strategy, response_format, tool_choice, parallel_tool_calls
}

export interface CreateRunRequest {
  assistant_id: string;
  model?: string;                          // Override assistant's model
  instructions?: string;                   // Override instructions
  additional_instructions?: string;        // Append to instructions
  additional_messages?: CreateMessageRequest[];
  tools?: AssistantTool[];
  metadata?: Record<string, string>;
  stream?: boolean;                        // Future: streaming runs
  // Future: temperature, top_p, max_prompt_tokens, max_completion_tokens,
  //         truncation_strategy, response_format, tool_choice, parallel_tool_calls
}

// Combined thread + run creation
export interface CreateThreadAndRunRequest {
  assistant_id: string;
  thread?: CreateThreadRequest;
  model?: string;
  instructions?: string;
  tools?: AssistantTool[];
  metadata?: Record<string, string>;
  stream?: boolean;
}

// Submit tool outputs
export interface SubmitToolOutputsRequest {
  tool_outputs: ToolOutput[];
  stream?: boolean;
}

// ==================== Run Steps ====================

export type RunStepType = 'message_creation' | 'tool_calls';
export type RunStepStatus = 'in_progress' | 'cancelled' | 'failed' | 'completed' | 'expired';

export interface RunStep {
  id: string;
  object: 'thread.run.step';
  created_at: number;
  run_id: string;
  assistant_id: string;
  thread_id: string;
  type: RunStepType;
  status: RunStepStatus;
  cancelled_at: number | null;
  completed_at: number | null;
  expired_at: number | null;
  failed_at: number | null;
  last_error: RunError | null;
  step_details: MessageCreationStepDetails | ToolCallsStepDetails;
  usage: RunUsage | null;
}

export interface MessageCreationStepDetails {
  type: 'message_creation';
  message_creation: {
    message_id: string;
  };
}

export interface ToolCallsStepDetails {
  type: 'tool_calls';
  tool_calls: ToolCall[];
}

// ==================== Streaming Events ====================

export type StreamEventType =
  | 'thread.created'
  | 'thread.run.created'
  | 'thread.run.queued'
  | 'thread.run.in_progress'
  | 'thread.run.requires_action'
  | 'thread.run.completed'
  | 'thread.run.incomplete'
  | 'thread.run.failed'
  | 'thread.run.cancelling'
  | 'thread.run.cancelled'
  | 'thread.run.expired'
  | 'thread.run.step.created'
  | 'thread.run.step.in_progress'
  | 'thread.run.step.delta'
  | 'thread.run.step.completed'
  | 'thread.run.step.failed'
  | 'thread.run.step.cancelled'
  | 'thread.run.step.expired'
  | 'thread.message.created'
  | 'thread.message.in_progress'
  | 'thread.message.delta'
  | 'thread.message.completed'
  | 'thread.message.incomplete'
  | 'error'
  | 'done';

export interface StreamEvent {
  event: StreamEventType;
  data: unknown;
}

export interface MessageDelta {
  id: string;
  object: 'thread.message.delta';
  delta: {
    content: Array<{
      index: number;
      type: 'text';
      text: {
        value: string;
        annotations?: unknown[];
      };
    }>;
  };
}

