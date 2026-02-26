<p align="center">
  <strong>agent-coworker</strong>
</p>

<p align="center">
  A terminal-first AI coworker that actually works with you — not just for you.
</p>

<p align="center">
  Built on <a href="https://bun.sh">Bun</a> + <a href="https://github.com/badlogic/pi-mono">pi-mono</a> · WebSocket-first architecture · TUI, CLI, Desktop, and Web interfaces
</p>

---

## What is this?

agent-coworker is a local AI agent that lives in your terminal and helps you write, debug, and ship code. It has a full toolbelt — file ops, shell execution, web research, code search, sub-agents, task management — and a command approval system so it doesn't `rm -rf` your life.

It's built on a **WebSocket-first architecture**, which means the agent brain is completely decoupled from the UI. The TUI, CLI REPL, desktop app, and web portal are all thin clients talking to the same server. You can build your own client too — the [protocol is documented](docs/websocket-protocol.md).

### Why?

Most AI coding tools are either cloud-locked, single-interface, or treat the terminal as an afterthought. agent-coworker is:

- **Local-first** — your code never leaves your machine unless you want it to
- **Provider-agnostic** — swap between Gemini, GPT, Claude, or community CLI providers
- **Interface-agnostic** — same agent, same tools, whether you're in the TUI, a desktop app, or a custom client
- **Extensible** — skills, MCP servers, and sub-agents let you teach it anything

## Quickstart

