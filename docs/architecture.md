# Architecture Overview

This document provides a comprehensive overview of the agent-coworker architecture for developers and users who want to understand how the system works.

## High-Level Architecture

Agent-coworker follows a **WebSocket-first** architecture where the server manages all business logic and clients are thin rendering layers.

```
┌─────────────────────────────────────────────────────────────────┐
│                         Clients                                  │
│  ┌─────────┐  ┌─────────┐  ┌─────────────────────┐             │
│  │   CLI   │  │ Desktop │  │ Custom Client       │             │
│  │  REPL   │  │(Electron)│ │ (WebSocket)         │             │
│  └────┬────┘  └────┬────┘  └──────────┬──────────┘             │
└───────┼────────────┼──────────────────┼────────────────────────┘
        │            │                  │
        └────────────┴──────────────────┘
                      │
                      ▼ WebSocket Protocol
                  ┌───────────────────────┐
                  │   WebSocket Server    │
                  │ (crates/cowork-server)│
                  └───────────┬───────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
┌────────────────┐   ┌──────────────────┐   ┌────────────────┐
│ SessionRuntime │   │    Agent Loop    │   │  MCP Manager   │
│(cowork-server) │   │ (cowork-harness) │   │  (cowork-mcp)  │
└───────┬────────┘   └────────┬─────────┘   └───────┬────────┘
        │                     │                     │
        │                     ▼                     │
        │           ┌──────────────────┐            │
        │           │   AI Providers   │            │
        │           │(cowork-providers)│            │
        │           └─────────┬────────┘            │
        │                     │                     │
        └─────────────────────┼─────────────────────┘
                              ▼
                  ┌───────────────────────┐
                  │    Tool Execution     │
                  │ (crates/cowork-tools) │
                  └───────────────────────┘
```

## Core Components

### 1. WebSocket Server (`crates/cowork-server/`)

The server is the heart of the system. It handles:

- **Session Management**: Each WebSocket connection binds to a workspace/thread session runtime
- **Protocol Handling**: Validates JSON-RPC requests and notifications, then routes them to the appropriate handlers
- **Turn Orchestration**: Manages the agent turn lifecycle (start, stream, complete)
- **State Persistence**: SQLite-based session storage with backup/restore

**Key Modules:**

- `crates/cowork-server/src/lib.rs` — Server initialization, HTTP routes, and WebSocket routing
- `crates/cowork-harness/src/lib.rs` — Per-session turn orchestration, subagents, tasks, workflows, and backups
- `src/shared/protocol.ts` — Shared `SessionEvent` payload types consumed by UI clients
- `crates/cowork-server/src/jsonrpc.rs` — JSON-RPC transport, schemas, routes, and notification projectors
- `crates/cowork-storage/src/lib.rs` — SQLite persistence and JSONL thread journal

### 2. Agent Loop (`crates/cowork-harness/`)

The agent loop is where the AI reasoning happens:

```
User Message → System Prompt + History + Tools → AI Model → Tool Calls → Results → Repeat
```

**Turn Lifecycle:**

1. Build system prompt with skills, memory, and context
2. Call the configured LLM wire transport in `crates/cowork-providers/` (`google` Interactions API, `anthropic` Messages API, `openai` Responses API, OpenAI-compatible Chat Completions, AWS Bedrock ConverseStream, or `codex-cli` Codex app-server) with model, tools, and history
3. Execute tool calls (with approval for risky operations)
4. Stream results back to client via WebSocket events
5. Update message history

### 3. Tools (`crates/cowork-tools/`)

Built-in capabilities exposed to the agent:


