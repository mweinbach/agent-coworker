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

Or use OAuth-capable community providers:
- Gemini CLI: install `@google/gemini-cli` and run `gemini` login flow
- Codex CLI: install `@openai/codex` and run `codex login`
- Claude Code: install `@anthropic-ai/claude-code` and run `claude login`

Run the TUI (starts the server automatically):
```bash
bun run start
# target a specific directory:
bun run start -- --dir /path/to/project
# bypass command approvals (dangerous):
bun run start -- --yolo
```

Run the CLI REPL:
```bash
bun run cli
# bypass command approvals (dangerous):
bun run cli -- --yolo
```

Run the server directly:
```bash
bun run serve
```

## WebSocket Protocol Notes

- Current protocol version is `2.0` (sent in `server_hello.protocolVersion`).
- `ping` now requires `sessionId`, and `pong.sessionId` echoes it.
- `error` events always include required `code` and `source`.
- `approval` events always include required `reasonCode`.
- Full message contract and migration details: `docs/websocket-protocol.md`.

## Configuration

Config precedence: built-in defaults < user < project < environment variables.

Environment variables:
- `AGENT_PROVIDER` (`google|openai|anthropic|gemini-cli|codex-cli|claude-code`)
- `AGENT_MODEL` (main model id)
- `AGENT_WORKING_DIR` (directory the agent should operate in)
- `AGENT_OUTPUT_DIR`, `AGENT_UPLOADS_DIR`
- `AGENT_USER_NAME`
- `AGENT_ENABLE_MCP` (`true|false`, defaults to `true`)
- `AGENT_OBSERVABILITY_ENABLED` (`true|false`, defaults to `false`)
- `AGENT_OBS_OTLP_HTTP` (OTLP HTTP endpoint)
- `AGENT_OBS_LOGS_URL`, `AGENT_OBS_METRICS_URL`, `AGENT_OBS_TRACES_URL` (query API base URLs)
- `AGENT_HARNESS_REPORT_ONLY` (`true|false`, defaults to `true`)
- `AGENT_HARNESS_STRICT_MODE` (`true|false`, defaults to `false`)

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

Harness + observability helpers:
```bash
bun run obs:up
bun run obs:status
bun run harness:smoke
bun run harness:run
bun run obs:down
```

Harness web portal (Next.js realtime dashboard):
```bash
bun run portal:dev
# build/start:
bun run portal:build
bun run portal:start
```

Full operational runbook:
- `docs/harness/runbook.md`
- `docs/harness/runbook.md` section `9.4 End-to-end: run in a target directory + watch live traces`
- `docs/harness/runbook.md` section `17. Next.js Web Portal (Realtime)`
- `docs/harness/runbook.md` section `18. GitHub CI In Testing Environment`
