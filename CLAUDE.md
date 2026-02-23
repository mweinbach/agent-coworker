# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

`agent-coworker` is a terminal-first AI coworker agent built on Bun + Vercel AI SDK. It provides three interfaces: a TUI (OpenTUI + Solid.js, default), a plain CLI REPL, and a headless WebSocket server. It ships a built-in toolbelt (file ops, shell, web, code exploration) with a command approval system for risky operations.

## Commands

```bash
bun install              # Install dependencies
bun test                 # Run all tests
bun test test/agent      # Run tests matching a pattern (e.g. agent, tools, session)
bun run start            # Run TUI (starts server automatically)
bun run tui              # Run TUI standalone (connect to existing server)
bun run cli              # Run CLI REPL
bun run serve            # Run WebSocket server standalone
bun run dev              # Watch mode (rebuilds on src/ changes)
```

There is no linter or formatter configured. TypeScript strict mode is the primary code quality check (`tsc --noEmit` via tsconfig).

## Architecture

### Entry Points

- `src/index.ts` — Main entry; routes to TUI or CLI based on `--cli` flag.
- `apps/TUI/index.tsx` — TUI entry (OpenTUI + Solid.js). Default TUI. Can also run standalone with `bun run tui`.
- `src/server/index.ts` — Standalone WebSocket server
- `src/cli/repl.ts` — CLI REPL (connects to server via WebSocket)

### Core Loop

`src/agent.ts` contains the agent turn logic. `createRunTurn()` is a factory that accepts injectable dependencies (for testing) and returns `runTurn()`. Each turn calls `generateText()` from the Vercel AI SDK with the model, system prompt, message history, and tools.

### Server & Protocol

`src/server/session.ts` — `AgentSession` manages per-session state: message history, turn execution, and pending ask/approval requests via deferred promises. The WebSocket protocol is defined in `src/server/protocol.ts` with typed `ClientMessage` and `ServerEvent` unions.

### Provider System

`src/providers/index.ts` — Registry of `ProviderDefinition` objects. Each provider (`google`, `openai`, `anthropic`, `codex-cli`, `claude-code`) exports `defaultModel`, `keyCandidates`, and `createModel()`. Provider selection flows through config with env var override (`AGENT_PROVIDER`).

### Tool System

`src/tools/index.ts` — `createTools(ctx: ToolContext)` produces the full tool map. Each tool is a factory function in its own file under `src/tools/`. Tools receive a `ToolContext` (config, log, askUser, approveCommand, updateTodos). MCP tools are loaded separately and merged in at runtime, namespaced as `mcp__{serverName}__{toolName}`.

### Configuration

Three-tier hierarchy (each overrides the previous): built-in (`config/defaults.json`) → user (`~/.agent/config.json`) → project (`.agent/config.json`). Environment variables (`AGENT_PROVIDER`, `AGENT_MODEL`, etc.) override all. Config loading and deep-merge logic is in `src/config.ts`.

The same three-tier pattern applies to skills (`skills/` directories), memory (`memory/` directories), and MCP server configs (`mcp-servers.json` files).

### TUI (`apps/TUI/`)

The default TUI is built with OpenTUI + Solid.js (not React). It has its own `tsconfig.json` that overrides `jsxImportSource` to `@opentui/solid`. Key structure:

- `apps/TUI/index.tsx` — Entry point, provider stack, `runTui()` export
- `apps/TUI/app.tsx` — Route switch (Home vs Session) + dialog overlay
- `apps/TUI/context/` — 9 context providers (exit, kv, theme, dialog, sync, keybind, local, route, prompt)
- `apps/TUI/routes/home.tsx` — Home screen (logo, prompt, tips, footer)
- `apps/TUI/routes/session/` — Session screen (header, feed, sidebar, footer, permission/question prompts)
- `apps/TUI/component/` — Shared components (logo, tips, spinner, markdown, border, prompt input)
- `apps/TUI/component/message/` — Message renderers (user, assistant, text-part, reasoning-part, tool-part)
- `apps/TUI/component/tool/` — Tool-specific renderers (bash, read, write, edit, glob, grep, web, todo, generic)
- `apps/TUI/ui/` — Reusable dialog primitives (select, confirm, prompt, alert, help)
- `apps/TUI/util/` — Utilities (format, clipboard, terminal, signal, editor, transcript)

