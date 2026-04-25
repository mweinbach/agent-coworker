# agent-coworker

A local-first coding agent backend with CLI and desktop clients.

`agent-coworker` is built around one architectural decision: the product runtime lives behind a WebSocket server, not inside a single UI or developer harness. The server owns sessions, tool execution, provider auth, MCP, persistence, safety checks, and streaming. The CLI REPL, Electron app, and any custom client are thin clients on top of the same protocol.

If you want "an AI terminal app", you can use it that way. If you want "an agent backend with a documented control plane and multiple frontends", that is what this repo actually is. Developer harnesses and validation scripts are repo tooling, not the runtime package boundary.

## Why this project exists

Most coding agents collapse the runtime, UI, and provider glue into one product surface. That makes them hard to extend, hard to automate, and hard to trust once they start touching a real workspace.

Cowork takes the opposite approach:

- The server is the product boundary. UIs render state and send typed protocol messages.
- Sessions are persistent, resumable objects backed by SQLite, not just transient chat tabs.
- Tool execution happens server-side with command approvals and explicit `--yolo` escape hatches.
- Providers are first-class integrations with auth methods, connection status, and per-session model configuration.
- Skills, MCP servers, and subagents are part of the core system, not afterthought plugins.

## Highlights

- Interfaces: plain CLI REPL, Electron desktop app, and custom WebSocket clients.
- Local-first workflow: your repo stays on your machine; external calls only happen through the providers and tools you configure.
- Server-side tools for shell, files, search, fetch, notebook edits, memory, task tracking, and subagent delegation.
- Persistent session history in `~/.cowork/sessions.db`, with resume support across restarts.
- Opt-in workspace backup APIs for manual recovery snapshots when git-native checkpointing is not available.
- Layered skills and MCP configuration for project, user, global, and built-in capabilities.
- Provider catalog, auth, and status flows for Google, OpenAI, Anthropic, Bedrock, Together, Fireworks, NVIDIA, LM Studio, Baseten, and `codex-cli`.
- Product runtime is kept in `src/`; developer harnesses live under `packages/harness`.

## Quickstart

### 1. Install

