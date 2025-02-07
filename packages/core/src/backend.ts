/**
 * Backend Abstraction
 *
 * Defines the ChatBackend interface that both VS Code and CLI
 * implementations must satisfy. This is the core dependency-injection
 * boundary that keeps platform-specific code out of the shared server.
 */

import {
  ChatCompletionRequest,
  ChatCompletionChunk,
  ChatCompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
} from './types.js';

export interface ModelInfo {
  vendor: string;
  family: string;
  id?: string;
}

export interface Logger {
  log(message: string): void;
  error?(message: string): void;
}

export const consoleLogger: Logger = {
  log: (msg: string) => console.log(msg),
  error: (msg: string) => console.error(msg),
};

export interface ChatBackend {
  processChatRequest(
    request: ChatCompletionRequest
  ): Promise<AsyncIterable<ChatCompletionChunk> | ChatCompletionResponse>;

  getAvailableModels(): ModelInfo[] | Promise<ModelInfo[]>;

  /** Optional: compute embeddings (VS Code only) */
  processEmbeddingRequest?(request: EmbeddingRequest): Promise<EmbeddingResponse>;
}