| Tool           | Purpose                                      | Approval Required |
| -------------- | -------------------------------------------- | ----------------- |
| `bash`         | Shell command execution                      | Conditional       |
| `read`         | Read file contents                           | No                |
| `write`        | Create/overwrite files                       | Yes (write path)  |
| `edit`         | In-place text edits                          | Yes (write path)  |
| `glob`         | Find files by pattern                        | No                |
| `grep`         | Search file contents                         | No                |
| `webSearch`    | Search the web                               | No                |
| `webFetch`     | Fetch web content                            | No                |
| `AskUserQuestion` | Ask user questions                        | No                |
| `todoWrite`    | Update progress list                         | No                |
| `spawnAgent`   | Delegate to a child agent                    | No                |
| `skill`        | Load skill instructions                      | No                |
| `memory`       | Legacy SQLite persistent memory              | No                |
| `recallMemory` | Read advanced file-based memory              | No                |
| `manageMemory` | List/create/edit active advanced memory      | No                |
| `readPastConversation` | Read prior conversation transcripts | No                |


When agent control is enabled, the following tools are also available: `listAgents`, `sendAgentInput`, `waitForAgent`, `inspectAgent`, `resumeAgent`, `closeAgent`.

For non-Codex providers, Cowork exposes the full built-in toolbelt plus the deferred MCP search/call tools. For `codex-cli`, Cowork uses a hybrid boundary: Codex app-server owns local shell execution, sandboxing, approvals, filesystem reads/writes/edits/search, and native web search/fetch. Cowork exposes only coordination tools such as subagents, ask/todos/memory/skills, plus Cowork-managed `toolSearch` and `mcpCall` as Codex app-server `dynamicTools`.

`webSearch` is backed by either Exa or Parallel depending on configured credentials (`EXA_API_KEY` / `PARALLEL_API_KEY` or `toolApiKeys` in `~/.cowork/auth/connections.json`) and is not exposed to `codex-cli` turns in hybrid mode (`crates/cowork-tools/src/web.rs`).

Each tool implements `BuiltinTool` (`crates/cowork-tools/src/context.rs`) and executes with a `ToolExecutionContext` providing access to:

- `agent_config` — Current agent configuration
- `working_directory` / `read_roots` — Confined workspace and skill/plugin read/write roots
- `approval_handler` — Prompt the user for structured questions (`ask_user`) or command/file approvals (`approve_command` / `approve_file_change`, including OS sandbox denial escalation; see [Sandbox](./sandbox.md))
- `sandbox_policy` — Resolved OS sandbox policy enforced for `bash` execution
- `on_todos_updated` — Update progress indicators
- `is_cancelled()` — Cooperative turn cancellation signal

### 4. Providers (`crates/cowork-providers/`, `src/providers/catalog.ts`)

The registered providers and their static metadata (display name, wire transport, discovery mode, API-key env vars, base URLs, default/title models, auth methods, canonical order) are listed in `config/providers.json`. Wire transports live in `crates/cowork-providers/src/` (one module per protocol; OpenAI-compatible providers share the Chat Completions transport), TypeScript clients read the generated `src/generated/providerSpecs.ts`, and model metadata lives in per-provider config files under `config/models/<provider>/`.

Provider selection flows through config with env var override (`AGENT_PROVIDER`).

### 5. MCP Integration (`crates/cowork-mcp/`)

Model Context Protocol servers extend the agent with external tools:

- **Discovery**: `toolSearch` returns selected schemas and `mcp__{serverName}__{toolName}` IDs; `mcpCall` resolves them against the live workspace catalog.
- **Auth**: Supports `none`, `api_key`, and `oauth` modes
- **Lifecycle**: Connections are shared across workspace sessions. Search and call refresh configuration/auth; unchanged connections are reused, and replaced connections drain outstanding calls before closing.

**Config Locations (priority order):**

1. `.cowork/mcp-servers.json` (workspace)
2. `~/.cowork/config/mcp-servers.json` (user)
3. `config/mcp-servers.json` (built-in)

### 6. Skills (`skills/`, `.cowork/skills/`)

Domain-specific instruction packages loaded on demand:

```
skills/
├── spreadsheets/SKILL.md  # Excel/CSV creation guidance
├── presentations/SKILL.md # PowerPoint/presentation guidance
├── pdf/SKILL.md           # PDF creation guidance
└── documents/SKILL.md     # Word document guidance
```

