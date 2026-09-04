# Model Context Protocol (MCP) Guide

## Overview
The Model Context Protocol (MCP) provides a standardized way for agent-coworker to discover, communicate with, and utilize external tools and context providers. By integrating an MCP server, you can seamlessly extend the agent's capabilities—allowing it to access custom data sources, specialized APIs, or internal tools without modifying the core agent codebase. MCP acts as the bridge that dynamically exposes new tools and capabilities to the model at runtime.

## Configuration Layering
To provide maximum flexibility across different environments and projects, agent-coworker resolves MCP server configurations using a multi-layered approach. The configuration is merged in the following order (from highest to lowest precedence):

1. **Workspace (`.cowork/mcp-servers.json`)**: Project-specific configurations. This is ideal for tools that are only relevant to the current repository.
2. **User (`~/.cowork/config/mcp-servers.json`)**: Global configurations for the current user. Useful for developer-specific tools or personal access tokens that should be available across all projects.
3. **Built-in (`config/mcp-servers.json`)**: Default servers bundled with the agent-coworker installation.

Legacy `.agent/mcp-servers.json` files are not runtime fallback layers. Run `cowork migrate-agent-config` once to merge old workspace and user MCP configs into the canonical `.cowork` paths.

*Note: If the same server key is defined in multiple layers, the configuration from the higher-precedence layer will override the lower ones.*

### Workspace stdio trust gate

Because `.cowork/mcp-servers.json` is part of a repository, an untrusted (e.g. freshly cloned) workspace must not be able to launch local commands just by opening it or starting a turn. A **`stdio`** server defined in the **workspace** layer therefore does **not** auto-start unless the workspace is explicitly trusted. Trust is resolved only from non-workspace sources — it cannot be granted by the workspace's own config:

- set `"trustWorkspaceMcp": true` in `~/.cowork/config/config.json` (user-level), or
- set the `AGENT_TRUST_WORKSPACE_MCP=1` environment variable.

Until then, workspace servers using any transport are skipped (with a `[MCP] Not auto-starting …` log line); user/built-in/plugin servers continue to load. Explicitly validating a server (`cowork/mcp/server/validate`) is treated as per-command approval and may launch the workspace's own `stdio` server for that one test.

## Server Configuration Schema
Workspace, user, and built-in `mcp-servers.json` files share one schema: a top-level `servers` array where each entry names the server and describes its transport and (optional) auth.

### Example Schema (`mcp-servers.json`)
```json
{
  "servers": [
    {
      "name": "my-stdio-server",
      "transport": {
        "type": "stdio",
        "command": "node",
        "args": ["/path/to/server.js"],
        "env": { "DEBUG": "1" }
      },
      "enabled": true,
      "auth": { "type": "none" }
    },
    {
      "name": "my-http-server",
      "transport": {
        "type": "http",
        "url": "https://api.example.com/mcp",
        "headers": { "x-tenant": "team-a" }
      },
      "auth": { "type": "api_key", "headerName": "authorization", "prefix": "Bearer " }
    }
  ]
}
```

- **`transport.type`**: `stdio` (local process; requires `command`, optional `args`/`env`/`cwd`) or `http`/`sse` (remote; requires `url`, optional `headers`).
- **`auth.type`**: `none`, `api_key` (optional `headerName`, `prefix`, `keyId`), or `oauth` (optional `scope`, `resource`, `oauthMode: "auto" | "code"`).
- **`enabled`**: Optional boolean. Omitted or `true` means the server is available to agent turns; `false` keeps the server configured and visible in management UIs but skips loading its tools.
- **`required`**, **`retries`**, **`icon`**: Optional operational metadata.

### Plugin-provided servers (`.mcp.json`)
Plugins bundle MCP servers with a different, Claude-compatible shape: a top-level `mcpServers` object keyed by server name. Plugin servers merge in after the workspace/user/system layers and are skipped on name collision, so custom servers always win. Custom servers configured directly in `mcp-servers.json` do not require a plugin or skill.

## Authentication Flows
For MCP servers that require secure access, agent-coworker supports standard authentication flows such as API Keys and OAuth.

- **API Key**: The user provides a static key which is passed to the server via headers or environment variables during initialization.
- **OAuth**: The agent facilitates the OAuth dance, redirecting the user to authenticate and then storing the resulting access/refresh tokens.

**Secure Storage:** 
Credentials are NEVER stored in the plain text configuration files. Once authenticated, credentials and tokens are securely saved in `.cowork/auth/mcp-credentials.json`. This file should be heavily restricted and is automatically added to the project's `.gitignore` to prevent accidental commits.

