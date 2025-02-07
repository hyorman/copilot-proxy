/**
 * In-Memory State Management for Assistants API
 *
 * Stores assistants, threads, messages, runs, and run steps in memory.
 * Supports persistence via callbacks for VS Code globalState integration.
 *
 * Features:
 * - Debounced auto-save on mutations
 * - Run steps tracking
 * - Serialization/deserialization for persistence
 */

import {
  Assistant,
  Thread,
  Message,
  Run,
  RunStep,
  PaginationParams,
  OpenAIListResponse,
  ToolCall
} from './types.js';
import { generateId } from '../utils.js';

// Context saved when a run requires tool outputs
export interface PendingToolContext {
  runId: string;
  threadId: string;
  toolCalls: ToolCall[];
  partialContent: string; // Text generated before tool calls
  stepId: string;         // The tool_calls step ID
}

// Persistence callback type
type PersistCallback = (data: SerializedState) => void;

// Serialized state structure
export interface SerializedState {
  assistants: [string, Assistant][];
  threads: [string, Thread][];
  messages: [string, Message[]][];
  runs: [string, Run[]][];
  runSteps: [string, RunStep[]][];
}

class AssistantsState {
  private assistants: Map<string, Assistant> = new Map();
  private threads: Map<string, Thread> = new Map();
  private messages: Map<string, Message[]> = new Map();  // thread_id -> messages
  private runs: Map<string, Run[]> = new Map();          // thread_id -> runs
  private runSteps: Map<string, RunStep[]> = new Map();  // run_id -> steps
  private pendingToolContexts: Map<string, PendingToolContext> = new Map(); // run_id -> context

  // Persistence
  private persistCallback: PersistCallback | null = null;
  private persistDebounceTimer: NodeJS.Timeout | null = null;
  private persistDebounceMs = 1000; // 1 second debounce

  // ==================== Persistence ====================

  /**
   * Set callback for persisting state changes
   * Called with debounced delay after mutations
   */
  setPersistCallback(callback: PersistCallback | null, debounceMs = 1000): void {
    this.persistCallback = callback;
    this.persistDebounceMs = debounceMs;
  }

  private triggerPersist(): void {
    if (!this.persistCallback) return;

    // Clear existing timer
    if (this.persistDebounceTimer) {
      clearTimeout(this.persistDebounceTimer);
    }

    // Set new debounced timer
    this.persistDebounceTimer = setTimeout(() => {
      if (this.persistCallback) {
        this.persistCallback(this.serialize());
      }
    }, this.persistDebounceMs);
  }

  // ==================== ID Generators ====================

  generateAssistantId(): string { return generateId('asst'); }
  generateThreadId(): string { return generateId('thread'); }
  generateMessageId(): string { return generateId('msg'); }
  generateRunId(): string { return generateId('run'); }
  generateStepId(): string { return generateId('step'); }

  // ==================== Assistants ====================

  createAssistant(assistant: Assistant): void {
    this.assistants.set(assistant.id, assistant);
    this.triggerPersist();
  }

  getAssistant(id: string): Assistant | undefined {
    return this.assistants.get(id);
  }

  listAssistants(params?: PaginationParams): OpenAIListResponse<Assistant> {
    let assistants = Array.from(this.assistants.values());

    // Sort by created_at
    const order = params?.order ?? 'desc';
    assistants.sort((a, b) =>
      order === 'desc' ? b.created_at - a.created_at : a.created_at - b.created_at
    );

    // Apply cursor-based pagination
    if (params?.after) {
      const afterIndex = assistants.findIndex(a => a.id === params.after);
      if (afterIndex !== -1) {
        assistants = assistants.slice(afterIndex + 1);
      }
    }
    if (params?.before) {
      const beforeIndex = assistants.findIndex(a => a.id === params.before);
      if (beforeIndex !== -1) {
        assistants = assistants.slice(0, beforeIndex);
      }
    }

    const limit = Math.min(params?.limit ?? 20, 100);
    const hasMore = assistants.length > limit;
    assistants = assistants.slice(0, limit);

    return {
      object: 'list',
      data: assistants,
      first_id: assistants[0]?.id ?? null,
      last_id: assistants[assistants.length - 1]?.id ?? null,
      has_more: hasMore
    };
  }