**Prerequisites:** [Bun](https://bun.sh) installed.

```bash
git clone <repo-url> && cd agent-coworker
bun install
```

Set an API key for your provider of choice:

| Provider | Environment Variable |
|---|---|
| Google Gemini | `GOOGLE_GENERATIVE_AI_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |

Or use OAuth via community CLI providers:

```bash
# OpenAI via Codex CLI
npx @openai/codex login

# Anthropic via Claude Code
npx @anthropic-ai/claude-code login
```

Then run it:

```bash
bun run start                          # TUI (starts server automatically)
bun run start -- --dir /path/to/project  # target a specific directory
bun run start -- --yolo                  # bypass command approvals (you asked for it)
```

## Interfaces

### TUI (default)

The primary interface. Built with [OpenTUI](https://github.com/anthropics/opentui) + Solid.js, inspired by [opencode](https://github.com/anomalyco/opencode).

**Home screen** — centered prompt, random tips, provider/model info.

**Session screen** — scrollable message feed with rendered markdown, tool calls, reasoning blocks, and an optional sidebar (`Ctrl+E`) showing context usage, MCP status, and todos.

#### Key shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+K` | Command palette (fuzzy search across all commands) |
| `Ctrl+N` | New session |
| `Ctrl+E` | Toggle sidebar |
| `Ctrl+Shift+L` | Switch model |
| `Ctrl+X T` | Switch theme (31 built-in: catppuccin, dracula, gruvbox, nord, etc.) |
| `Ctrl+X S` | List sessions |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Stash / pop prompt |
| `Ctrl+]` | Toggle shell mode |
| `Escape` | Cancel agent turn / dismiss dialog |
| `?` | Help / keybinding reference |

#### Prompt features

- **History** — `Up`/`Down` cycle through previous prompts (persisted in `~/.cowork/state/prompt-history.jsonl`)
- **Autocomplete** — `@` for file completions, `/` for commands
- **Shell mode** — prefix with `!` to run shell commands directly (e.g. `!ls -la`)
- **Stash** — save the current prompt for later, restore it when you need it

### CLI REPL

```bash
bun run cli
```

Lightweight REPL that connects to the same WebSocket server. Same agent, same tools, no UI overhead.

### Desktop App

```bash
bun run desktop:dev
```

Electron-based wrapper with workspace management, MCP settings UI, and browser automation via CDP.

### Web Portal

```bash
bun run portal:dev
```

Next.js realtime dashboard for session monitoring, harness context, and live trace inspection.

### Standalone Server

```bash
bun run serve
```

Run just the WebSocket server. Connect any client to `ws://127.0.0.1:7337/ws`. Build your own UI — the [WebSocket protocol spec](docs/websocket-protocol.md) has everything you need.

## Tools

16 built-in tools, all executed server-side with safety approvals for risky operations:

| Tool | What it does |
|---|---|
| `bash` | Execute terminal commands (with approval for dangerous ops) |
| `glob` | Fast file pattern matching ([fast-glob](https://github.com/mrmlnc/fast-glob)) |
| `grep` | Regex content search across files |
| `read` | Read files or list directories |
| `write` | Create or overwrite files |
| `edit` | Exact string replacements in files |
| `webSearch` | Web search via [Exa](https://exa.ai) |
| `webFetch` | Fetch web pages, convert to Markdown |
| `todoWrite` | Inline task list for multi-step workflows |
| `spawnAgent` | Launch sub-agents for parallel work |
| `ask` | Prompt the user for clarification |
| `skill` | Load domain-specific knowledge on demand |
| `notebookEdit` | Edit Jupyter notebooks |
| `memory` | Long-term context storage across sessions |

## Skills

Skills are instruction bundles that teach the agent domain-specific knowledge — frameworks, workflows, best practices. They're loaded on demand via the `skill` tool.

- **Global skills** live in `skills/` (built-in: `doc`, `pdf`, `slides`, `spreadsheet`)
- **Project skills** live in `.agent/skills/` in your workspace
- **Structure:** a `SKILL.md` file with YAML frontmatter (`name`, `description`) + markdown instructions

## MCP (Remote Tool Servers)

[Model Context Protocol](https://modelcontextprotocol.io/) servers extend the agent with additional tools at runtime. Supports HTTP/SSE and stdio transports, OAuth and API key auth.

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

Tools are namespaced as `mcp__{serverName}__{toolName}`. Config is loaded from (highest priority first):

1. `.cowork/mcp-servers.json` (workspace)
2. `~/.cowork/config/mcp-servers.json` (user)
3. `config/mcp-servers.json` (built-in defaults)

See [docs/mcp-guide.md](docs/mcp-guide.md) for the full setup guide.

## Configuration

Three-tier hierarchy: **built-in defaults** < **user config** < **project config** < **env vars**.

```json
// .agent/config.json (project-level)
{
  "provider": "openai",
  "model": "gpt-5.2",
  "subAgentModel": "gpt-5.2",
  "userName": "Max"
}
```

| Env Variable | Purpose |
|---|---|
| `AGENT_PROVIDER` | `google` · `openai` · `anthropic` · `codex-cli` · `claude-code` |
| `AGENT_MODEL` | Model ID |
| `AGENT_WORKING_DIR` | Working directory for the agent |
| `AGENT_USER_NAME` | Your name (used in system prompt) |
| `AGENT_ENABLE_MCP` | Enable/disable MCP (`true`/`false`) |

### Observability

Built-in [Langfuse](https://langfuse.com) + OpenTelemetry integration. Set `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and optionally `LANGFUSE_BASE_URL` to enable full LLM I/O tracing.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Thin Clients                                           │
│  TUI (OpenTUI+Solid.js) · CLI REPL · Desktop · Portal  │
└──────────────────────────┬──────────────────────────────┘
                           │ WebSocket (protocol v7.0)
┌──────────────────────────▼──────────────────────────────┐
│  Server                                                 │
│  AgentSession · Model Streaming · Session Persistence   │
│  MCP Management · Command Approval · SQLite Storage     │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│  Agent Engine (PI runtime)                              │
│  createRunTurn() · System Prompt · Tool Execution       │
└────────┬─────────────────┬──────────────────┬───────────┘
         │                 │                  │
    Built-in Tools    Provider Registry    MCP Tools
    (16 tools)        (Gemini/GPT/Claude)  (runtime-loaded)
```

Everything flows through the WebSocket protocol. UIs never touch the runtime engine or tools directly.

### Key source paths

| Path | What |
|---|---|
| `src/agent.ts` | Core agent loop (`createRunTurn()` factory) |
| `src/server/session.ts` | Session state, turn execution, ask/approval flows |
| `src/server/protocol.ts` | WebSocket message types (`ClientMessage`, `ServerEvent`) |
| `src/tools/` | All 16 built-in tool implementations |
| `src/providers/` | Provider registry (Google, OpenAI, Anthropic, community CLIs) |
| `src/mcp/` | MCP config loading, OAuth, auth storage |
| `apps/TUI/` | Terminal UI (OpenTUI + Solid.js) |
| `apps/desktop/` | Electron desktop app |
| `apps/portal/` | Next.js web portal |

## Docs

| Document | Description |
|---|---|
| [WebSocket Protocol](docs/websocket-protocol.md) | Full protocol spec (v7.0) — the source of truth for building clients |
| [Architecture](docs/architecture.md) | System design and component relationships |
| [MCP Guide](docs/mcp-guide.md) | Setting up and using MCP remote tool servers |
| [Custom Tools](docs/custom-tools.md) | How to add your own tools |
| [Session Storage](docs/session-storage-architecture.md) | Session persistence and backup architecture |
| [Harness Runbook](docs/harness/runbook.md) | Running the evaluation harness |
| [Harness Observability](docs/harness/observability.md) | Monitoring and tracing harness runs |

## Development

```bash
bun install          # Install all dependencies (root + apps)
bun test             # Run tests (Bun test runner)
bun run dev          # Watch mode
bun run desktop:dev  # Desktop app dev mode
bun run portal:dev   # Web portal dev mode
bun run harness:run  # Run evaluation harness
bun run docs:check   # Validate documentation
```

## Tech Stack

| | |
|---|---|
| **Runtime** | [Bun](https://bun.sh) |
| **AI Runtime** | [pi-mono / @mariozechner/pi-ai](https://github.com/badlogic/pi-mono) |
| **TUI** | [OpenTUI](https://github.com/anthropics/opentui) + [Solid.js](https://www.solidjs.com/) |
| **Desktop** | Electron |
| **Web** | [Next.js](https://nextjs.org/) |
| **MCP** | [Model Context Protocol](https://modelcontextprotocol.io/) v1.26 |
| **Observability** | [Langfuse](https://langfuse.com) + OpenTelemetry |
| **Testing** | Bun built-in test runner |
| **Persistence** | SQLite (`~/.cowork/sessions.db`) |