## Desktop UI & WebSocket Integration
All MCP management is built on top of the JSON-RPC WebSocket protocol, ensuring that the CLI, TUI, and Desktop UI remain thin clients.

Clients call JSON-RPC methods to manage MCP configurations (see `docs/websocket-protocol.md` for full request/response shapes):

- **`cowork/mcp/servers/read`**: Lists the effective merged server set plus per-layer config-file diagnostics.
- **`cowork/mcp/server/upsert`**: Adds or updates a server. Accepts `source: "workspace" | "user"` to pick the target layer, so both project-scoped and personal (all-projects) custom servers are supported.
- **`cowork/mcp/server/delete`**: Removes a server from the given editable layer.
- **`cowork/mcp/server/setEnabled`**: Toggles whether a configured server is loaded for future agent turns without deleting its configuration. Workspace and user servers update their owning `mcp-servers.json`; plugin servers update plugin override state; built-in system servers are read-only.
- **`cowork/mcp/server/validate`**: Tests the connection to an MCP server. The server attempts to initialize the transport and perform a handshake, returning a success or failure event to the UI.
- **`cowork/mcp/server/auth/authorize`**, **`cowork/mcp/server/auth/callback`**, **`cowork/mcp/server/auth/setApiKey`**: Drive the OAuth and API-key credential flows.

This WebSocket-first approach ensures that any UI client can configure and validate MCP servers using the exact same underlying logic.

## Deferred tool search and live connections

MCP-enabled turns expose two stable harness tools instead of every server's full schema:

- `toolSearch({ query, limit?, offset? })` searches the current catalog by name or capability. It returns names, descriptions, and input schemas for up to five matches by default (maximum 20). Use `nextOffset` to page through results, or `query: "*"` to browse.
- `mcpCall({ name, arguments })` invokes an exact `mcp__{serverName}__{toolName}` name with arguments matching its discovered schema. Names learned earlier in a conversation remain usable while the tool is available.

These tools stay present even when no servers are connected. Each search and call re-reads the effective server configuration and credentials, so existing sessions, including turns already running, can use servers added, enabled, or authenticated afterward. Workspace changes apply to that workspace; user-level changes apply to each workspace subject to its effective layering and trust settings. Disabled or removed tools are no longer callable, and calls to replaced servers use the current connection. If a tool's schema changes, search again before retrying with new arguments.

The workspace catalog owns transport connections separately from model turns. Unchanged servers reuse their connections when another server changes. Replaced connections remain alive only until outstanding tool calls finish, then close. Closing the final session releases that workspace's connections. Transient connection failures are retried after a 30-second backoff; changing a server's configuration or credentials causes an immediate reload.

Discovery and execution both apply workspace trust, per-server enablement, role filtering, and profile `allowedMcpServers` restrictions. Calls use the original MCP tool ID for the mutation gate and preserve MCP content, metadata, and errors. The same search/call interface works across provider runtimes, including Codex app-server dynamic tools, without changing schemas during an in-progress provider turn.

MCP configuration, validation, and authentication can run while a model turn is active. They use a separate MCP operation lock and do not alter provider-connection state. The session-level `enableMcp` setting still changes between turns; a turn started with MCP disabled does not gain the search/call interface mid-turn.

## Troubleshooting
If an MCP tool isn't showing up or is failing validation, follow these steps to diagnose the issue:

1. **Check Configuration Syntax**: Ensure your `mcp-servers.json` is valid JSON. A trailing comma or missing quote will prevent the file from parsing.
2. **Validate the Transport**:
   - For `stdio`: Verify that the `command` is available in your system's PATH and that the `args` point to the correct file. Run the command manually in your terminal to see if the process starts or crashes immediately.
   - For `http`: Ensure the URL is reachable from your machine and that no firewalls or proxies are blocking the request.
3. **Inspect WebSocket Logs**: Run the agent server in debug mode or check the local observability stack (Vector/Victoria). Look for the response to the `mcp_server_validate` event. The server will emit detailed error messages if the handshake fails.
4. **Verify Authentication**: If the server requires authentication, check `.cowork/auth/mcp-credentials.json` to ensure valid tokens exist for that server. If an API key expired, you may need to re-authenticate or clear the entry from the credentials file to force a new prompt.
5. **Check Layer Overrides**: If your changes aren't taking effect, verify that a higher-precedence configuration file isn't overriding your target configuration.
