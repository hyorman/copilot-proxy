# Copilot Proxy

## Overview

Copilot Proxy is a Visual Studio Code extension that exposes the VS Code Language Model API via an Express server. This experimental extension is intended solely for research and prototyping purposes and should not be used in production environments.

[![Watch the video](https://img.youtube.com/vi/i1I2CAPOXHM/maxresdefault.jpg)](https://youtu.be/i1I2CAPOXHM)
[YouTube Explanation](https://youtu.be/i1I2CAPOXHM)

**Disclaimer:**
This extension is provided as an experiment only. In the past, some users, i.e., cline users, faced bans due to excessive usage. Since Microsoft introduced rate limits to the VS Code LM, no further bans have been reported. Nevertheless, I do not recommend using this extension for anything beyond research and prototyping.

At the moment, the supported LLMs by GitHub Copilot are: "gpt-4o", "gpt-4o-mini", "o1", "o1-mini", "claude-3.5-sonnet", and "o3-mini".

## Features

- **Server Management:** Easily start and stop the Express server from within VS Code.
- **Customizable Port:** Configure the port the server uses through VS Code settings or via an interactive command.
- **Language Model Integration:** Relay chat-based requests and responses with support for both streaming and non-streaming modes.

## Installation

1. **Download the VSIX Package:**
  - Visit the [GitHub Releases](https://github.com/lutzleonhardt/copilot-proxy/releases) page.
  - Download the latest `.vsix` file.

2. **Install the Extension:**
  - Open Visual Studio Code.
  - Go to the Extensions view (`Ctrl+Shift+X` on Windows/Linux or `Cmd+Shift+X` on macOS).
  - Click on the three-dot menu (`...`) and choose **"Install from VSIX..."**.
  - Select the downloaded `.vsix` file.

3. **Reload VS Code:**
  - Accept the prompt to reload the window and activate the extension.

## Configuration

The extension provides a configuration setting to specify the port for the Express server:

- **Setting:** `copilotProxy.port`
  **Default:** `3000`

You can change this setting in two ways:
- **Via Settings UI:** Open the VS Code Settings (`Ctrl+,` or `Cmd+,`) and search for "Copilot Proxy".
- **Via Command Palette:** Run the command **"Copilot Proxy: Configure Port"** to interactively set the port.

### API Token Authentication

The extension provides API token management commands to secure your proxy server. Tokens are securely stored and persist across sessions.

**Managing API Tokens:**

1. **Create a Token:**
   - Run **"Copilot Proxy: Create API Token"** from the Command Palette
   - Enter a name for the token (e.g., "aider", "production")
   - The token will be generated and displayed
   - Copy the token immediately - you'll need it for client requests

2. **List Tokens:**
   - Run **"Copilot Proxy: List API Tokens"** to view all created tokens
   - Token details are shown in the Copilot Proxy Log

3. **Remove a Token:**
   - Run **"Copilot Proxy: Remove API Token"**
   - Select the token to remove from the list
   - Confirm the removal

**Using Tokens in Requests:**

When API tokens exist, all requests to the server must include a valid token in the `Authorization` header:

```bash
curl -H "Authorization: Bearer cpx_your_token_here" \
     -H "Content-Type: application/json" \
     -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "Hello"}]}' \
     http://localhost:3000/v1/chat/completions
```

**Important:** If no tokens are created, authentication is disabled and the server accepts all requests. Create at least one token to enable authentication.

## Using the Extension

### Starting the Server

- Open the Command Palette and run **"Copilot Proxy: Start Server"**.
- The server will start on the configured port (default is `3000`), and a notification will confirm the port.

### Stopping the Server

- Open the Command Palette and run **"Copilot Proxy - Stop Server"** to shut down the server.

### Permission Prompt

On the initial request (e.g., when using Aider or other AI assistants), VS Code will prompt you to grant permission for the extension to interact with the VS Code Language Model API. Please grant permission to ensure proper operation.

### Usage in aider

You need to configure aider to use the proxy server for the chosen models which are supported by GitHub Copilot.
These are at the moment: "gpt-4o", "gpt-4o-mini", "o1", "o1-mini", "claude-3.5-sonnet", and "o3-mini" (also depending on your subscription).
To make this work, you need to create a file `.aider.model.settings.yml` in your home directory or in one of the other supported locations. (see [Configuration file locations](https://aider.chat/docs/config/adv-model-settings.html))

The content of the file should look like this:

```yaml
# "claude-3-5-sonnet-20241022" is the model name used in aider
# "openai/claude-3.5-sonnet"
# => "openai" tells LiteLLM to call an OpenAI-like endpoint
# => "claude-3.5-sonnet" matches the copilot model name
- name: claude-3-5-sonnet-20241022
  extra_params:
    model: openai/claude-3.5-sonnet
    api_key: n/a
    api_base: http://localhost:3000/v1


# "openrouter/anthropic/claude-3.5-sonnet" is the model name used in aider
# "openai/claude-3.5-sonnet"
# => "openai" tells LiteLLM to call an OpenAI-like endpoint
# => "claude-3.5-sonnet" matches the copilot model name
- name: openrouter/anthropic/claude-3.5-sonnet
  extra_params:
    model: openai/claude-3.5-sonnet
    api_key: n/a
    api_base: http://localhost:3000/v1

# "o3-mini" is the model name in aider
# "o3-mini" is already a OpenAI-like API and o3-mini is also matching the name in copilot
- name: o3-mini
  extra_params:
    api_key: n/a
    api_base: http://localhost:3000/v1

# this config is using the copilot LM for ALL models in aider
# BUT this only works for OpenAI-like models and when the name in aider/LiteLLM matches the name in copilot
# so this is mainly working for all supported openai models like GPT-4o, o1, o3-mini
- name: aider/extra_params
  extra_params:
    api_key: n/a
    api_base: http://localhost:3000/v1
```

**Using with API Token Authentication:**

If you have created API tokens (recommended for security), replace `n/a` with your actual token in all `api_key` fields. To create a token, run **"Copilot Proxy: Create API Token"** from the VS Code Command Palette.

Example with authentication:

```yaml
- name: claude-3-5-sonnet-20241022
  extra_params:
    model: openai/claude-3.5-sonnet
    api_key: cpx_abc123def456...  # Your actual token from Create API Token command
    api_base: http://localhost:3000/v1
```

If no tokens are created, authentication is disabled and you can use `n/a` or any value.


## Contributing

Contributions, bug reports, and feature requests are welcome! Please submit issues or pull requests in the [GitHub repository](https://github.com/yourusername/copilot-proxy).

## License

This project is licensed under the MIT License.

