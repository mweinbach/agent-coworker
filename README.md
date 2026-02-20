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

## Developer Onboarding & Architecture

agent-coworker is built on a **WebSocket-first** architecture. This ensures that the core agent logic is entirely decoupled from any user interface.

- **Business Logic:** All agent coordination, tool execution, LLM communication, and session state are centralized in the server (primarily within `src/server/session.ts` and `src/agent.ts`).
- **Thin Clients:** User interfaces (like the TUI, CLI, Desktop app, or Portal) are strictly thin clients. They never touch the AI SDK or execute built-in tools directly. Instead, they consume `ServerEvent`s and send `ClientMessage`s over the WebSocket connection.
- **WebSocket Protocol:** If you want to build a custom client, alternate UI, or extend the existing ones, the full communication contract is documented in `docs/websocket-protocol.md`. This is the source of truth for interacting with the agent server.

## Built-in Tools

The agent is equipped with a powerful set of built-in tools designed for interacting with your environment and codebase:

- **bash**: Execute terminal commands (includes safety approvals for risky operations).
- **glob**: Fast file pattern matching to explore codebases.
- **grep**: Regex-based content search across files.
- **read**: Read file contents or list directory contents.
- **write**: Create or overwrite files.
- **edit**: Perform exact string replacements in existing files.
- **webSearch**: Search the web for information.
- **webFetch**: Fetch and convert web pages to Markdown.
- **todoWrite**: Manage an inline task list for complex, multi-step workflows.
- **spawnAgent**: Launch specialized sub-agents to execute tasks in parallel.
- **ask**: Prompt the user for clarification, decisions, or input.
- **skill**: Dynamically load specialized domain knowledge (see Skills below).
- **notebookEdit**: Edit and interact with Jupyter notebooks.
- **memory**: Store and retrieve long-term context across different sessions.

## Skills

Skills are specialized instructional bundles that teach the agent how to perform specific tasks, use certain frameworks, or follow domain-specific best practices. 

- **How they work:** When the agent recognizes a task it needs help with, it uses the `skill` tool to dynamically load the relevant skill's instructions into its context window.
- **Where they live:** Skills can be global (living in the `skills/` directory) or project-local (living in `.agent/skills/` within your workspace).
- **Structure:** A skill is defined by a `SKILL.md` file. This file must contain YAML frontmatter (defining the skill's `name` and `description`) followed by a Markdown body containing the actual instructions, rules, workflows, and context the agent needs to succeed.

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

### TUI Architecture

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

The TUI adheres strictly to the WebSocket-first architecture by connecting to the agent server over WebSocket and never touching the agent directly.

## Electron Automation (agent-browser skill)

If you added the `agent-browser` skill in `./.agent/skills/agent-browser`, you can use it to drive the desktop app UI.

1. Start the desktop app in dev mode (enables CDP on port `9222` by default):
```bash
bun run desktop:dev
```

2. In another terminal, run browser actions via the desktop wrapper:
```bash
bun run desktop:browser -- snapshot -i
bun run desktop:browser -- click @e2
bun run desktop:browser -- screenshot tmp/desktop.png
```

3. Keep the ref-based loop from the skill:
- `snapshot -i` to get refs
- interact with `@eN`
- re-snapshot after page/UI changes

## Configuration

Config precedence: built-in defaults < user < project < environment variables.

Environment variables:
- `AGENT_PROVIDER` (`google|openai|anthropic|codex-cli|claude-code`)
- `AGENT_MODEL` (main model id)
- `AGENT_WORKING_DIR` (directory the agent should operate in)
- `AGENT_OUTPUT_DIR`, `AGENT_UPLOADS_DIR`
- `AGENT_USER_NAME`
- `AGENT_ENABLE_MCP` (`true|false`, defaults to `true`)
- `AGENT_OBSERVABILITY_ENABLED` (`true|false`, defaults to `true`)
- `LANGFUSE_PUBLIC_KEY`
- `LANGFUSE_SECRET_KEY`
- `LANGFUSE_BASE_URL` (defaults to `https://cloud.langfuse.com`)
- `LANGFUSE_TRACING_ENVIRONMENT`
- `LANGFUSE_RELEASE`
- `AGENT_HARNESS_REPORT_ONLY` (`true|false`, defaults to `true`)
- `AGENT_HARNESS_STRICT_MODE` (`true|false`, defaults to `false`)

Langfuse behavior:
- When enabled and configured, lifecycle telemetry plus AI SDK model-call traces are exported through the Langfuse OpenTelemetry processor.
- AI SDK telemetry records inputs/outputs (`recordInputs=true`, `recordOutputs=true`) for full LLM I/O trace visibility.
- Export/runtime failures are non-fatal; health is surfaced via `observability_status.health` (`disabled | ready | degraded`).

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

Desktop workspace settings (hybrid persistence):
- Core workspace defaults are persisted in project files:
  - `./.agent/config.json`: `provider`, `model`, `subAgentModel`, `enableMcp` (and `observabilityEnabled` when set).
  - `./.cowork/mcp-servers.json`: workspace-local MCP server document.
- Desktop-only UI/session metadata remains in desktop `state.json` (for example `yolo`, selected workspace/thread, and UI preferences).
- In the desktop app, Workspace Settings changes are applied immediately to live threads in that workspace; busy threads are retried when they become idle.

## MCP (Remote Tool Servers)

MCP (Model Context Protocol) servers add extra tools to the agent at runtime.

Server configs are loaded from (highest priority first):
- `./.cowork/mcp-servers.json` (workspace editable layer)
- `~/.cowork/config/mcp-servers.json` (user layer)
- `./config/mcp-servers.json` (built-in defaults)
- Legacy read-only fallback: `./.agent/mcp-servers.json`, `~/.agent/mcp-servers.json`

Credentials are stored separately (never inline in `mcp-servers.json`):
- `./.cowork/auth/mcp-credentials.json` (workspace-scoped credentials)
- `~/.cowork/auth/mcp-credentials.json` (user-scoped credentials)

Desktop app note:
- The MCP Settings page shows effective servers with source badges, workspace edit controls, auth actions, validation, and legacy migration.
- MCP management is exposed over WebSocket via `mcp_servers_get`, `mcp_server_upsert`, `mcp_server_delete`, `mcp_server_validate`, `mcp_server_auth_authorize`, `mcp_server_auth_callback`, `mcp_server_auth_set_api_key`, `mcp_servers_migrate_legacy`, plus `mcp_servers`/`mcp_server_*` events.

Example `./.cowork/mcp-servers.json` using `mcp.grep.app`:
```json
{
  "servers": [
    {
      "name": "grep",
      "transport": { "type": "http", "url": "https://mcp.grep.app" },
      "auth": { "type": "oauth", "oauthMode": "auto" }
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

Harness helper:
```bash
bun run harness:run
```

Harness web portal (Next.js realtime dashboard):
```bash
bun run portal:dev
# build/start:
bun run portal:build
bun run portal:start
```

### WebSocket Protocol Notes

- Current protocol version is `7.0` (sent in `server_hello.protocolVersion`).
- v7 adds granular MCP server management messages (`mcp_server_upsert`, `mcp_server_delete`, `mcp_server_validate`, `mcp_server_auth_*`, `mcp_servers_migrate_legacy`) and corresponding server events.
- v6 added required `sessionId` in `ping`/`pong`, required `code`/`source` in `error` events, and required `reasonCode` in `approval` events.
- Full message contract and migration details: `docs/websocket-protocol.md`.

Full operational runbook:
- `docs/harness/runbook.md`
- `docs/harness/observability.md`