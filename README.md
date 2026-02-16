# agent-coworker

Terminal-first "coworker" agent built on Bun + the Vercel AI SDK, with:
- a WebSocket agent server
- an OpenTUI + Solid.js TUI (default) — modeled after [opencode](https://github.com/anomalyco/opencode)'s design
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

Run the TUI standalone (connect to an existing server):
```bash
bun run tui -- --server ws://127.0.0.1:7337/ws
```

Run the legacy React-based TUI:
```bash
bun run start -- --legacy-tui
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

## TUI

The default interface is a terminal UI built with [OpenTUI](https://github.com/anthropics/opentui) + Solid.js, inspired by [opencode](https://github.com/anomalyco/opencode)'s design. It lives in `apps/TUI/`.

### Screens

**Home** — A centered prompt with the cowork logo, a random tip, and a footer showing provider/model info. Type a message and press Enter to start a session.

**Session** — The main workspace with:
- A header showing the active provider, model, and working directory
- A scrollable message feed with rendered markdown, tool calls, and reasoning
- An optional sidebar (toggle with `Ctrl+E`) showing context usage, MCP status, and todos
- A multi-line prompt at the bottom with autocomplete and history

### Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+K` | Open command palette |
| `Ctrl+N` | New session |
| `Ctrl+E` | Toggle sidebar |
| `Ctrl+C` | Clear input / exit |
| `Escape` | Cancel agent turn / dismiss dialog |
| `Ctrl+Shift+L` | Switch model |
| `Ctrl+X T` | Switch theme |
| `Ctrl+X S` | List sessions |
| `Ctrl+Z` | Stash current prompt |
| `Ctrl+Shift+Z` | Pop stashed prompt |
| `Ctrl+]` | Toggle shell mode |
| `Shift+Enter` | Insert newline in prompt |
| `Enter` | Submit prompt |
| `Up/Down` | Navigate prompt history |
| `PageUp/PageDown` | Scroll conversation |
| `?` | Show help / keybinding reference |

### Command Palette

Press `Ctrl+K` to open the command palette with fuzzy search. Commands are grouped into categories:

- **Session** — New session, reset, cancel turn, copy last response, export transcript
- **Display** — Toggle thinking, tool details, sidebar, timestamps
- **Prompt** — Stash/unstash prompt, view stash, toggle shell mode
- **System** — Switch model, switch theme, connect provider, MCP servers, help, status, exit

### Prompt Features

- **History** — `Up`/`Down` arrows cycle through previous prompts (persisted across sessions in `~/.cowork/state/prompt-history.jsonl`)
- **Autocomplete** — Type `@` for file completions, `/` for command completions (fuzzy matched)
- **Shell mode** — Start a message with `!` to run shell commands directly (e.g., `!ls -la`)
- **Stash** — `Ctrl+Z` saves the current prompt for later, `Ctrl+Shift+Z` restores it

### Themes

31 built-in themes. Switch with `Ctrl+X T` or the command palette. Your choice is persisted automatically. Themes include: opencode (default), catppuccin-mocha, catppuccin-latte, dracula, gruvbox, nord, one-dark, solarized, tokyonight, github, and more.

### Tool Renderers

The TUI renders tool calls with specialized views:
- **bash** — Shows `$ command`, output preview, and exit code
- **read/write/edit** — File path with colored diffs for edits
- **glob/grep** — Pattern and match count
- **web** — URL/query and summary
- **todo** — Inline todo list

### Architecture

The TUI uses Solid.js with 9 context providers stacked in `apps/TUI/index.tsx`:

```
ExitProvider → KVProvider → ThemeProvider → DialogProvider
→ SyncProvider → KeybindProvider → LocalProvider → RouteProvider
→ PromptProvider → App
```

- **SyncProvider** bridges the WebSocket (`AgentSocket`) to Solid.js reactive stores
- **DialogProvider** manages a stack of overlay dialogs
- **ThemeProvider** provides 60+ semantic color tokens to all components
- **KVProvider** persists UI preferences to `~/.cowork/config/tui-kv.json`

The TUI connects to the agent server over WebSocket — it never touches the agent or AI SDK directly. This follows the project's WebSocket-first architecture.

## WebSocket Protocol Notes

- Current protocol version is `2.0` (sent in `server_hello.protocolVersion`).
- `ping` now requires `sessionId`, and `pong.sessionId` echoes it.
- `error` events always include required `code` and `source`.
- `approval` events always include required `reasonCode`.
- Full message contract and migration details: `docs/websocket-protocol.md`.

## Configuration

Config precedence: built-in defaults < user < project < environment variables.

Environment variables:
- `AGENT_PROVIDER` (`google|openai|anthropic|codex-cli|claude-code`)
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
