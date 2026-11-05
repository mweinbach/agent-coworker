# Contributing to agent-coworker

This guide covers everything you need to start contributing to the project.

## Prerequisites

- **[Bun](https://bun.sh/)** v1.x or later (TypeScript client runtime, package manager, and test runner)
- **[Rust](https://rustup.rs/)** (`rustc` and `cargo`, Rust 2024 edition)
- **Node.js** v18+ (some build/mobile dependencies use Node APIs)
- **Git**
- At least one AI provider credential:
  - **Google** (`GOOGLE_GENERATIVE_AI_API_KEY`) -- default provider
  - **OpenAI** (`OPENAI_API_KEY`)
  - **Anthropic** (`ANTHROPIC_API_KEY`)
  - Optional: Codex CLI OAuth if you want an OpenAI-backed CLI login flow

## Getting Started

```bash
git clone <repo-url> && cd agent-coworker
bun install                     # installs root + apps/desktop deps
bun install --cwd apps/mobile --frozen-lockfile # required by the full test suite

# Run in different modes:
bun run start                   # Desktop app in dev mode -- starts server automatically
bun run cli                     # Rust CLI REPL via cargo
bun run serve                   # Standalone WebSocket server
```

## Architecture Overview

The project follows a **WebSocket-first** pattern. The server manages sessions and agent turns; clients (desktop app, CLI REPL, or custom clients) are thin consumers of WebSocket events.

```
Client (Desktop / CLI / Custom)
  |  WebSocket
  v
Server (crates/cowork-server/)  -->  cowork-harness  -->  cowork-providers + cowork-tools
```

Key modules:

| Module | Purpose |
|---|---|
| `crates/cowork-harness/` | Core agent loop, prompt assembly, subagents, tasks, and workflows. |
| `crates/cowork-server/` | Axum WebSocket/HTTP server, JSON-RPC routes, session management, mobile TLS. |
| `crates/cowork-tools/` | Built-in tool implementations (`bash`, `read`, `write`, `edit`, `glob`, `grep`, etc.). |
| `crates/cowork-providers/` | Provider registry and native SSE/HTTP/Codex wire transports. |
| `crates/cowork-config/` | Config loading with three-tier merge and env var overrides. |
| `crates/cowork-mcp/` | MCP server config registry, OAuth provider, auth store, and tool pool. |
| `crates/cowork-harness/src/extensions/` | Skill, plugin, and marketplace discovery. |
| `src/shared/` | Pure TypeScript client/UI contracts and schemas. |
| `apps/desktop/` | Electron desktop app. |
| `crates/cowork-cli/` | CLI REPL client. |

## Directory Structure

```
crates/
  cowork-protocol/      # JSON-RPC wire types and schema definitions
  cowork-config/        # Config loading + auth stores
  cowork-storage/       # SQLite session DB + JSONL thread journal
  cowork-inference/     # Unified inference engine and stream normalization
  cowork-providers/     # AI provider definitions + streaming clients
  cowork-sandbox/       # OS sandboxing (Seatbelt, bubblewrap/seccomp, Windows helper)
  cowork-env/           # Runtime environment bootstrap and verification
  cowork-js-vm/         # QuickJS + oxc codeMode and workflow VM
  cowork-mcp/           # MCP server config, OAuth, and client pool
  cowork-tools/         # Built-in tool implementations
  cowork-harness/       # Agent turn loop, subagents, tasks, extensions, OOXML, backups
  cowork-server/        # Axum WebSocket/HTTP server and sidecar binary
  cowork-cli/           # CLI REPL binary
src/
  types.ts              # Shared TypeScript types
  client/               # WebSocket JSON-RPC client (JsonRpcSocket)
  models/               # Static client model registry
  platform/             # Desktop host/path/sandbox helpers
  providers/            # Static client provider catalog
  session/              # Client usage/pricing helpers
  shared/               # Shared client/UI schemas and stream projection
  sync/                 # Cloud sync outbox helpers
  telemetry/            # Client privacy/telemetry wrappers
  utils/                # Shared client/platform utilities
apps/
  desktop/              # Electron desktop app
  mobile/               # Optional Expo mobile app (React Native)
packages/
  harness/              # Developer harness, docs checks and provider spec generation
config/
  defaults.json         # Built-in default configuration
  mcp-servers.json      # System-level MCP server definitions
skills/                 # Built-in skills (memories, task, workflow)
prompts/                # System prompts, sub-agent prompts, command templates
scripts/                # Runtime packaging and release build helpers
docs/                   # Architecture docs, protocol spec, harness docs
test/                   # All test files (*.test.ts)
```

## Configuration

Configuration uses a **three-tier hierarchy** (each layer overrides the previous):

1. **Built-in**: `config/defaults.json`
2. **User**: `~/.cowork/config/config.json`
3. **Project**: `.cowork/config.json` (in working directory)

**Environment variables** override all tiers:

| Variable | Purpose |
|---|---|
| `AGENT_PROVIDER` | Provider name (`google`, `openai`, `anthropic`, `codex-cli`) |
| `AGENT_MODEL` | Model ID override |
| `AGENT_WORKING_DIR` | Working directory for the agent |
| `AGENT_OUTPUT_DIR` | Output directory for generated files |
| `AGENT_UPLOADS_DIR` | Directory for uploaded files |
| `AGENT_USER_NAME` | User display name |
| `AGENT_ENABLE_MCP` | Enable/disable MCP tool loading |
| `AGENT_OBSERVABILITY_ENABLED` | Enable/disable observability |
| `AGENT_MODEL_MAX_RETRIES` | Max retries for model calls |

The `.cowork/` directory is used for MCP server configs and auth credentials (see MCP section below).

## Adding a New Tool

1. Add the tool implementation in `crates/cowork-tools/src/` implementing `BuiltinTool` (`crates/cowork-tools/src/context.rs`) and register it in `create_builtin_tools()` inside `crates/cowork-tools/src/catalog.rs` (re-exported in `crates/cowork-tools/src/lib.rs`).

The `ToolExecutionContext` in `crates/cowork-tools/src/context.rs` provides:
- `agent_config` / `working_directory` / `sandbox_policy` -- active session configuration, confined workspace paths, and resolved OS sandbox policy
- `approval_handler` -- prompt the user (`ask_user` / `approve_command` / `approve_file_change`) over JSON-RPC server requests
- `on_todos_updated` -- emit live todo list updates
- `is_cancelled()` / `cancel_rx` -- cancellation signal for the active turn

## Adding a WebSocket Message

Follow these four steps whenever you add a new JSON-RPC request, result, or notification:

1. **Add the type/schema** to `crates/cowork-protocol/src/schemas.rs`, register the method in `crates/cowork-protocol/src/ws_jsonrpc_schema.json` (`crates/cowork-protocol/src/methods.rs`), and update client control schemas in `src/shared/jsonrpcControlSchemas.ts` (and `SessionEvent` in `src/shared/protocol.ts` when consumed by clients).
2. **Add validation** in `crates/cowork-protocol/` and `crates/cowork-server/src/jsonrpc.rs` when the message is client-originated.
3. **Add the handler** in `crates/cowork-server/src/` (request routing) and/or `crates/cowork-harness/` (session logic).
4. **Update `docs/websocket-protocol.md`** with the new message format, fields, example JSON, and where it fits in the flow, then verify with `bun run docs:check`.

The protocol doc is the source of truth for anyone building an alternative UI.

## Writing Skills

Skills live in `skills/` directories (built-in, user `~/.cowork/skills/`, or project `.cowork/skills/`).

Each skill is a directory containing a `SKILL.md` file with YAML front-matter:

```markdown
---
name: "my-skill"
description: "What this skill does (max 1024 chars)"
---

# My Skill

Instructions for the agent when this skill is active...
```

Front-matter fields:
- **`name`** (required) -- kebab-case, must match the directory name
- **`description`** (required) -- max 1024 characters
- **`triggers`** (optional) -- conditions that auto-activate the skill
- **`allowed-tools`** (optional) -- restrict which tools the skill can use
- **`license`** (optional) -- license identifier
- **`compatibility`** (optional) -- version constraints
- **`metadata`** (optional) -- arbitrary key-value pairs

Skills can optionally include an `agents/` subdirectory with YAML files for interface metadata.

## MCP Server Configuration

MCP (Model Context Protocol) servers extend the agent with external tools.

**Config locations:**
- **Workspace**: `.cowork/mcp-servers.json` (in project root)
- **User**: `~/.cowork/config/mcp-servers.json`
- **System**: `config/mcp-servers.json` (built-in)

**Auth modes:** `none`, `api_key`, `oauth`

Credentials are stored separately from server configs:
- **Workspace auth**: `.cowork/auth/`
- **User auth**: `~/.cowork/auth/`

**Tool namespacing:** MCP tools are exposed to the agent as `mcp__{serverName}__{toolName}`.

## Testing

Rust crate unit and integration tests run via **Cargo** (`crates/cowork-server/tests/` and inline `#[cfg(test)]`), while TypeScript client, desktop, mobile, and black-box server integration tests use **Bun's test runner** (`test/` and `apps/desktop/test/`).

The full TypeScript suite exercises the installed Expo Router and native UI modules. Install both root and mobile dependencies using the Getting Started commands before running it.

```bash
cargo test --workspace          # Run all Rust workspace tests
bun run test                    # Run all TypeScript + black-box integration tests
bun run test -- apps/desktop/test # Run desktop tests
bun run test -- test/rust-server.http-and-rpc.integration.test.ts # Run a specific test file
```

The full runner keeps each test file in a fresh process. Backend tests skip the
React/jsdom bootstrap; desktop and mobile tests keep it. Root tests that exercise
UI code must include `mobile` or `desktop` in their path or use `.test.tsx`.
Ad hoc runs with paths or filters retain the complete bootstrap.

Key testing patterns:
- **Deterministic local mocks** -- Rust provider/harness/server tests use local mock HTTP/SSE/stdio servers; black-box TypeScript integration tests spawn isolated `cowork-server` instances via `test/helpers/rustServerHarness.ts`.
- **No network calls** -- Default test runs must stay 100% offline and isolate all state in temporary directories (`COWORK_HOME_OVERRIDE`).
- **Test files follow `*.test.ts` naming** -- Place TypeScript tests in `test/` or `apps/desktop/test/`, and Rust integration tests in `crates/<crate>/tests/`.

## Commits & PRs

- **Commit messages**: Follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).
- **Always run tests** before pushing: `cargo test --workspace && bun run test`
- **Focused PRs**: Keep pull requests small and focused on a single concern.
- **Code quality**: `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `bun run typecheck` (TypeScript strict, root + harness + desktop), `bun run check` (Biome + Vite+), `bun run knip`, and `bun run docs:check` all run in CI.

Biome rejects unnecessary `else` branches, empty JavaScript blocks, and conditions made redundant
by inferred types. Test and desktop quality fixtures are excluded from the latter two rules.
Unused imports, variables, and parameters in `scripts/` are also errors. The existing local and CI
checks enforce these rules.

Verify the runtime contract before removing a guard, especially around persisted data, external
inputs, and dynamic lookups. Annotate mutable state accurately; an inferred literal must not cause
a shutdown or cancellation check to be removed. Keep necessary cleanup behavior and explain why
its errors can be ignored. Use a narrow suppression only for a demonstrated analyzer limitation,
with the runtime condition it misses; do not add generic comments merely to silence findings.

## Useful References

- [`docs/websocket-protocol.md`](docs/websocket-protocol.md) -- WebSocket message format and flow
- [`docs/harness/index.md`](docs/harness/index.md) -- Harness docs map
- [`docs/session-storage-architecture.md`](docs/session-storage-architecture.md) -- Session persistence design
- [`AGENTS.md`](AGENTS.md) -- Agent onboarding doc; index of `agent_docs/` task-specific guides
