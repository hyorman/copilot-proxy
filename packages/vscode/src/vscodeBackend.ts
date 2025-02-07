/**
 * VS Code Chat Backend
 *
 * Implements the ChatBackend interface from @copilot-proxy/core using
 * VS Code's Language Model API. This is the platform-specific bridge
 * that lets the shared server talk to VS Code's LLM providers.
 */

import * as vscode from 'vscode';
import {
  ChatBackend,
  Logger,
  ModelInfo,
  ChatCompletionRequest,
  ChatCompletionChunk,
  ChatCompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  StructuredMessageContent,
  ToolCall,
  ToolCallChunk,
} from '@copilot-proxy/core';
import { toVSCodeTools, toToolMode } from './toolConvert';

// Extended LanguageModelChat for optional id access
type LanguageModelChatWithId = vscode.LanguageModelChat & { id?: string };

function extractMessageContent(content: string | StructuredMessageContent[] | null | undefined): string {
  if (content === null || content === undefined) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map(item => item.text).join('\n');
  }
  return String(content);
}

export class VSCodeBackend implements ChatBackend {
  constructor(private logger: Logger) {}

  async getAvailableModels(): Promise<ModelInfo[]> {
    const chatInfos = await this.getAvailableChatModels();
    const embedInfos: ModelInfo[] = this.getAvailableEmbeddingModels().map(name => {
      const dotIndex = name.indexOf('.');
      const vendor = dotIndex !== -1 ? name.slice(0, dotIndex) : 'copilot';
      const family = dotIndex !== -1 ? name.slice(dotIndex + 1) : name;
      return { vendor, family };
    });

    const merged: ModelInfo[] = [...chatInfos];
    for (const embeddingModel of embedInfos) {
      if (!merged.find(model => model.family === embeddingModel.family)) {
        merged.push(embeddingModel);
      }
    }

    return merged;
  }

  async getAvailableChatModels(): Promise<ModelInfo[]> {
    const chatModels = await vscode.lm.selectChatModels({});
    return (chatModels || []).map(m => {
      const model = m as LanguageModelChatWithId;
      return {
        vendor: model.vendor,
        family: model.family,
        id: model.id,
      } as ModelInfo;
    });
  }

  getAvailableEmbeddingModels(): string[] {
    try {
      return vscode.lm.embeddingModels ?? [];
    } catch (error) {
      this.logger.log(`Embedding model enumeration unavailable: ${String(error)}`);
      return [];
    }
  }

  async processEmbeddingRequest(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const inputs = Array.isArray(request.input) ? request.input : [request.input];

    const embeddingModels = this.getAvailableEmbeddingModels();
    if (embeddingModels.length === 0) {
      throw new Error(
        'No embedding models available. The VS Code Embeddings API is a proposed API and may not be enabled. ' +
        'Ensure your VS Code version supports it and the extension has "embeddings" in enabledApiProposals.'
      );
    }

    let selectedModel = embeddingModels[0];
    if (request.model) {
      const match = embeddingModels.find(m => m === request.model || m.endsWith('.' + request.model));
      if (match) {
        selectedModel = match;
      }
    }

    const result: vscode.Embedding[] = await vscode.lm.computeEmbeddings(selectedModel, inputs);

    // Return the short name (without vendor prefix) to match the model listing
    const dotIndex = selectedModel.indexOf('.');
    const responseModelName = dotIndex !== -1 ? selectedModel.slice(dotIndex + 1) : selectedModel;

    const totalChars = inputs.reduce((sum, s) => sum + s.length, 0);
    const estimatedTokens = Math.ceil(totalChars / 4);

    const data = result.map((embedding, index) => ({
      object: 'embedding' as const,
      embedding: Array.from(embedding.values) as number[],
      index,
    }));

    return {
      object: 'list',
      data,
      model: responseModelName,
      usage: {
        prompt_tokens: estimatedTokens,
        total_tokens: estimatedTokens,
      },
    };
  }

