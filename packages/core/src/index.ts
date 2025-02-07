/**
 * @copilot-proxy/core
 *
 * Shared platform-independent logic for the Copilot Proxy.
 * Exports server factory, types, state management, assistants, and skills modules.
 */

// Backend abstraction
export { ChatBackend, ModelInfo, Logger, consoleLogger } from './backend.js';

// Server factory
export { createApp, startServer } from './server.js';

// Types
export * from './types.js';

// Utilities
export { generateId, errorResponse, notFoundError, createMessage, generateApiToken, setApiTokens, addApiToken, removeApiToken, authMiddleware } from './utils.js';

// Tool conversion (platform-independent)
export { assistantToolsToFunctionTools, responsesToolsToFunctionTools, toToolMode } from './toolConvert.js';

// Assistants module
export * from './assistants/index.js';

// Skills module
export * from './skills/index.js';
