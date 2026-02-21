# Model Context Protocol (MCP) Guide

## Overview
The Model Context Protocol (MCP) provides a standardized way for agent-coworker to discover, communicate with, and utilize external tools and context providers. By integrating an MCP server, you can seamlessly extend the agent's capabilities—allowing it to access custom data sources, specialized APIs, or internal tools without modifying the core agent codebase. MCP acts as the bridge that dynamically exposes new tools and capabilities to the model at runtime.

## Configuration Layering
To provide maximum flexibility across different environments and projects, agent-coworker resolves MCP server configurations using a multi-layered approach. The configuration is merged in the following order (from highest to lowest precedence):

1. **Workspace (`.cowork/mcp-servers.json`)**: Project-specific configurations. This is ideal for tools that are only relevant to the current repository.
2. **User (`~/.cowork/config/mcp-servers.json`)**: Global configurations for the current user. Useful for developer-specific tools or personal access tokens that should be available across all projects.
3. **Built-in (`config/mcp-servers.json`)**: Default servers bundled with the agent-coworker installation.
4. **Legacy Fallback (`.agent/mcp-servers.json`)**: Supported for backward compatibility with older agent configurations.

*Note: If the same server key is defined in multiple layers, the configuration from the higher-precedence layer will override the lower ones.*

## Server Configuration Schema
Each MCP server entry in the configuration file must specify how the agent should connect to it. The basic schema includes defining the `transport` mechanism and the command or URL required to initialize the connection.

### Example Schema
```json
{
  "mcpServers": {
    "my-stdio-server": {
      "command": "node",
      "args": ["/path/to/server.js"],
      "transport": "stdio",
      "auth": "none"
    },
    "my-http-server": {
      "url": "https://api.example.com/mcp",
      "transport": "http",
      "auth": "apiKey"
    }
  }
}
```

- **`transport`**: Defines the communication channel. Typically `stdio` for local processes or `http`/`sse` for remote services.
- **`command`** & **`args`**: Used exclusively with `stdio` transports to spawn the local server process.
- **`url`**: Used with `http` transports to specify the endpoint.
- **`auth`**: Indicates the required authentication mode (e.g., `none`, `apiKey`, `oauth`).

## Authentication Flows
For MCP servers that require secure access, agent-coworker supports standard authentication flows such as API Keys and OAuth.

- **API Key**: The user provides a static key which is passed to the server via headers or environment variables during initialization.
- **OAuth**: The agent facilitates the OAuth dance, redirecting the user to authenticate and then storing the resulting access/refresh tokens.

**Secure Storage:** 
Credentials are NEVER stored in the plain text configuration files. Once authenticated, credentials and tokens are securely saved in `.cowork/auth/mcp-credentials.json`. This file should be heavily restricted and is automatically added to the project's `.gitignore` to prevent accidental commits.

## Desktop UI & WebSocket Integration
All MCP management is built on top of the core WebSocket protocol, ensuring that the CLI, TUI, and Desktop UI remain thin clients.

When interacting with the Desktop UI or the TUI, the clients send specific `ClientMessage` events to the server to manage MCP configurations:

- **`mcp_server_upsert`**: Sent by the client to add a new MCP server or update an existing configuration. The core server handles writing this to the appropriate configuration layer (usually Workspace or User).
- **`mcp_server_validate`**: Triggered to test the connection to an MCP server. The server attempts to initialize the transport and perform a handshake, returning a success or failure event to the UI.

This WebSocket-first approach ensures that any UI client can configure and validate MCP servers using the exact same underlying logic.

## Troubleshooting
If an MCP tool isn't showing up or is failing validation, follow these steps to diagnose the issue:

1. **Check Configuration Syntax**: Ensure your `mcp-servers.json` is valid JSON. A trailing comma or missing quote will prevent the file from parsing.
2. **Validate the Transport**:
   - For `stdio`: Verify that the `command` is available in your system's PATH and that the `args` point to the correct file. Run the command manually in your terminal to see if the process starts or crashes immediately.
   - For `http`: Ensure the URL is reachable from your machine and that no firewalls or proxies are blocking the request.
3. **Inspect WebSocket Logs**: Run the agent server in debug mode or check the local observability stack (Vector/Victoria). Look for the response to the `mcp_server_validate` event. The server will emit detailed error messages if the handshake fails.
4. **Verify Authentication**: If the server requires authentication, check `.cowork/auth/mcp-credentials.json` to ensure valid tokens exist for that server. If an API key expired, you may need to re-authenticate or clear the entry from the credentials file to force a new prompt.
5. **Check Layer Overrides**: If your changes aren't taking effect, verify that a higher-precedence configuration file isn't overriding your target configuration.