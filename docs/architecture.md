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
                    ┌─────────────────────┐
                    │   WebSocket Server  │
                    │   (src/server/)     │
                    └──────────┬──────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
        ▼                      ▼                      ▼
┌───────────────┐    ┌─────────────────┐    ┌───────────────┐
│ AgentSession  │    │  Agent Loop     │    │  MCP Manager  │
│(AgentSession) │    │  (agent.ts)     │    │   (mcp/)      │
└───────────────┘    └─────────────────┘    └───────────────┘
        │                      │                      │
        │                      ▼                      │
        │            ┌─────────────────┐             │
        │            │   AI Providers  │             │
        │            │ (providers/)    │             │
        │            └─────────────────┘             │
        │                      │                      │
        └──────────────────────┼──────────────────────┘
                               ▼
                    ┌─────────────────────┐
                    │   Tool Execution    │
                    │   (src/tools/)      │
                    └─────────────────────┘
```

## Core Components

### 1. WebSocket Server (`src/server/`)

The server is the heart of the system. It handles:

- **Session Management**: Each WebSocket connection gets an `AgentSession` instance
- **Protocol Handling**: Validates JSON-RPC requests and notifications, then routes them to the appropriate handlers
- **Turn Orchestration**: Manages the agent turn lifecycle (start, stream, complete)
- **State Persistence**: SQLite-based session storage with backup/restore

**Key Files:**

- `startServer.ts` — Server initialization and WebSocket routing
- `session/AgentSession.ts` — Per-session orchestration facade over focused managers (`TurnExecutionManager`, `HistoryManager`, `InteractionManager`, `McpManager`, `PersistenceManager`, `ProviderAuthManager`, `ProviderCatalogManager`, `SessionAdminManager`, `SkillManager`, etc.)
- `protocol.ts` — Internal `SessionEvent` payload types used by session managers, control envelopes, and persistence
- `jsonrpc/` — JSON-RPC transport, schemas, routes, and notification projectors
- `sessionBackup/` — Filesystem backup and checkpoint management (multiple modules: `command.ts`, `snapshot.ts`, `tar.ts`, `delta.ts`, etc.)
- `sessionDb/` — SQLite persistence (`repository.ts`, `migrations.ts`, `writeCoordinator.ts`, etc.)

### 2. Agent Loop (`src/agent.ts`)

The agent loop is where the AI reasoning happens:

```
User Message → System Prompt + History + Tools → AI Model → Tool Calls → Results → Repeat
```

**Key Function:** `createRunTurn()` — Factory that returns a `runTurn()` function with injectable dependencies (for testing).

**Turn Lifecycle:**

1. Build system prompt with skills, memory, and context
2. Call the configured LLM runtime (`google-interactions` for Google, `pi` for Anthropic/OpenCode/local-compatible providers, `openai-responses` for OpenAI/Codex) with model, tools, and history
3. Execute tool calls (with approval for risky operations)
4. Stream results back to client via WebSocket events
5. Update message history

The runtime boundary lives in `src/runtime/`:

- `createRuntime()` selects `google-interactions`, `pi`, or `openai-responses`; providers are normalized back to their supported default runtime when stale saved values are encountered
- `googleInteractionsRuntime` handles Gemini Interactions API turns, including server-side interaction continuation and Google-native stream/raw event handling
- `piRuntime` handles Anthropic/OpenCode/local-compatible streaming/tool loops and shared tool execution utilities
- `openaiResponsesRuntime` handles OpenAI and Codex Responses flows, including the ChatGPT Codex backend path

### 3. Tools (`src/tools/`)

Built-in capabilities exposed to the agent:


| Tool           | Purpose                        | Approval Required |
| -------------- | ------------------------------ | ----------------- |
| `bash`         | Shell command execution        | Conditional       |
| `read`         | Read file contents             | No                |
| `write`        | Create/overwrite files         | Yes (write path)  |
| `edit`         | In-place text edits            | Yes (write path)  |
| `glob`         | Find files by pattern          | No                |
| `grep`         | Search file contents           | No                |
| `webSearch`    | Search the web                 | No                |
| `webFetch`     | Fetch web content              | No                |
| `ask`          | Ask user questions             | No                |
| `todoWrite`    | Update progress list           | No                |
| `spawnAgent`   | Delegate to a child agent      | No                |
| `skill`        | Load skill instructions        | No                |
| `memory`       | Read/write persistent memory   | No                |
| `notebookEdit` | Edit Jupyter notebook cells    | Yes (write path)  |
| `usage`        | Query session token/cost usage | No                |


When agent control is enabled, the following tools are also available: `listAgents`, `sendAgentInput`, `waitForAgent`, `inspectAgent`, `resumeAgent`, `closeAgent`.

`webSearch` is backed by either Exa or Parallel depending on configured credentials (`EXA_API_KEY` / `PARALLEL_API_KEY`). Supporting modules like `exa.ts`, `parallel.ts`, and `api-keys.ts` are implementation helpers, not standalone tools.

Each tool is a factory function accepting a `ToolContext` with access to:

- `config` — Current agent configuration
- `log()` — Emit log output
- `askUser()` — Prompt user for input
- `approveCommand()` — Request approval for risky commands
- `updateTodos()` — Update progress indicators

### 4. Providers (`src/providers/`)

There are 12 registered providers: `google`, `openai`, `anthropic`, `bedrock`, `together`, `fireworks`, `nvidia`, `lmstudio`, `baseten`, `opencode-go`, `opencode-zen`, and `codex-cli`.

Each provider is registered in `src/providers/index.ts` and model metadata lives in per-provider config files under `config/models/<provider>/`.

Provider selection flows through config with env var override (`AGENT_PROVIDER`). The runtime adapter (`google-interactions`, `pi`, or `openai-responses` in `src/runtime/`) is determined by the provider.

### 5. MCP Integration (`src/mcp/`)

Model Context Protocol servers extend the agent with external tools:

- **Discovery**: Tools are namespaced as `mcp__{serverName}__{toolName}`
- **Auth**: Supports `none`, `api_key`, and `oauth` modes
- **Lifecycle**: Dynamic connect/disconnect with health monitoring

**Config Locations (priority order):**

1. `.cowork/mcp-servers.json` (workspace)
2. `~/.cowork/config/mcp-servers.json` (user)
3. `config/mcp-servers.json` (built-in)

### 6. Skills (`skills/`, `.agent/skills/`)

Domain-specific instruction packages loaded on demand:

```
skills/
├── spreadsheet/SKILL.md   # Excel/CSV creation guidance
├── slides/SKILL.md        # PowerPoint/presentation guidance
├── pdf/SKILL.md           # PDF creation guidance
└── doc/SKILL.md           # Word document guidance
```

Skills are discovered from layered directories:

1. Project: `.agent/skills/`
2. Global: `~/.cowork/skills/`
3. User: `~/.agent/skills/`
4. Built-in: `skills/`

### 7. Observability (`src/observability/`)

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

### CLI REPL (`src/cli/`)

Minimal readline-based interface:

- Connects to server via JSON-RPC WebSocket
- Supports `--yolo` mode to bypass approvals

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

Canonical chat UI updates are JSON-RPC notifications. `src/server/jsonrpc/notificationProjector.ts` maps internal `SessionEvent` payloads into `turn/*`, `item/*`, and `cowork/session/*` notifications, while `src/server/jsonrpc/threadJournalNotificationProjector.ts` writes the same notification stream to the thread journal for replay.

### Session Persistence

Sessions are stored in SQLite (`~/.cowork/sessions.db`):

- **sessions** table — Metadata (status, message count, timestamps)
- **session_state** table — Materialized state (messages, todos, prompt)
- **session_events** table — Append-only event log

Resume semantics:

1. Try warm in-memory binding
2. If missing, load from SQLite (cold rehydrate)
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
│ Project Config (.agent/config.json)     │
│ Project-specific settings               │
└────────────────────┬────────────────────┘
                     │ overrides
                     ▼
┌─────────────────────────────────────────┐
│ User Config (~/.agent/config.json)      │
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

1. Create `src/tools/myTool.ts`
2. Export factory function accepting `ToolContext`
3. Register in `src/tools/index.ts`
4. Add targeted tests under `test/`

### Adding a WebSocket Message

1. Add JSON-RPC request/result/notification schemas in `src/server/jsonrpc/schema.ts` plus the relevant module in `src/server/jsonrpc/`
2. Add a `SessionEvent` type in `src/server/protocol.ts` only when server-internal session managers need a reusable event shape
3. Add handler in `src/server/jsonrpc/routes/` or the appropriate manager under `src/server/session/`
4. Document in `docs/websocket-protocol.md`

### Adding a Provider

1. Create `src/providers/myProvider.ts`
2. Export `defaultModel`, `keyCandidates`, `createModel()`
3. Register in `src/providers/index.ts`

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

- Model responses stream in real-time via `model_stream_chunk` events
- Tool outputs are streamed incrementally
- Large outputs are truncated with file-based fallback

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

