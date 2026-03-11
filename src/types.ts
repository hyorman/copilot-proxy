export interface StructuredMessageContent {
  type: string;
  text: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | StructuredMessageContent[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  model: string;
  stream?: boolean;
  // Future extensibility for tool calling
  tools?: FunctionTool[];
  tool_choice?: 'none' | 'auto' | { type: 'function'; function: { name: string } };
  // Additional OpenAI parameters (accepted but may not be fully supported)
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  user?: string;
}

// ==================== Tool/Function Calling (Future) ====================

export interface FunctionTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

// ==================== Legacy Completions API ====================

export interface CompletionRequest {
  model: string;
  prompt: string | string[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  n?: number;
  stream?: boolean;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  user?: string;
}

export interface CompletionChoice {
  index: number;
  text: string;
  finish_reason: string;
  logprobs: null;
}

export interface CompletionResponse {
  id: string;
  object: 'text_completion';
  created: number;
  model: string;
  choices: CompletionChoice[];
  usage: ChatCompletionUsage;
}

// ==================== Embeddings API ====================

export interface EmbeddingRequest {
  input: string | string[];
  model: string;
  encoding_format?: 'float' | 'base64';
  dimensions?: number;
  user?: string;
}

export interface EmbeddingObject {
  object: 'embedding';
  embedding: number[];
  index: number;
}

export interface EmbeddingResponse {
  object: 'list';
  data: EmbeddingObject[];
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

// ==================== Models API ====================

export interface ModelObject {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

export interface ModelsListResponse {
  object: 'list';
  data: ModelObject[];
}

// ==================== Error Response ====================

export interface OpenAIErrorResponse {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: ChatCompletionUsage;
  service_tier: string | null;
  system_fingerprint: string | null;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatCompletionMessage;
  logprobs: object | null;
  finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | null;
}

export interface ChatCompletionMessage {
  role: 'assistant';
  content: string | null;
  refusal?: string | null;
  annotations?: unknown[];
  tool_calls?: ToolCall[];
}

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens: number;
    audio_tokens: number;
  };
  completion_tokens_details?: {
    reasoning_tokens: number;
    audio_tokens: number;
    accepted_prediction_tokens: number;
    rejected_prediction_tokens: number;
  };
}

export interface ChatCompletionChunkDelta {
  role?: string;
  content?: string | null;
  tool_calls?: ToolCallChunk[];
}

export interface ToolCallChunk {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface ChatCompletionChunkChoice {
  delta: ChatCompletionChunkDelta;
  index: number;
  finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | '' | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
}

// ==================== Responses API ====================

export interface ResponseInputItem {
  type?: 'message';
  role: 'user' | 'assistant' | 'system';
  content: string | ResponseContentItem[];
}

export interface ResponseContentItem {
  type: 'input_text' | 'output_text';
  text: string;
}

export interface CreateResponseRequest {
  model: string;
  input: string | ResponseInputItem[];
  instructions?: string;
  stream?: boolean;
  temperature?: number;
  max_output_tokens?: number;
  top_p?: number;
  store?: boolean;
  metadata?: Record<string, string>;
  tools?: FunctionTool[] | any[];
  tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; name: string };
  previous_response_id?: string;
  parallel_tool_calls?: boolean;
  user?: string;
  /** Skill attachments — resolved and injected as additional instructions */
  skills?: import('./skills/types').SkillAttachment[];
}

export interface ResponseOutputItem {
  type: 'message';
  id: string;
  status: 'completed' | 'in_progress' | 'failed';
  role: 'assistant';
  content: ResponseOutputContent[];
}

export interface ResponseOutputContent {
  type: 'output_text';
  text: string;
  annotations: unknown[];
}

export interface ResponseObject {
  id: string;
  object: 'response';
  created_at: number;
  status: 'completed' | 'failed' | 'in_progress' | 'cancelled' | 'queued' | 'incomplete';
  background: boolean;
  completed_at: number | null;
  conversation: { id: string } | null;
  error: { message: string; type: string; code: string } | null;
  incomplete_details: { reason: string } | null;
  instructions: string | null;
  max_output_tokens: number | null;
  max_tool_calls: number | null;
  model: string;
  output: ResponseOutputItemUnion[];
  output_text: string;
  parallel_tool_calls: boolean;
  previous_response_id: string | null;
  reasoning: { effort: string | null; generate_summary: string | null; summary: string | null } | null;
  service_tier: string | null;
  temperature: number;
  text: { format: { type: string } } | null;
  tool_choice: 'none' | 'auto' | 'required' | { type: 'function'; name: string } | string;
  tools: unknown[];
  top_p: number;
  truncation: 'auto' | 'disabled';
  usage: {
    input_tokens: number;
    input_tokens_details: { cached_tokens: number };
    output_tokens: number;
    output_tokens_details: { reasoning_tokens: number };
    total_tokens: number;
  } | null;
  user: string | null;
  metadata: Record<string, string>;
}

// ==================== Responses API Tool Calling ====================

export interface ResponseFunctionCallItem {
  type: 'function_call';
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  status: 'completed' | 'in_progress';
}

export interface ResponseFunctionCallOutputItem {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

export type ResponseOutputItemUnion = ResponseOutputItem | ResponseFunctionCallItem;
