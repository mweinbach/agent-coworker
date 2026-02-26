# Architecture Overview

This document provides a comprehensive overview of the agent-coworker architecture for developers and users who want to understand how the system works.

## High-Level Architecture

Agent-coworker follows a **WebSocket-first** architecture where the server manages all business logic and clients are thin rendering layers.

```
┌─────────────────────────────────────────────────────────────────┐
│                         Clients                                  │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────────────────┐ │
│  │   TUI   │  │   CLI   │  │ Desktop │  │ Portal (Next.js)    │ │
│  │(OpenTUI)│  │  REPL   │  │(Electron)│ │ Web Dashboard       │ │
│  └────┬────┘  └────┬────┘  └────┬────┘  └──────────┬──────────┘ │
└───────┼────────────┼────────────┼──────────────────┼────────────┘
        │            │            │                  │
        └────────────┴────────────┴──────────────────┘
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
│ (session.ts)  │    │  (agent.ts)     │    │   (mcp/)      │
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
- **Protocol Handling**: Validates and routes `ClientMessage` types to appropriate handlers
- **Turn Orchestration**: Manages the agent turn lifecycle (start, stream, complete)
- **State Persistence**: SQLite-based session storage with backup/restore

**Key Files:**
- `startServer.ts` — Server initialization and WebSocket routing
- `session.ts` — Per-session state, message history, and turn execution
- `protocol.ts` — TypeScript types for `ClientMessage` and `ServerEvent` unions
- `sessionBackup.ts` — Filesystem backup and checkpoint management

### 2. Agent Loop (`src/agent.ts`)

The agent loop is where the AI reasoning happens:

```
User Message → System Prompt + History + Tools → AI Model → Tool Calls → Results → Repeat
```

**Key Function:** `createRunTurn()` — Factory that returns a `runTurn()` function with injectable dependencies (for testing).

**Turn Lifecycle:**
1. Build system prompt with skills, memory, and context
2. Call the configured LLM runtime (`pi`) with model, tools, and history
3. Execute tool calls (with approval for risky operations)
4. Stream results back to client via WebSocket events
5. Update message history

The runtime boundary lives in `src/runtime/`:
- `createRuntime()` selects the PI runtime
- `piRuntime` handles provider streaming/tool loops and maps events into the existing stream contract

### 3. Tools (`src/tools/`)

Built-in capabilities exposed to the agent:

| Tool | Purpose | Approval Required |
|------|---------|-------------------|
| `bash` | Shell command execution | Conditional |
| `read` | Read file contents | No |
| `write` | Create/overwrite files | Yes (write path) |
| `edit` | In-place text edits | Yes (write path) |
| `glob` | Find files by pattern | No |
| `grep` | Search file contents | No |
| `webSearch` | Search the web | No |
| `webFetch` | Fetch web content | No |
| `ask` | Ask user questions | No |
| `todoWrite` | Update progress list | No |
| `spawnAgent` | Delegate to sub-agent | No |
| `skill` | Load skill instructions | No |
| `memory` | Read/write persistent memory | No |

Each tool is a factory function accepting a `ToolContext` with access to:
- `config` — Current agent configuration
- `log()` — Emit log output
- `askUser()` — Prompt user for input
- `approveCommand()` — Request approval for risky commands
- `updateTodos()` — Update progress indicators

### 4. Providers (`src/providers/`)

Model provider integrations with unified interface:

| Provider | Auth Methods | Default Model |
|----------|--------------|---------------|
| Google | API Key | `gemini-3-flash-preview` |
| OpenAI | API Key | `gpt-5.2` |
| Anthropic | API Key | `claude-4-6-sonnet` |
| Codex CLI | OAuth, API Key | (uses OpenAI) |
| Claude Code | OAuth, API Key | (uses Anthropic) |

Each provider exports:
- `defaultModel` — Model ID to use
- `keyCandidates` — Environment variable names to check
- `createModel()` — Provider model adapter (headers/auth metadata for runtime/tooling paths)

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
2. User: `~/.agent/skills/`
3. Built-in: `skills/`

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

### TUI (`apps/TUI/`)

Built with OpenTUI + Solid.js (not React):

**Context Provider Stack:**
```
ExitProvider → KVProvider → ThemeProvider → DialogProvider
→ SyncProvider → KeybindProvider → LocalProvider → RouteProvider
→ PromptProvider → App
```

**Key Features:**
- 31 built-in themes
- Command palette (`Ctrl+K`)
- Tool-specific renderers
- Session management
- Sidebar with context/todos

### CLI REPL (`src/cli/`)

Minimal readline-based interface:

- Connects to server via WebSocket
- Supports `--yolo` mode to bypass approvals
- Persistent prompt history in `~/.cowork/state/prompt-history.jsonl`

### Desktop (`apps/desktop/`)

Electron + React wrapper:

- Native menus and dialogs
- Desktop notifications
- Per-workspace server processes
- Persistent workspace/thread state

### Portal (`apps/portal/`)

Next.js web dashboard:

- Real-time harness monitoring
- Session visualization
- SLO dashboards

## Data Flow

### Message Flow

```
1. Client connects → server_hello (sessionId, config, capabilities)
2. Client sends user_message → session becomes busy
3. Agent processes → emits model_stream_chunk, tool calls, etc.
4. Agent requests approval → approval event → client responds
5. Turn completes → assistant_message → session becomes idle
```

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
4. Add tests in `test/tools/`

### Adding a WebSocket Message

1. Add type to `ClientMessage` or `ServerEvent` in `src/server/protocol.ts`
2. Add validation in `safeParseClientMessage()` (for client messages)
3. Add handler in `src/server/startServer.ts` or `src/server/session.ts`
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

| Risk Level | Examples | Behavior |
|------------|----------|----------|
| Safe | `ls`, `git status`, `npm test` | Auto-approved |
| Review Required | `rm`, `git push`, `npm publish` | Requires approval |
| Dangerous | `rm -rf /`, `git push --force` | Always requires approval |

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
- Prompt history persisted across sessions
- MCP tool definitions cached per server connection

### Concurrency

- Multiple sessions can connect to the same server
- Each session is isolated (independent history, state)
- Turn execution is single-threaded per session

## See Also

- [WebSocket Protocol Reference](websocket-protocol.md) — Full message contract
- [Session Storage Architecture](session-storage-architecture.md) — Persistence details
- [Configuration Guide](configuration.md) — All config options
- [Tools Reference](tools-reference.md) — Tool documentation
