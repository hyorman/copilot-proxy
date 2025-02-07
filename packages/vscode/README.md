# Copilot Proxy

OpenAI-compatible proxy server for GitHub Copilot, running inside VS Code. Use Copilot models through standard OpenAI API endpoints from any HTTP client.

> This project is not affiliated with GitHub, Microsoft, or OpenAI. It is intended for research, experimentation, and local prototyping rather than production use.

## Features

- Start and stop the local proxy server from inside VS Code.
- Configure the listening port through settings or a command.
- Forward chat requests with streaming and non-streaming support.
- Protect the proxy with locally stored API tokens.
- Expose OpenAI-compatible endpoints for models, chat completions, responses, embeddings, assistants, and skills.

## Installation

1. Download the latest `.vsix` package from the [GitHub Releases page](https://github.com/hyorman/copilot-proxy/releases).
2. Open Visual Studio Code.
3. Open the Extensions view (`Cmd+Shift+X` on macOS or `Ctrl+Shift+X` on Windows/Linux).
4. Open the extensions menu (`...`) and choose **Install from VSIX...**.
5. Select the downloaded `.vsix` file.
6. Reload VS Code if prompted.

## Configuration

The extension exposes one primary setting:

- `copilotProxy.port` — default: `3000`

You can change it either:

- in the VS Code Settings UI by searching for `Copilot Proxy`, or
- from the Command Palette with **Copilot Proxy: Configure Port**.

## Starting and stopping the server

- **Start:** Run **Copilot Proxy: Start Server** from the Command Palette. The server starts on the configured port.
- **Stop:** Run **Copilot Proxy: Stop Server** from the Command Palette.

### Permission prompt

On the first model request, VS Code may ask you to grant permission for this extension to access the Language Model API. Accept the prompt so requests can complete successfully.

## Token management

The extension includes token management commands so you can lock down your local proxy.

1. Create a token with **Copilot Proxy: Create API Token**.
2. List saved tokens with **Copilot Proxy: List API Tokens**.
3. Remove a token with **Copilot Proxy: Remove API Token**.

Tokens are stored in VS Code global state and reused across sessions.

### Token auth usage

When at least one token exists, requests must include a bearer token in the `Authorization` header:

```bash
curl -H "Authorization: Bearer cpx_your_token_here" \
     -H "Content-Type: application/json" \
     -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "Hello"}]}' \
     http://localhost:3000/v1/chat/completions
```

If no tokens have been created, authentication is disabled and the server accepts requests without token validation.

## Models and embeddings

The proxy exposes OpenAI-compatible model discovery at `/v1/models`.

### List models

`GET /v1/models` returns all available models (chat and embedding).

```bash
curl http://localhost:3000/v1/models
```

### Embeddings endpoint

The proxy also exposes `POST /v1/embeddings` and forwards requests to the VS Code embeddings API:

```bash
curl -X POST http://localhost:3000/v1/embeddings \
  -H "Authorization: Bearer cpx_your_token_here" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "text-embedding-3-small",
    "input": "hello world"
  }'
```

If `model` is omitted, the proxy uses the first embedding model reported by VS Code.

### Proposed API caveat

Embedding support depends on the VS Code **Embeddings** proposed API. That means chat completions can work while embedding discovery and `/v1/embeddings` do not.

This repository already declares the proposal in `package.json` via `enabledApiProposals`, but the runtime extension you have loaded must also include that manifest entry.

If `GET /v1/models` returns no embedding entries, or `POST /v1/embeddings` returns a `501` error, check the following:

1. You are running the latest build of this extension, not an older installed VSIX.
2. VS Code has been reloaded after installing or rebuilding the extension.
3. Your VS Code build supports the embeddings proposal.
4. If your setup requires it, start VS Code with:

```bash
code --enable-proposed-api hyorman.copilot-proxy
```

When the proposal is unavailable, the proxy degrades gracefully:

- `GET /v1/models` still lists chat models.
- `POST /v1/embeddings` returns a clear error instead of a generic server failure.

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/models` | List available models |
| `POST` | `/v1/chat/completions` | Chat completions (streaming + non-streaming) |
| `POST` | `/v1/responses` | Model responses |
| `POST` | `/v1/embeddings` | Embeddings |
| — | `/v1/assistants/...` | Assistants API |
| — | `/v1/skills/...` | Skills API |

See the [main repository](https://github.com/hyorman/copilot-proxy) for full Skills API and Assistants API documentation.

## License

MIT