The `SyncProvider` bridges the existing `AgentSocket` WebSocket client into Solid.js reactive stores. The TUI never touches the agent or AI SDK directly — everything goes through WebSocket.

### Key Patterns

- **Dependency injection via factories**: `createRunTurn()`, `createTools()`, and tool factories all accept overridable deps, making them testable without mocks on module scope.
- **Deferred promises**: `AgentSession` uses deferred promise maps for async ask/approval flows between the WebSocket protocol and the agent turn.
- **Zod schemas**: Tools define their parameters with Zod, consumed by the AI SDK.
- **ESM throughout**: The project uses `"type": "module"` with ESNext target. Imports use explicit `.ts` extensions in some places; Bun handles resolution.

## WebSocket-First Development Rule

**All new features and capabilities MUST be built on top of the CLI/core logic and exposed via WebSocket controls.** The server + protocol layer is the canonical interface that every UI (TUI, CLI REPL, or any future frontend) consumes. Never build logic directly into a specific UI — wire it through the server so any client can use it.

When adding a new WebSocket message type or event:

1. Add the type to `ClientMessage` or `ServerEvent` in `src/server/protocol.ts`.
2. Add validation in `safeParseClientMessage()` if it's a client message.
3. Add the handler in `src/server/startServer.ts` (message routing) and/or `src/server/session.ts` (session logic).
4. **Update `docs/websocket-protocol.md`** with the new message format, fields, example JSON, and where it fits in the flow.

The protocol doc (`docs/websocket-protocol.md`) is the source of truth for anyone building an alternative UI. Keep it accurate and complete.

## Testing

Tests live in `test/` and use Bun's built-in test runner (`bun:test`). Test files follow `*.test.ts` naming. Provider-specific tests are under `test/providers/`. Tests extensively use the dependency injection factories to mock AI SDK calls without patching modules.

**Always run tests while doing work.**

**Commits & PRs**

- Commit messages: Follow the [Conventional Commits](https://www.conventionalcommits.org/) format. Liberally make commits as you go. 
- Pull Requests: Ensure all tests pass and provide a clear description of the changes.

## Workflow Orchestration

### 1. Plan Node Default
Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
If something goes sideways, STOP and re-plan immediately don't keep pushing
Use plan mode for verification steps, not just building
Write detailed specs upfront to reduce ambiguity
### 2. Subagent Strategy
Use subagents liberally to keep main context window clean
Offload research, exploration, and parallel analysis to subagents
For complex problems, throw more compute at it via subagents
One tack per subagent for focused execution
### 3. Self-Improvement Loop
After ANY correction from the user: update `tasks/lessons.md with the pattern
Write rules for yourself that prevent the same mistake
Ruthlessly iterate on these lessons until mistake rate drops
Review lessons at session start for relevant project
### 4. Verification Before Done
Never mark a task complete without proving it works
Diff behavior between main and your changes when relevant
Ask yourself: "Would a staff engineer approve this?"
Run tests, check logs, demonstrate correctness
### 5. Demand Elegance (Balanced)
For non-trivial changes: pause and ask "is there a more elegant way?"
If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
Skip this for simple, obvious fixes don't over-engineer
Challenge your own work before presenting it
### 6. Autonomous Bug Fizing
When given a bug report: just fix it. Don't ask for hand-holding Point at logs, errors, failing tests then resolve them
Zero context switching required from the user
Go fix failing CI tests without being told how
## Task Management
1. **Plan First**: Write plan to tasks/todo.md with checkable items
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Mark items complete as you go
4. **Explain Changes**: High-level summary at each step
5. **Document Results**: Add review section to tasks/todo.md`
6. **Capture Lessons**: Update `tasks/lessons.md after corrections
## Core Principles
**Simplicity First**: Make every change as simple as possible. Impact minimal code.
**No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
**Minimat Impact**: Changes should only touch what's necessary. Avoid introducing bugs.
