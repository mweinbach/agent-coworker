# agent-coworker

Terminal-first “coworker” agent built on Bun + the Vercel AI SDK, with:
- a WebSocket agent server
- an OpenTUI + React client (default)
- a plain CLI REPL
- a built-in toolbelt for file/code/web tasks (with command approval for risky ops)

## Quickstart

Prereqs: Bun installed.

```bash
bun install
```

Set an API key for the provider you want:
- Google Gemini: `GOOGLE_GENERATIVE_AI_API_KEY`
- OpenAI: `OPENAI_API_KEY`
- Anthropic: `ANTHROPIC_API_KEY`

Run the TUI (starts the server automatically):
```bash
bun run start
# target a specific directory:
bun run start -- --dir /path/to/project
```

Run the CLI REPL:
```bash
bun run cli
```

Run the server directly:
```bash
bun run serve
```

## Configuration

Config precedence: built-in defaults < user < project < environment variables.

Environment variables:
- `AGENT_PROVIDER` (`google|openai|anthropic`)
- `AGENT_MODEL` (main model id)
- `AGENT_WORKING_DIR` (directory the agent should operate in)
- `AGENT_OUTPUT_DIR`, `AGENT_UPLOADS_DIR`
- `AGENT_USER_NAME`
- `AGENT_ENABLE_MCP` (`true|false`, defaults to `true`)

Config files (optional):
- `./.agent/config.json` (project)
- `~/.agent/config.json` (user)

Example `./.agent/config.json`:
```json
{
  "provider": "openai",
  "model": "gpt-5.2",
  "subAgentModel": "gpt-5.2",
  "userName": "Max"
}
```

## MCP (Remote Tool Servers)

MCP (Model Context Protocol) servers add extra tools to the agent at runtime.

Server configs are loaded from (highest priority first):
- `./.agent/mcp-servers.json` (project)
- `~/.agent/mcp-servers.json` (user)
- `./config/mcp-servers.json` (built-in defaults)

Example `./.agent/mcp-servers.json` using `mcp.grep.app`:
```json
{
  "servers": [
    {
      "name": "grep",
      "transport": { "type": "http", "url": "https://mcp.grep.app" }
    }
  ]
}
```

Tools are namespaced as `mcp__{serverName}__{toolName}` (e.g. `mcp__grep__searchGitHub`).

## Development

Run tests:
```bash
bun test
```

Watch mode:
```bash
bun run dev
```