  updateAssistant(id: string, updates: Partial<Assistant>): Assistant | undefined {
    const existing = this.assistants.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...updates, id: existing.id }; // Prevent ID change
    this.assistants.set(id, updated);
    this.triggerPersist();
    return updated;
  }

  deleteAssistant(id: string): boolean {
    const result = this.assistants.delete(id);
    if (result) this.triggerPersist();
    return result;
  }

  // ==================== Threads ====================

  createThread(thread: Thread): void {
    this.threads.set(thread.id, thread);
    this.messages.set(thread.id, []);
    this.runs.set(thread.id, []);
    this.triggerPersist();
  }

  getThread(id: string): Thread | undefined {
    return this.threads.get(id);
  }

  updateThread(id: string, updates: Partial<Thread>): Thread | undefined {
    const existing = this.threads.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...updates, id: existing.id };
    this.threads.set(id, updated);
    this.triggerPersist();
    return updated;
  }

  deleteThread(id: string): boolean {
    // Also clean up run steps for runs in this thread
    const threadRuns = this.runs.get(id) || [];
    for (const run of threadRuns) {
      this.runSteps.delete(run.id);
    }
    this.messages.delete(id);
    this.runs.delete(id);
    const result = this.threads.delete(id);
    if (result) this.triggerPersist();
    return result;
  }

  // ==================== Messages ====================

  addMessage(threadId: string, message: Message): void {
    const threadMessages = this.messages.get(threadId) || [];
    threadMessages.push(message);
    this.messages.set(threadId, threadMessages);
    this.triggerPersist();
  }

  getMessages(threadId: string, params?: PaginationParams & { run_id?: string }): OpenAIListResponse<Message> {
    let messages = this.messages.get(threadId) || [];

    // Filter by run_id if specified
    if (params?.run_id) {
      messages = messages.filter(m => m.run_id === params.run_id);
    }

    // Sort by created_at
    const order = params?.order ?? 'desc';
    messages = [...messages].sort((a, b) =>
      order === 'desc' ? b.created_at - a.created_at : a.created_at - b.created_at
    );

    // Apply cursor-based pagination
    if (params?.after) {
      const afterIndex = messages.findIndex(m => m.id === params.after);
      if (afterIndex !== -1) {
        messages = messages.slice(afterIndex + 1);
      }
    }
    if (params?.before) {
      const beforeIndex = messages.findIndex(m => m.id === params.before);
      if (beforeIndex !== -1) {
        messages = messages.slice(0, beforeIndex);
      }
    }

    const limit = Math.min(params?.limit ?? 20, 100);
    const hasMore = messages.length > limit;
    messages = messages.slice(0, limit);

    return {
      object: 'list',
      data: messages,
      first_id: messages[0]?.id ?? null,
      last_id: messages[messages.length - 1]?.id ?? null,
      has_more: hasMore
    };
  }

  getMessage(threadId: string, messageId: string): Message | undefined {
    const messages = this.messages.get(threadId) || [];
    return messages.find(m => m.id === messageId);
  }

  updateMessage(threadId: string, messageId: string, updates: Partial<Message>): Message | undefined {
    const messages = this.messages.get(threadId);
    if (!messages) return undefined;
    const index = messages.findIndex(m => m.id === messageId);
    if (index === -1) return undefined;
    messages[index] = { ...messages[index], ...updates, id: messages[index].id };
    this.triggerPersist();
    return messages[index];
  }

  deleteMessage(threadId: string, messageId: string): boolean {
    const messages = this.messages.get(threadId);
    if (!messages) return false;
    const index = messages.findIndex(m => m.id === messageId);
    if (index === -1) return false;
    messages.splice(index, 1);
    this.triggerPersist();
    return true;
  }

  // ==================== Runs ====================

  addRun(threadId: string, run: Run): void {
    const threadRuns = this.runs.get(threadId) || [];
    threadRuns.push(run);
    this.runs.set(threadId, threadRuns);
    this.runSteps.set(run.id, []); // Initialize steps for this run
    this.triggerPersist();
  }

  getRuns(threadId: string, params?: PaginationParams): OpenAIListResponse<Run> {
    let runs = this.runs.get(threadId) || [];

    // Sort by created_at
    const order = params?.order ?? 'desc';
    runs = [...runs].sort((a, b) =>
      order === 'desc' ? b.created_at - a.created_at : a.created_at - b.created_at
    );

    // Apply cursor-based pagination
    if (params?.after) {
      const afterIndex = runs.findIndex(r => r.id === params.after);
      if (afterIndex !== -1) {
        runs = runs.slice(afterIndex + 1);
      }
    }
    if (params?.before) {
      const beforeIndex = runs.findIndex(r => r.id === params.before);
      if (beforeIndex !== -1) {
        runs = runs.slice(0, beforeIndex);
      }
    }

    const limit = Math.min(params?.limit ?? 20, 100);
    const hasMore = runs.length > limit;
    runs = runs.slice(0, limit);

    return {
      object: 'list',
      data: runs,
      first_id: runs[0]?.id ?? null,
      last_id: runs[runs.length - 1]?.id ?? null,
      has_more: hasMore
    };
  }

  getRun(threadId: string, runId: string): Run | undefined {
    const runs = this.runs.get(threadId) || [];
    return runs.find(r => r.id === runId);
  }

  updateRun(threadId: string, runId: string, updates: Partial<Run>): Run | undefined {
    const runs = this.runs.get(threadId);
    if (!runs) return undefined;
    const index = runs.findIndex(r => r.id === runId);
    if (index === -1) return undefined;
    runs[index] = { ...runs[index], ...updates, id: runs[index].id };
    this.triggerPersist();
    return runs[index];
  }

  // ==================== Run Steps ====================

  addRunStep(runId: string, step: RunStep): void {
    const steps = this.runSteps.get(runId) || [];
    steps.push(step);
    this.runSteps.set(runId, steps);
    this.triggerPersist();
  }

  getRunSteps(runId: string, params?: PaginationParams): OpenAIListResponse<RunStep> {
    let steps = this.runSteps.get(runId) || [];

    // Sort by created_at
    const order = params?.order ?? 'desc';
    steps = [...steps].sort((a, b) =>
      order === 'desc' ? b.created_at - a.created_at : a.created_at - b.created_at
    );

    // Apply cursor-based pagination
    if (params?.after) {
      const afterIndex = steps.findIndex(s => s.id === params.after);
      if (afterIndex !== -1) {
        steps = steps.slice(afterIndex + 1);
      }
    }
    if (params?.before) {
      const beforeIndex = steps.findIndex(s => s.id === params.before);
      if (beforeIndex !== -1) {
        steps = steps.slice(0, beforeIndex);
      }
    }

    const limit = Math.min(params?.limit ?? 20, 100);
    const hasMore = steps.length > limit;
    steps = steps.slice(0, limit);

    return {
      object: 'list',
      data: steps,
      first_id: steps[0]?.id ?? null,
      last_id: steps[steps.length - 1]?.id ?? null,
      has_more: hasMore
    };
  }

  getRunStep(runId: string, stepId: string): RunStep | undefined {
    const steps = this.runSteps.get(runId) || [];
    return steps.find(s => s.id === stepId);
  }

  updateRunStep(runId: string, stepId: string, updates: Partial<RunStep>): RunStep | undefined {
    const steps = this.runSteps.get(runId);
    if (!steps) return undefined;
    const index = steps.findIndex(s => s.id === stepId);
    if (index === -1) return undefined;
    steps[index] = { ...steps[index], ...updates, id: steps[index].id };
    this.triggerPersist();
    return steps[index];
  }

  // ==================== Pending Tool Contexts ====================

  setPendingToolContext(runId: string, context: PendingToolContext): void {
    this.pendingToolContexts.set(runId, context);
    // Note: We don't persist pending contexts as they're transient
  }

  getPendingToolContext(runId: string): PendingToolContext | undefined {
    return this.pendingToolContexts.get(runId);
  }

  deletePendingToolContext(runId: string): boolean {
    return this.pendingToolContexts.delete(runId);
  }

  // ==================== Utility ====================

  clear(): void {
    this.assistants.clear();
    this.threads.clear();
    this.messages.clear();
    this.runs.clear();
    this.runSteps.clear();
    this.pendingToolContexts.clear();
    this.triggerPersist();
  }

  serialize(): SerializedState {
    return {
      assistants: Array.from(this.assistants.entries()),
      threads: Array.from(this.threads.entries()),
      messages: Array.from(this.messages.entries()),
      runs: Array.from(this.runs.entries()),
      runSteps: Array.from(this.runSteps.entries())
    };
  }

  restore(data: Partial<SerializedState>): void {
    if (data.assistants) this.assistants = new Map(data.assistants);
    if (data.threads) this.threads = new Map(data.threads);
    if (data.messages) this.messages = new Map(data.messages);
    if (data.runs) this.runs = new Map(data.runs);
    if (data.runSteps) this.runSteps = new Map(data.runSteps);
  }
}

// Singleton export
export const state = new AssistantsState();
