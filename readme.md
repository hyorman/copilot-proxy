# Copilot Proxy

OpenAI-compatible proxy server for GitHub Copilot. Use Copilot models through standard OpenAI API endpoints from any HTTP client.

| | **CLI** | **VS Code Extension** |
|---|---|---|
| **Best for** | Headless / server / CI use | Local prototyping inside VS Code |
| **Backend** | `@github/copilot-sdk` | VS Code Language Model API |
| **Auth** | `GITHUB_TOKEN` env var | VS Code Copilot session |
| **Embeddings** | Not supported | Supported (proposed API) |
| **Install** | `npx @copilot-proxy/cli` | [`.vsix` package](https://github.com/hyorman/copilot-proxy/releases) |
| **Docs** | [CLI README](packages/cli/README.md) | [Extension README](packages/vscode/README.md) |

> This project is not affiliated with GitHub, Microsoft, or OpenAI. It is intended for research, experimentation, and local prototyping rather than production use.

## Acknowledgements

This project was originally inspired by [`copilot-proxy`](https://github.com/lutzleonhardt/copilot-proxy) by [Lutz Leonhardt](https://github.com/lutzleonhardt). Thanks to Lutz for publishing the original idea under the MIT License.

## Quick Start

### CLI

```bash
export GITHUB_TOKEN=ghp_...
npx @copilot-proxy/cli
```

### VS Code Extension

1. Install the `.vsix` from [Releases](https://github.com/hyorman/copilot-proxy/releases).
2. Run **Copilot Proxy: Start Server** from the Command Palette.

### Test it

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "Hello!"}]}'
```

## API Endpoints

Both modes expose these OpenAI-compatible endpoints:

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/models` | List available models |
| `POST` | `/v1/chat/completions` | Chat completions (streaming + non-streaming) |
| `POST` | `/v1/responses` | Model responses |
| `POST` | `/v1/embeddings` | Embeddings (VS Code only) |
| — | `/v1/assistants/...` | Assistants API |
| — | `/v1/skills/...` | Skills API |

See the [CLI README](packages/cli/README.md) or [Extension README](packages/vscode/README.md) for detailed API docs.

## Skills API

The proxy exposes an OpenAI-compatible Skills API at `/v1/skills`. Skills are versioned file bundles anchored by a `SKILL.md` manifest.

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
|---|---|---|
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

**Attach skills to an assistant:**

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

**Override skills on a run:**

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

**Skills in thread-and-run creation:**

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

**Update assistant skills:**

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

## Development

### Project structure

| Package | Path | Description |
|---|---|---|
| `@copilot-proxy/core` | `packages/core` | Shared server logic, OpenAI-compatible routes, types |
| `@copilot-proxy/cli` | `packages/cli` | CLI proxy server using `@github/copilot-sdk` |
| `copilot-proxy` | `packages/vscode` | VS Code extension |

### Build

```bash
npm install
npm run build
```

### Test

```bash
npm test
```

### Package & Publish

```bash
npm run package:vscode    # Package VS Code extension
npm run publish:core      # Publish core to npm
npm run publish:cli       # Publish CLI to npm
```

## License

MIT
