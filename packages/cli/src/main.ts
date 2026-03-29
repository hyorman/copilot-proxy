#!/usr/bin/env node
/**
 * CLI Entry Point
 *
 * Initializes CopilotClient via SDK backend, restores persisted state,
 * and starts the Express server.
 *
 * Environment variables:
 *   PORT          - Server port (default: 3000)
 *   API_TOKENS    - Comma-separated bearer tokens for auth
 *   GITHUB_TOKEN  - GitHub token for SDK authentication
 *   DATA_DIR      - Directory for state persistence (default: ~/.copilot-sdk-proxy)
 *   CLI_PATH      - Path to Copilot CLI executable
 *   CLI_URL       - URL of existing CLI server to connect to
 */
try { process.loadEnvFile(); } catch {}

import { resolve } from 'path';
import { homedir } from 'os';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import {
  startServer,
  consoleLogger,
  setApiTokens,
  generateApiToken,
  SerializedState,
  SerializedSkillsState,
  state as assistantsState,
  skillsState,
  setSkillStorageDir,
} from '@hyorman/copilot-proxy-core';
import { SdkBackend } from './sdkBackend.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const API_TOKENS = process.env.API_TOKENS?.split(',').filter(Boolean) ?? [];
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const DATA_DIR = process.env.DATA_DIR ?? resolve(homedir(), '.copilot-sdk-proxy');
const CLI_PATH = process.env.CLI_PATH;
const CLI_URL = process.env.CLI_URL;

const ASSISTANTS_STATE_FILE = resolve(DATA_DIR, 'assistants-state.json');
const SKILLS_STATE_FILE = resolve(DATA_DIR, 'skills-state.json');
const SKILLS_STORAGE_DIR = resolve(DATA_DIR, 'skills');
const TOKENS_FILE = resolve(DATA_DIR, 'api-tokens.json');

interface TokenInfo {
  token: string;
  name: string;
  createdAt: number;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadJsonFile<T>(path: string): T | null {
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf-8');
      return JSON.parse(raw) as T;
    }
  } catch (err) {
    console.warn(`Failed to load ${path}:`, err);
  }
  return null;
}

function saveJsonFile(path: string, data: unknown): void {
  try {
    writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.warn(`Failed to save ${path}:`, err);
  }
}

function loadTokens(): TokenInfo[] {
  return loadJsonFile<TokenInfo[]>(TOKENS_FILE) ?? [];
}

function saveTokens(tokens: TokenInfo[]): void {
  saveJsonFile(TOKENS_FILE, tokens);
}

function getNodeMajorVersion(version: string = process.versions.node): number {
  const [major = '0'] = version.split('.');
  return Number.parseInt(major, 10) || 0;
}

function handleTokenCommand(args: string[]): void {
  ensureDir(DATA_DIR);
  const subcommand = args[0];

  if (subcommand === 'create') {
    const name = args[1] || `token-${Date.now()}`;
    const token = generateApiToken();
    const tokens = loadTokens();
    tokens.push({ token, name, createdAt: Math.floor(Date.now() / 1000) });
    saveTokens(tokens);
    console.log(`Created token "${name}":`);
    console.log(`  ${token}`);
    console.log('\nAdd to API_TOKENS env var or use as Bearer token.');
  } else if (subcommand === 'list') {
    const tokens = loadTokens();
    if (tokens.length === 0) {
      console.log('No tokens stored. Create one with: copilot-proxy token create [name]');
      return;
    }
    console.log(`${tokens.length} token(s):\n`);
    for (const t of tokens) {
      const date = new Date(t.createdAt * 1000).toISOString().split('T')[0];
      console.log(`  ${t.name}  ${t.token.slice(0, 12)}...  (created ${date})`);
    }
  } else if (subcommand === 'remove') {
    const target = args[1];
    if (!target) {
      console.error('Usage: copilot-proxy token remove <name-or-token>');
      process.exit(1);
    }
    const tokens = loadTokens();
    const filtered = tokens.filter(t => t.name !== target && t.token !== target);
    if (filtered.length === tokens.length) {
      console.error(`No token found matching "${target}".`);
      process.exit(1);
    }
    saveTokens(filtered);
    console.log(`Removed ${tokens.length - filtered.length} token(s).`);
  } else {
    console.error(`Unknown token subcommand: ${subcommand}`);
    console.error('Usage: copilot-proxy token <create|list|remove>');
    process.exit(1);
  }
}

async function main(): Promise<void> {
  console.log('copilot-sdk-proxy starting...');
  console.log(`  Data directory: ${DATA_DIR}`);
  console.log(`  Port: ${PORT}`);
  // Load persisted tokens and merge with env var tokens
  ensureDir(DATA_DIR);
  const persistedTokens = loadTokens();
  const allTokenValues = [...new Set([...API_TOKENS, ...persistedTokens.map(t => t.token)])];
  console.log(`  Auth: ${allTokenValues.length > 0 ? `${allTokenValues.length} token(s)` : 'disabled'}`);

  // Ensure directories exist
  ensureDir(SKILLS_STORAGE_DIR);

  // Set skill storage directory
  setSkillStorageDir(SKILLS_STORAGE_DIR);

  // Restore assistants state
  const savedAssistantsState = loadJsonFile<SerializedState>(ASSISTANTS_STATE_FILE);
  if (savedAssistantsState) {
    try {
      assistantsState.restore(savedAssistantsState);
      console.log('Restored assistants state from disk.');
    } catch (err) {
      console.warn('Failed to restore assistants state:', err);
    }
  }

  // Set up assistants state persistence
  assistantsState.setPersistCallback((data) => {
    saveJsonFile(ASSISTANTS_STATE_FILE, data);
  }, 1000);

  // Restore skills state
  const savedSkillsState = loadJsonFile<SerializedSkillsState>(SKILLS_STATE_FILE);
  if (savedSkillsState) {
    try {
      skillsState.restore(savedSkillsState);
      console.log('Restored skills state from disk.');
    } catch (err) {
      console.warn('Failed to restore skills state:', err);
    }
  }

  // Set up skills state persistence
  skillsState.setPersistCallback((data) => {
    saveJsonFile(SKILLS_STATE_FILE, data);
  }, 1000);

  // Initialize the SDK backend
  const backend = new SdkBackend(consoleLogger);
  try {
    await backend.init({
      githubToken: GITHUB_TOKEN,
      cliPath: CLI_PATH,
      cliUrl: CLI_URL,
    });
  } catch (err) {
    console.error('Failed to initialize CopilotClient:', err);
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('node:sqlite') && getNodeMajorVersion() < 22) {
      console.error('Hint: install and run the CLI with Node 22+ for bundled Copilot CLI support.');
    }
    process.exit(1);
  }

  // Start Express server
  const server = startServer(backend, consoleLogger, PORT, allTokenValues);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    server.close();
    await backend.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const command = process.argv[2];

if (command === 'token') {
  handleTokenCommand(process.argv.slice(3));
} else {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