  async processChatRequest(
    request: ChatCompletionRequest
  ): Promise<AsyncIterable<ChatCompletionChunk> | ChatCompletionResponse> {
    const userMessages = request.messages.filter(message => message.role.toLowerCase() === "user");
    const latestUserMessage = userMessages.length > 0 ? userMessages[userMessages.length - 1].content : '';
    const preview = typeof latestUserMessage === 'string'
      ? (latestUserMessage.length > 30 ? latestUserMessage.slice(0, 30) + '...' : latestUserMessage)
      : JSON.stringify(latestUserMessage);

    this.logger.log(`Request received. Model: ${request.model}. Preview: ${preview}`);
    this.logger.log(`Full messages: ${JSON.stringify(request.messages, null, 2)}`);

    // Extract system messages and combine their content
    const systemMessages = request.messages.filter(message => message.role.toLowerCase() === "system");
    const systemContent = systemMessages
      .map(msg => extractMessageContent(msg.content))
      .filter(content => content.length > 0)
      .join('\n\n');

    // Map request messages to vscode.LanguageModelChatMessage format
    // Prepend system content to the first user message (VS Code LM API has no SystemMessage)
    const chatMessages: vscode.LanguageModelChatMessage[] = [];
    let systemPrepended = false;

    for (const message of request.messages) {
      const role = message.role.toLowerCase();

      // Skip system messages as we'll prepend them to the first user message
      if (role === "system") {
        continue;
      }

      // Handle tool result messages
      if (role === 'tool' && message.tool_call_id) {
        const processedContent = extractMessageContent(message.content);
        const resultPart = new vscode.LanguageModelToolResultPart(
          message.tool_call_id,
          [new vscode.LanguageModelTextPart(processedContent)]
        );
        chatMessages.push(vscode.LanguageModelChatMessage.User([resultPart]));
        continue;
      }

      // Handle assistant messages with tool_calls
      if (role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
        const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
        const textContent = extractMessageContent(message.content);
        if (textContent) {
          parts.push(new vscode.LanguageModelTextPart(textContent));
        }
        for (const tc of message.tool_calls) {
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            args = {};
          }
          parts.push(new vscode.LanguageModelToolCallPart(tc.id, tc.function.name, args));
        }
        chatMessages.push(vscode.LanguageModelChatMessage.Assistant(parts));
        continue;
      }

      const processedContent = extractMessageContent(message.content);

      if (role === "user") {
        if (!systemPrepended && systemContent) {
          const combinedContent = `${systemContent}\n\n---\n\n${processedContent}`;
          chatMessages.push(vscode.LanguageModelChatMessage.User(combinedContent));
          systemPrepended = true;
        } else {
          chatMessages.push(vscode.LanguageModelChatMessage.User(processedContent));
        }
      } else {
        chatMessages.push(vscode.LanguageModelChatMessage.Assistant(processedContent));
      }
    }

    // If no user messages but we have system content, add it as a user message
    if (!systemPrepended && systemContent) {
      chatMessages.unshift(vscode.LanguageModelChatMessage.User(systemContent));
    }

    const [selectedModel] = await vscode.lm.selectChatModels({
      vendor: "copilot",
      family: request.model,
    });
    if (!selectedModel) {
      this.logger.log(`ERROR: No language model available for model: ${request.model}`);
      throw new Error(`No language model available for model: ${request.model}`);
    }

    // Build request options with native tool support
    const options: vscode.LanguageModelChatRequestOptions = {};
    if (request.tools?.length) {
      const toolMode = toToolMode(request.tool_choice);
      if (toolMode !== undefined) {
        options.tools = toVSCodeTools(request.tools);
        options.toolMode = toolMode;
      }
    }

