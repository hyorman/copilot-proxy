/**
 * OpenAI Assistants API Types
 */

import { ToolCall } from '../types.js';
import type { SkillAttachment } from '../skills/types.js';

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
  limit?: number;
  order?: 'asc' | 'desc';
  after?: string;
  before?: string;
}

// ==================== Tool Types ====================

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
  id: string;
  object: 'assistant';
  created_at: number;
  name: string | null;
  description: string | null;
  model: string;
  instructions: string | null;
  tools: AssistantTool[];
  skills: SkillAttachment[];
  metadata: Record<string, string>;
}

export interface CreateAssistantRequest {
  model: string;
  name?: string;
  description?: string;
  instructions?: string;
  tools?: AssistantTool[];
  skills?: SkillAttachment[];
  metadata?: Record<string, string>;
}

export interface UpdateAssistantRequest {
  model?: string;
  name?: string | null;
  description?: string | null;
  instructions?: string | null;
  tools?: AssistantTool[];
  skills?: SkillAttachment[];
  metadata?: Record<string, string>;
}

// ==================== Thread Types ====================

export interface Thread {
  id: string;
  object: 'thread';
  created_at: number;
  metadata: Record<string, string>;
}

export interface CreateThreadRequest {
  messages?: CreateMessageRequest[];
  metadata?: Record<string, string>;
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
  id: string;
  object: 'thread.message';
  created_at: number;
  thread_id: string;
  status: MessageStatus;
  incomplete_details: { reason: string } | null;
  completed_at: number | null;
  incomplete_at: number | null;
  role: MessageRole;
  content: MessageContent[];
  assistant_id: string | null;
  run_id: string | null;
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
  | 'requires_action'
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

export interface RequiredAction {
  type: 'submit_tool_outputs';
  submit_tool_outputs: {
    tool_calls: ToolCall[];
  };
}

export interface Run {
  id: string;
  object: 'thread.run';
  created_at: number;
  thread_id: string;
  assistant_id: string;
  status: RunStatus;
  required_action: RequiredAction | null;
  last_error: RunError | null;
  expires_at: number | null;
  started_at: number | null;
  cancelled_at: number | null;
  failed_at: number | null;
  completed_at: number | null;
  incomplete_details: { reason: string } | null;
  model: string;
  instructions: string | null;
  tools: AssistantTool[];
  skills: SkillAttachment[];
  metadata: Record<string, string>;
  usage: RunUsage | null;
}

export interface CreateRunRequest {
  assistant_id: string;
  model?: string;
  instructions?: string;
  additional_instructions?: string;
  additional_messages?: CreateMessageRequest[];
  tools?: AssistantTool[];
  skills?: SkillAttachment[];
  metadata?: Record<string, string>;
  stream?: boolean;
}

export interface CreateThreadAndRunRequest {
  assistant_id: string;
  thread?: CreateThreadRequest;
  model?: string;
  instructions?: string;
  tools?: AssistantTool[];
  skills?: SkillAttachment[];
  metadata?: Record<string, string>;
  stream?: boolean;
}

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
