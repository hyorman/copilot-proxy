# Copilot Proxy

## Overview

Copilot Proxy is a Visual Studio Code extension that exposes the VS Code Language Model API through an OpenAI-compatible Express server. This project is intended for research, experimentation, and local prototyping rather than production use.

> This project is not affiliated with GitHub, Microsoft, or OpenAI.

Current GitHub Copilot model availability depends on your subscription and the VS Code Language Model API.

## Acknowledgements

This repository is a rebranded and maintained fork of the original [`copilot-proxy`](https://github.com/lutzleonhardt/copilot-proxy) project by [Lutz Leonhardt](https://github.com/lutzleonhardt).

Special thanks to Lutz Leonhardt for creating the original project and publishing it under the MIT License, which made this fork, rebranding, and continued maintenance possible.



## Features

- Start and stop the local proxy server from inside VS Code.
- Configure the listening port through settings or a command.
- Forward chat requests with streaming and non-streaming support.
- Protect the proxy with locally stored API tokens.
- Expose OpenAI-compatible endpoints for models, chat completions, responses, and related assistant routes.

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

## API token authentication

The extension includes token management commands so you can lock down your local proxy.

### Manage tokens

1. Create a token with **Copilot Proxy: Create API Token**.
2. List saved tokens with **Copilot Proxy: List API Tokens**.
3. Remove a token with **Copilot Proxy: Remove API Token**.

Tokens are stored in VS Code global state and reused across sessions.

### Use tokens in requests

When at least one token exists, requests must include a bearer token in the `Authorization` header:

```bash
curl -H "Authorization: Bearer cpx_your_token_here" \
     -H "Content-Type: application/json" \
     -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "Hello"}]}' \
     http://localhost:3000/v1/chat/completions
```

If no tokens have been created, authentication is disabled and the server accepts requests without token validation.

## Using the extension

### Start the server

- Run **Copilot Proxy: Start Server** from the Command Palette.
- The server starts on the configured port, which defaults to `3000`.

### Stop the server

- Run **Copilot Proxy: Stop Server** from the Command Palette.

### Permission prompt

On the first model request, VS Code may ask you to grant permission for this extension to access the Language Model API. Accept the prompt so requests can complete successfully.

## Models and embeddings

The proxy exposes OpenAI-style model discovery at `/v1/models`.

### List models

- `GET /v1/models` returns all chat models plus any embedding models exposed by VS Code.
- `GET /v1/models?type=chat` returns only chat-capable models.
- `GET /v1/models?type=embedding` returns only embedding models.

Example requests:

```bash
curl http://localhost:3000/v1/models
```

```bash
curl http://localhost:3000/v1/models?type=chat
```

```bash
curl http://localhost:3000/v1/models?type=embedding
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

If `GET /v1/models?type=embedding` returns an empty list, or `POST /v1/embeddings` returns a `501` error, check the following:

1. You are running the latest build of this extension, not an older installed VSIX.
2. VS Code has been reloaded after installing or rebuilding the extension.
3. Your VS Code build supports the embeddings proposal.
4. If your setup requires it, start VS Code with:

```bash
code --enable-proposed-api hyorman.copilot-proxy
```

When the proposal is unavailable, the proxy degrades gracefully:

- `GET /v1/models` still lists chat models.
- `GET /v1/models?type=embedding` returns no embedding entries.
- `POST /v1/embeddings` returns a clear error instead of a generic server failure.

## License

This repository is distributed under the MIT License. The upstream copyright notice is retained as required by the license.

## Skills API

The extension exposes an OpenAI-compatible Skills API at `/v1/skills`. Skills are versioned file bundles anchored by a `SKILL.md` manifest.

### Skill bundle format

Every bundle must include exactly one `SKILL.md` file with YAML frontmatter:

```markdown
---
name: My Skill
description: One-line summary of the skill
---

Detailed instructions for the agent go here.
```

Additional files (code, data, configs) can be included alongside the manifest.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/skills` | Create a skill from multipart or zip upload |
| `GET` | `/v1/skills` | List skills (paginated) |
| `GET` | `/v1/skills/:id` | Retrieve a skill |
| `POST` | `/v1/skills/:id` | Update default version or metadata |
| `DELETE` | `/v1/skills/:id` | Delete a skill and its files |
| `POST` | `/v1/skills/:id/versions` | Upload a new version |

### Create a skill

```bash
curl -X POST http://localhost:3000/v1/skills \
  -H "Authorization: Bearer cpx_your_token" \
  -F "files[]=@SKILL.md" \
  -F "files[]=@helper.py"
```

Or upload a zip archive:

```bash
curl -X POST http://localhost:3000/v1/skills \
  -H "Authorization: Bearer cpx_your_token" \
  -F "files=@my-skill.zip"
```

### Upload a new version

```bash
curl -X POST http://localhost:3000/v1/skills/skill_abc123/versions \
  -H "Authorization: Bearer cpx_your_token" \
  -F "files[]=@SKILL.md" \
  -F "files[]=@updated_helper.py"
```

### Update default version

```bash
curl -X POST http://localhost:3000/v1/skills/skill_abc123 \
  -H "Authorization: Bearer cpx_your_token" \
  -H "Content-Type: application/json" \
  -d '{"default_version": 2}'
```

### Using skills with the Responses API

Attach skills to a `/v1/responses` request via the `skills` field. You can use registered skill references or inline skills.

**Skill reference** (uses a skill registered via `/v1/skills`):

```bash
curl -X POST http://localhost:3000/v1/responses \
  -H "Authorization: Bearer cpx_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "input": "Write a Python function to sort a list.",
    "skills": [
      { "type": "skill_reference", "skill_id": "skill_abc123" }
    ]
  }'
```

**Specific version**:

```json
{ "type": "skill_reference", "skill_id": "skill_abc123", "version": 2 }
```

**Inline skill** (base64-encoded content, no registration required):

```bash
curl -X POST http://localhost:3000/v1/responses \
  -H "Authorization: Bearer cpx_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "input": "Refactor this code.",
    "skills": [
      {
        "type": "inline",
        "name": "Code Style",
        "description": "Enforce coding standards",
        "source": {
          "type": "base64",
          "media_type": "text/markdown",
          "data": "QWx3YXlzIHVzZSBUeXBlU2NyaXB0IHN0cmljdCBtb2Rl"
        }
      }
    ]
  }'
```

### Using skills with the Assistants API

Skills can be attached to assistants and runs. When a run executes, skill instructions are resolved and injected into the system prompt alongside the assistant's instructions.

#### Attach skills to an assistant

```bash
curl -X POST http://localhost:3000/v1/assistants \
  -H "Authorization: Bearer cpx_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "name": "My Coding Assistant",
    "instructions": "You are a helpful coding assistant.",
    "skills": [
      { "type": "skill_reference", "skill_id": "skill_abc123" }
    ]
  }'
```

#### Override skills on a run

Skills specified on a run override the assistant's skills for that run:

```bash
curl -X POST http://localhost:3000/v1/threads/thread_abc123/runs \
  -H "Authorization: Bearer cpx_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "assistant_id": "asst_abc123",
    "skills": [
      { "type": "skill_reference", "skill_id": "skill_xyz789", "version": "latest" }
    ]
  }'
```

If no skills are specified on the run, the assistant's skills are used. If the run specifies an empty `skills` array, no skills are injected.

#### Skills in thread-and-run creation

```bash
curl -X POST http://localhost:3000/v1/threads/runs \
  -H "Authorization: Bearer cpx_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "assistant_id": "asst_abc123",
    "thread": {
      "messages": [{ "role": "user", "content": "Help me write tests." }]
    },
    "skills": [
      { "type": "skill_reference", "skill_id": "skill_abc123" },
      {
        "type": "inline",
        "name": "Test Style",
        "description": "Testing conventions",
        "source": {
          "type": "base64",
          "media_type": "text/markdown",
          "data": "VXNlIGRlc2NyaWJlL2l0IGJsb2NrcyB3aXRoIHZpdGVzdA=="
        }
      }
    ]
  }'
```

#### Update assistant skills

```bash
curl -X POST http://localhost:3000/v1/assistants/asst_abc123 \
  -H "Authorization: Bearer cpx_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "skills": [
      { "type": "skill_reference", "skill_id": "skill_new456" }
    ]
  }'
```