    if (request.stream) {
      return this._streamingRequest(request, selectedModel, chatMessages, options);
    } else {
      return this._nonStreamingRequest(request, selectedModel, chatMessages, options);
    }
  }

  private async *_streamingRequest(
    request: ChatCompletionRequest,
    selectedModel: vscode.LanguageModelChat,
    chatMessages: vscode.LanguageModelChatMessage[],
    options: vscode.LanguageModelChatRequestOptions
  ): AsyncIterable<ChatCompletionChunk> {
    const cancellationSource = new vscode.CancellationTokenSource();
    try {
      const chatResponse = await selectedModel.sendRequest(
        chatMessages,
        options,
        cancellationSource.token
      );
      let firstChunk = true;
      let chunkIndex = 0;
      const accumulatedToolCalls: { callId: string; name: string; input: unknown }[] = [];

      for await (const part of chatResponse.stream) {
        if (part instanceof vscode.LanguageModelTextPart) {
          const chunk: ChatCompletionChunk = {
            id: `chatcmpl-stream-${chunkIndex}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: request.model,
            choices: [
              {
                delta: {
                  ...(firstChunk ? { role: "assistant" } : {}),
                  content: part.value,
                },
                index: 0,
                finish_reason: "",
              },
            ],
          };
          firstChunk = false;
          chunkIndex++;
          yield chunk;
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          accumulatedToolCalls.push({
            callId: part.callId,
            name: part.name,
            input: part.input,
          });
        }
      }

      if (accumulatedToolCalls.length > 0) {
        const toolCallChunks: ToolCallChunk[] = accumulatedToolCalls.map((tc, index) => ({
          index,
          id: tc.callId,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.input),
          },
        }));

        const toolCallsChunk: ChatCompletionChunk = {
          id: `chatcmpl-stream-${chunkIndex}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: request.model,
          choices: [
            {
              delta: {
                ...(firstChunk ? { role: "assistant" } : {}),
                tool_calls: toolCallChunks,
              },
              index: 0,
              finish_reason: "tool_calls",
            },
          ],
        };
        yield toolCallsChunk;
      } else {
        const finalChunk: ChatCompletionChunk = {
          id: `chatcmpl-stream-final`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: request.model,
          choices: [
            {
              delta: { content: "" },
              index: 0,
              finish_reason: "stop",
            },
          ],
        };
        yield finalChunk;
      }
    } catch (error) {
      this.logger.log("ERROR: Error in streaming mode:");
      if (error instanceof Error) {
        this.logger.log(`Message: ${error.message}`);
        this.logger.log(`Stack: ${error.stack}`);
      } else {
        this.logger.log(`Unknown error type: ${JSON.stringify(error)}`);
      }
      throw error;
    } finally {
      cancellationSource.dispose();
    }
  }

  private async _nonStreamingRequest(
    request: ChatCompletionRequest,
    selectedModel: vscode.LanguageModelChat,
    chatMessages: vscode.LanguageModelChatMessage[],
    options: vscode.LanguageModelChatRequestOptions
  ): Promise<ChatCompletionResponse> {
    const cancellationSource = new vscode.CancellationTokenSource();
    try {
      const chatResponse = await selectedModel.sendRequest(
        chatMessages,
        options,
        cancellationSource.token
      );
      let fullContent = "";
      const toolCalls: ToolCall[] = [];

      for await (const part of chatResponse.stream) {
        if (part instanceof vscode.LanguageModelTextPart) {
          fullContent += part.value;
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push({
            id: part.callId,
            type: 'function',
            function: {
              name: part.name,
              arguments: JSON.stringify(part.input),
            },
          });
        }
      }

      const hasToolCalls = toolCalls.length > 0;
      const completionTokens = Math.ceil(fullContent.length / 4);
      const response: ChatCompletionResponse = {
        id: `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: fullContent || null,
              refusal: null,
              annotations: [],
              ...(hasToolCalls ? { tool_calls: toolCalls } : {}),
            },
            logprobs: null,
            finish_reason: hasToolCalls ? "tool_calls" : "stop",
          },
        ],
        usage: {
          prompt_tokens: 0,
          completion_tokens: completionTokens,
          total_tokens: completionTokens,
          prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
        },
        service_tier: 'default',
        system_fingerprint: null,
      };
      return response;
    } catch (error) {
      this.logger.log("ERROR: Error in non-streaming mode:");
      if (error instanceof Error) {
        this.logger.log(`Message: ${error.message}`);
        this.logger.log(`Stack: ${error.stack}`);
      } else {
        this.logger.log(`Unknown error type: ${JSON.stringify(error)}`);
      }
      throw error;
    } finally {
      cancellationSource.dispose();
    }
  }
}
