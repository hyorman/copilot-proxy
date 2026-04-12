# @hyorman/copilot-proxy-cli

OpenAI-compatible proxy server for GitHub Copilot. Use Copilot models through standard OpenAI API endpoints from any HTTP client.

> This project is not affiliated with GitHub, Microsoft, or OpenAI. It is intended for research, experimentation, and local prototyping rather than production use.

## Quick Start

```bash
npx @hyorman/copilot-proxy-cli
```

If `GITHUB_TOKEN` is unset, the CLI falls back to the Copilot SDK's device code flow on first run.

Test it:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "Hello!"}]}'
```

## Installation

**Run without installing (recommended):**

```bash
npx @hyorman/copilot-proxy-cli
```

**Install globally:**

```bash
npm install -g @hyorman/copilot-proxy-cli
copilot-proxy
```

**From source:**

```bash
git clone https://github.com/hyorman/copilot-proxy.git
cd copilot-proxy
npm install && npm run build
node packages/cli/out/main.js
```

## Configuration

### Environment variables

| Variable | Description | Default |
| --- | --- | --- |
| `GITHUB_TOKEN` | GitHub personal access token with Copilot access (optional) | — |
| `PORT` | Server listening port | `3000` |
| `API_TOKENS` | Comma-separated bearer tokens for request authentication | — |
| `DATA_DIR` | Directory for persisted state (tokens, assistants, skills) | `~/.copilot-sdk-proxy` |
| `CLI_PATH` | Path to Copilot CLI executable | — |
| `CLI_URL` | URL of an existing CLI server to connect to | — |

### `.env` file support

The CLI automatically loads a `.env` file from the working directory via Node's `process.loadEnvFile()` on supported runtimes. Create a `.env` file to avoid exporting variables each time:

```env
GITHUB_TOKEN=ghp_...
PORT=3001
API_TOKENS=my-secret-token-1,my-secret-token-2
```

If `GITHUB_TOKEN` is omitted, the CLI will prompt for device code authentication when the SDK needs to sign in.

## Token management

The CLI includes subcommands for managing persistent API tokens. Tokens are stored in `DATA_DIR` (default `~/.copilot-sdk-proxy/api-tokens.json`).

**Create a token:**

```bash
copilot-proxy token create my-token
```

**List tokens:**

```bash
copilot-proxy token list
```

**Remove a token:**

```bash
copilot-proxy token remove my-token
```

When both `API_TOKENS` env var and persisted tokens exist, they are merged. If no tokens are configured at all, authentication is disabled and the server accepts all requests.

## API Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/v1/models` | List available models |
| `POST` | `/v1/chat/completions` | Chat completions (streaming + non-streaming) |
| `POST` | `/v1/responses` | Model responses |
| — | `/v1/assistants/...` | Assistants API |
| — | `/v1/skills/...` | Skills API |

## Usage Examples

### Chat completion

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer cpx_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

### Streaming

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer cpx_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

## Requirements

- Node.js 22+
- A GitHub account with Copilot access

## License

MIT

---

See the [main repository](https://github.com/hyorman/copilot-proxy) for full documentation including the Skills API and Assistants API.