Skills are discovered from layered directories:

1. Project: `.cowork/skills/`
2. Global: `~/.cowork/skills/`
3. Built-in: `skills/`

### 7. Observability (`crates/cowork-server/src/observability.rs`)

OpenTelemetry + Langfuse integration for production monitoring:

- **Traces**: Full LLM I/O visibility (inputs/outputs recorded)
- **Lifecycle Events**: Session start/end, turn execution
- **Health Status**: `disabled | ready | degraded`

**Environment Variables:**

- `LANGFUSE_PUBLIC_KEY`
- `LANGFUSE_SECRET_KEY`
- `LANGFUSE_BASE_URL`

## Clients

### Desktop (`apps/desktop/`)

Electron + React wrapper (primary client):

- Native menus and dialogs
- Desktop notifications
- Per-workspace server processes
- Persistent workspace/thread state

### CLI REPL (`crates/cowork-cli/`)

Minimal readline-based interface:

- Connects to server via JSON-RPC WebSocket
- Supports `--yolo` mode: no approval prompts, commands run outside the OS sandbox

## Data Flow

### Message Flow

JSON-RPC flow (`cowork.jsonrpc.v1` subprotocol):

```
1. Client connects → WebSocket negotiation with cowork.jsonrpc.v1 subprotocol
2. Client sends thread/start or thread/resume → session binds to thread
3. Client sends turn/start with user message → turn begins
4. Server streams notifications: turn/started, item/started, item/agentMessage/delta, item/completed, turn/completed
5. If approval needed → server sends JSON-RPC request → client responds
6. Turn completes → turn/completed notification
```

Canonical chat UI updates are JSON-RPC notifications. `crates/cowork-server/src/jsonrpc.rs` maps session turn events into `turn/*`, `item/*`, and `cowork/session/*` notifications, and `crates/cowork-storage/src/lib.rs` writes the notification stream to the thread journal for replay.

### Session Persistence

Sessions are stored in SQLite (`~/.cowork/sessions.db`):

- **sessions** table — Metadata (status, workspace, provider/model, message count, `last_event_seq`, timestamps)
- **session_state** table — Materialized turn/provider state (`system_prompt`, `messages_json`, `todos_json`, `harness_context_json`)
- **session_snapshots** table — Projected client replay snapshots (`SessionSnapshot`)
- **session_events** / **thread_journal_events** — Append-only semantic and monotonic `seq` JSON-RPC replay logs
- **tasks** & `task_*` tables — Durable Task mode briefs, DAG work items, claims, questions, and artifact versions

Resume semantics:

1. Try warm in-memory binding
2. If missing, load from SQLite (cold rehydrate) and replay monotonic journal events (`afterSeq`) or snapshot fallback
3. If not found, create new session

## Configuration Hierarchy

Configuration merges across three tiers (each overrides the previous):

```
┌─────────────────────────────────────────┐
│ Environment Variables (highest priority) │
│ AGENT_PROVIDER, AGENT_MODEL, etc.       │
└────────────────────┬────────────────────┘
                     │ overrides
                     ▼
┌─────────────────────────────────────────┐
│ Project Config (.cowork/config.json)    │
│ Project-specific settings               │
└────────────────────┬────────────────────┘
                     │ overrides
                     ▼
┌─────────────────────────────────────────┐
│ User Config (~/.cowork/config/config.json) │
│ User's global defaults                  │
└────────────────────┬────────────────────┘
                     │ overrides
                     ▼
┌─────────────────────────────────────────┐
│ Built-in Defaults (config/defaults.json)│
│ System defaults                         │
└─────────────────────────────────────────┘
```

## Extension Points

### Adding a New Tool

1. Add the tool implementation in `crates/cowork-tools/src/`
2. Register the tool in `crates/cowork-tools/src/lib.rs`
3. Add targeted tests under `crates/cowork-tools/` or `test/`