Prerequisite: [Bun](https://bun.sh)

```bash
git clone <repo-url>
cd agent-coworker
bun install
```

### 2. Configure a provider

Live AI turns require at least one configured provider. Starting the server, launching the UIs, and running tests do not.

| Provider | Auth |
| --- | --- |
| Google | `GOOGLE_GENERATIVE_AI_API_KEY` or `GOOGLE_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| Bedrock | AWS default credentials, profile, or explicit keys (`AWS_REGION`, `AWS_PROFILE`, etc.) |
| Together | `TOGETHER_API_KEY` |
| Fireworks | `FIREWORKS_API_KEY` |
| NVIDIA | `NVIDIA_API_KEY` |
| Baseten | `BASETEN_API_KEY` |
| LM Studio | `LM_STUDIO_API_KEY` (optional); configure base URL via `LM_STUDIO_BASE_URL` or config |
| OpenCode Go | `OPENCODE_API_KEY` |
| OpenCode Zen | `OPENCODE_ZEN_API_KEY` |
| Codex CLI | Built-in OAuth or API key flow via Cowork |

All providers also support saving API keys through the desktop UI or the CLI `/connect` flow, stored in `~/.cowork/auth/connections.json`.

Examples:

```bash
export OPENAI_API_KEY=...
```

Or start the CLI and use the built-in connect flow:

```bash
bun run cli
# then inside the REPL:
/connect codex-cli
```

### 3. Run it

Desktop app (default):

```bash
bun run start
```

This runs the Electron app in dev mode (`electron-vite` under `apps/desktop`). It does not accept `--dir`; add or select a workspace in the UI.

Plain CLI REPL:

```bash
bun run cli
```

Open the CLI with a specific workspace directory:

```bash
bun run cli -- --dir /path/to/project
```

Standalone server for headless use or custom clients:

```bash
bun run serve
bun run serve -- --dir /path/to/project
bun run serve -- --json
```

Build a standalone Bun binary (`cowork-server`) that can be bundled into other apps:

```bash
bun run build:server-binary
./dist/cowork-server --host 0.0.0.0 --port 7337
```

On startup, `cowork-server` logs the bound WebSocket URL and, when using `--host 0.0.0.0`, prints reachable LAN IPv4 addresses for easy embedding/debugging.
Windows ARM64 release builds are staged as runnable bundles instead of single compiled executables. Those bundles include `bun.exe`, a Bun-targeted server bundle, the launcher script, and the built-in `prompts/`, `config/`, and `docs/` assets.

## Clients

### Desktop

The Electron app is the primary workstation client with:

- workspace management (per-workspace server processes)
- provider settings, auth flows, and connection status
- MCP server management and validation
- chat transcript rendering with streaming markdown
- thread history and resume
- skills and plugin management
- native menus, dialogs, notifications, and auto-updater
- macOS, Windows x64, and Windows ARM64 packaged releases

Run it in development with:

```bash
bun run desktop:dev
```

### CLI REPL

The CLI is a lightweight readline client for the same server. It supports slash commands for provider and model control, session switching, connection flows, and tool listing.

Useful commands include:

- `/connect <provider>` — start a provider auth flow
- `/provider <name>` — switch provider
- `/model <id>` — switch model
- `/new` — start a new session
- `/resume <sessionId>` — resume a previous session
- `/sessions` — list sessions
- `/tools` — list available tools
- `/cwd <path>` — change working directory
- `/verbosity <level>` — set output verbosity
- `/reasoning-effort <level>` — set reasoning effort (alias: `/effort`)
- `/help` — show all commands

### Custom clients

The WebSocket protocol is documented in [docs/websocket-protocol.md](https://github.com/mweinbach/agent-coworker/blob/main/docs/websocket-protocol.md). It covers much more than chat:

- provider catalog, auth methods, auth callbacks, logout, and status
- MCP server CRUD, validation, and auth
- session listing, deletion, title changes, pagination, and file uploads
- opt-in backup/checkpoint/restore flows
- subagent creation and persistent subagent session management
- observability and harness context

## Architecture

```text
CLI / Desktop / Custom Client
                |
                v
        WebSocket protocol
                |
                v
     agent-coworker server runtime
  sessions | auth | MCP | persistence
  tools    | streaming | opt-in backups
                |
                v
      model runtimes and tool execution
```

A few architectural boundaries matter:

- Business logic belongs in the server, not in the clients.
- Sessions are durable and resumable.
- Tools execute on the server in the workspace context.
- The primary wire protocol is JSON-RPC over WebSocket (`cowork.jsonrpc.v1` subprotocol). Clients send JSON-RPC requests and receive notifications for streaming events.

If you want the exact wire contract, use [docs/websocket-protocol.md](https://github.com/mweinbach/agent-coworker/blob/main/docs/websocket-protocol.md). If you want the broader component map, use [docs/architecture.md](https://github.com/mweinbach/agent-coworker/blob/main/docs/architecture.md).

## Tools, skills, and MCP

### Built-in tools

Cowork ships with server-side tools for:

- shell execution: `bash`
- file reads and writes: `read`, `write`, `edit`
- workspace search: `glob`, `grep`
- web research: `webSearch`, `webFetch`
- workflow control: `ask`, `todoWrite`, `spawnAgent`
- artifact editing: `notebookEdit`
- contextual guidance: `skill`, `memory`
- session diagnostics: `usage`

When agent control is enabled, sessions also expose persistent-agent tools: `listAgents`, `sendAgentInput`, `waitForAgent`, `inspectAgent`, `resumeAgent`, and `closeAgent`.

`webSearch` supports Exa or Parallel depending on configured credentials (`EXA_API_KEY` / `PARALLEL_API_KEY`). `webFetch` extracts readable web pages into markdown-friendly text, enriches results with page links and image links via the configured search provider, and saves direct image/document downloads into the workspace `Downloads/` directory with a returned local file path.

### Skills

Skills are instruction bundles rooted in `SKILL.md`. They are discovered from layered locations:

1. `.cowork/skills` in the current workspace
2. `~/.cowork/skills`
3. built-in `skills/`

Legacy `.agent` skill/config trees are not loaded at runtime. Run `cowork migrate-agent-config` once to move old workspace and user config into `.cowork/` and `~/.cowork/`.

Built-in curated skills currently cover document, PDF, slide, spreadsheet, git workflow, and frontend development. See [docs/custom-tools.md](https://github.com/mweinbach/agent-coworker/blob/main/docs/custom-tools.md) if you want to extend the system further.

### MCP

Cowork supports Model Context Protocol servers with layered config and auth (workspace config wins over user over system):

1. `.cowork/mcp-servers.json` (workspace)
2. `~/.cowork/config/mcp-servers.json` (user)
3. `config/mcp-servers.json` (built-in defaults)

Legacy `.agent/mcp-servers.json` files are migrated only by the explicit `cowork migrate-agent-config` command; they are not loaded as runtime fallbacks.

Supported flows include stdio and HTTP/SSE transports plus API-key and OAuth auth modes. Credentials are stored separately from configs in `.cowork/auth/` and `~/.cowork/auth/`. See [docs/mcp-guide.md](https://github.com/mweinbach/agent-coworker/blob/main/docs/mcp-guide.md).

## Persistence and safety

Persistence is a core feature, not a convenience cache.

- Canonical session storage lives in `~/.cowork/sessions.db`.
- Legacy JSON session snapshots are import-only compatibility data.
- Opt-in backup artifacts live under `~/.cowork/session-backups`.
- Desktop transcript JSONL files are a renderer cache, not the source of truth.

Safety model:

- risky tool actions go through approval flows
- `--yolo` disables command approvals when you explicitly want that behavior
- git workspaces should use git-native checkpoints (`git diff`, `git stash`, and `git worktree`) by default
- advanced backup APIs can be enabled for manual recovery snapshots, especially in non-git workspaces

For the full storage model, see [docs/session-storage-architecture.md](https://github.com/mweinbach/agent-coworker/blob/main/docs/session-storage-architecture.md).

## Development

Common commands:

```bash
bun test                    # run all tests
bun run typecheck           # typecheck root project + apps/desktop
bun run docs:check          # verify doc consistency
bun run dev                 # watch mode for CLI entry (src/index.ts)
bun run desktop:dev         # run Electron desktop app in dev mode
bun run harness:run         # run harness scenarios (report-only)
bun run test:stable         # sequential per-file test runner for flake detection
```

Notes:

- `bun install` at the repo root installs the product runtime, desktop app, and harness workspace. The mobile app remains optional under `apps/mobile`.
- `bun run typecheck` covers the root runtime, `packages/harness`, and `apps/desktop`; use `bun run app:mobile:typecheck` after installing `apps/mobile` dependencies when working on the optional mobile app.
- `bun run dev` watches `src/index.ts` (the CLI entry point), not the desktop app. Use `bun run desktop:dev` for the Electron app.
- The test suite is deterministic and does not require provider credentials.

## Repository map

| Path | Purpose |
| --- | --- |
| `src/agent.ts` | Core agent turn logic (`createRunTurn()` factory) |
| `src/config.ts` | Three-tier config loading and deep merge |
| `src/server/` | WebSocket server, JSON-RPC routes, session orchestration, persistence, opt-in backup |
| `src/server/session/` | `AgentSession` facade and focused managers (`TurnExecutionManager`, `HistoryManager`, etc.) |
| `src/server/jsonrpc/` | JSON-RPC transport, schemas, routes, event/journal projectors |
| `src/cli/` | CLI REPL and command parsing |
| `src/tools/` | Built-in server-side tools |
| `src/providers/` | Provider catalog, auth, and model adapters (12 providers) |
| `src/runtime/` | Runtime adapters (`google-interactions`, `pi`, `openai-responses`) |
| `src/mcp/` | MCP config, auth, and client lifecycle |
| `src/skills/` | Skill discovery and trigger extraction |
| `src/observability/` | OpenTelemetry + Langfuse integration |
| `packages/harness/` | Developer harness scripts, raw-loop validation, docs generation, and stable test runner |
| `apps/desktop/` | Electron desktop app |
| `apps/mobile/` | Optional Expo mobile app (React Native); not installed by default |
| `config/` | Built-in defaults and per-provider model configs (`config/models/`) |
| `skills/` | Bundled built-in skills |
| `prompts/` | System prompts, sub-agent prompts, and model-specific prompt snippets |
| `scripts/` | Runtime packaging and release build helpers |
| `test/` | All test files (`*.test.ts`) |
| `docs/` | Protocol, architecture, storage, MCP, and harness docs |

## Docs

| Document | What it covers |
| --- | --- |
| [docs/websocket-protocol.md](https://github.com/mweinbach/agent-coworker/blob/main/docs/websocket-protocol.md) | Canonical JSON-RPC WebSocket contract for custom clients |
| [docs/architecture.md](https://github.com/mweinbach/agent-coworker/blob/main/docs/architecture.md) | Component-level system overview |
| [docs/mcp-guide.md](https://github.com/mweinbach/agent-coworker/blob/main/docs/mcp-guide.md) | MCP setup, layering, and auth |
| [docs/session-storage-architecture.md](https://github.com/mweinbach/agent-coworker/blob/main/docs/session-storage-architecture.md) | SQLite session storage and resume behavior |
| [docs/custom-tools.md](https://github.com/mweinbach/agent-coworker/blob/main/docs/custom-tools.md) | Extending Cowork with custom tools |
| [docs/bundling-guide.md](https://github.com/mweinbach/agent-coworker/blob/main/docs/bundling-guide.md) | Building custom apps on top of the cowork server |
| [docs/mobile-remote-access.md](https://github.com/mweinbach/agent-coworker/blob/main/docs/mobile-remote-access.md) | Mobile remote access and relay security |
| [docs/workspace-context.md](https://github.com/mweinbach/agent-coworker/blob/main/docs/workspace-context.md) | Workspace context and project instructions |
| [docs/harness/index.md](https://github.com/mweinbach/agent-coworker/blob/main/docs/harness/index.md) | Harness docs index |
| [docs/harness/config.md](https://github.com/mweinbach/agent-coworker/blob/main/docs/harness/config.md) | Harness config precedence, env vars, and runtime flags |
| [docs/harness/runbook.md](https://github.com/mweinbach/agent-coworker/blob/main/docs/harness/runbook.md) | Running harness scenarios and collecting artifacts |
| [docs/harness/observability.md](https://github.com/mweinbach/agent-coworker/blob/main/docs/harness/observability.md) | Langfuse and observability wiring |

## Status

This is an actively developed local agent system. The architecture is stable enough to build on, but the project is still moving quickly, especially around protocol surface, desktop polish, and provider/runtime behavior.

If you want to contribute, the safest mental model is:

- the server owns behavior
- the protocol is a public contract
- UIs are clients
- README claims should match the code

## License

This project uses a custom source-available license in [`LICENSE`](./LICENSE).

Forks and modifications are allowed, but you must clearly credit the original
project and identify your changes. Selling the project, a fork, or a derivative
product/service requires prior permission from Max Weinbach.