### Adding a WebSocket Message

1. Add JSON-RPC request/result/notification schemas in `crates/cowork-protocol/src/schemas.rs`, register the method in `crates/cowork-protocol/src/ws_jsonrpc_schema.json` (`crates/cowork-protocol/src/methods.rs`), and update client control schemas in `src/shared/jsonrpcControlSchemas.ts`
2. Add a `SessionEvent` type in `src/shared/protocol.ts` when consumed by clients
3. Add handler in `crates/cowork-server/src/` or `crates/cowork-harness/`
4. Document in `docs/websocket-protocol.md` and run `bun run docs:generate-jsonrpc` + `bun run docs:check`

### Adding a Provider

Static provider metadata lives in `config/providers.json` (Rust: `crates/cowork-config/src/provider_specs.rs`; TypeScript: generated `src/generated/providerSpecs.ts`). The full checklist is in [`agent_docs/adding-models.md`](../agent_docs/adding-models.md#adding-a-provider).

1. OpenAI-compatible Chat Completions provider: add a `config/providers.json` entry, the matching `ProviderName` variant in `crates/cowork-config/src/providers.rs`, `config/models/<provider>/*.json` (imported in `src/models/registry.ts`), optional quirks in `crates/cowork-providers/src/chat_completions/quirks.rs`, and the id in the provider enums of `crates/cowork-protocol/src/ws_jsonrpc_schema.json`; then run `bun run providers:generate` and `bun run docs:generate-jsonrpc`.
2. New wire protocol: additionally add a `ProviderWireProtocol` variant, a transport module in `crates/cowork-providers/src/` (see `anthropic_messages.rs` / `google_interactions.rs`), its branch in `select_provider_transport` (`crates/cowork-server/src/turn_runner.rs`), and legacy replay conversion in `crates/cowork-inference/src/legacy_messages.rs` when it carries provider-specific state.
3. `bun run docs:check` fails when the generated module is stale or provider enums/default models drift.

### Adding a Skill

1. Create `skills/my-skill/SKILL.md` with YAML front-matter
2. Include `name`, `description`, optional `triggers`
3. Skill is auto-discovered on server start

## Security Model

### Command Approval

Not all commands are auto-approved. Risk classification:


| Risk Level      | Examples                        | Behavior                 |
| --------------- | ------------------------------- | ------------------------ |
| Safe            | `ls`, `git status`, `npm test`  | Auto-approved            |
| Review Required | `rm`, `git push`, `npm publish` | Requires approval        |
| Dangerous       | `rm -rf /`, `git push --force`  | Always requires approval |


### Path Permissions

Write operations are restricted to:

- Working directory (default)
- Output directory (if configured)
- Explicitly allowed paths

### Secrets Handling

- API keys stored in `~/.cowork/auth/` (never in project config)
- MCP credentials stored separately from server configs
- Environment variables preferred for CI/CD

## Performance Considerations

### Streaming

- Model responses stream in real-time via JSON-RPC `item/*` notifications (`item/started`, `item/agentMessage/delta`, `item/reasoning/delta`, `item/completed`)
- Tool outputs are streamed incrementally
- Large outputs are truncated with file-based fallback into `.cowork/.cowork-scratchpad/`

### Caching

- Skills are cached after first load
- Session history persisted in SQLite across restarts
- MCP tool definitions cached per server connection

### Concurrency

- Multiple sessions can connect to the same server
- Each session is isolated (independent history, state)
- Turn execution is single-threaded per session

## See Also

- [WebSocket Protocol Reference](websocket-protocol.md) — Full message contract
- [Session Storage Architecture](session-storage-architecture.md) — Persistence details
- [Harness Config Guide](harness/config.md) — Config precedence and harness/runtime flags
- [Bundling & Integration Guide](bundling-guide.md) — How to build custom apps on top of the cowork server
- [Custom Tools Guide](custom-tools.md) — Tool extension and customization reference
