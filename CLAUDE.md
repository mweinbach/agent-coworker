# CLAUDE.md

This file provides repository context for coding agents working with this repository.

## What This Is

`agent-coworker` is an AI coworker agent built on Bun + TypeScript with pluggable runtime adapters. It provides two primary interfaces: a desktop app (Electron) and a plain CLI REPL, plus a headless WebSocket server. It ships a built-in toolbelt (file ops, shell, web, code exploration) with a command approval system for risky operations.

## Commands

```bash
bun install              # Install dependencies
bun test                 # Run all tests
bun test test/agent      # Run tests matching a pattern (e.g. agent, tools, session)
bun run start            # Run desktop app (starts server automatically)
bun run cli              # Run CLI REPL
bun run serve            # Run WebSocket server standalone
bun run dev              # Watch mode (watches CLI entry src/index.ts)
```

There is no linter or formatter configured. TypeScript strict mode is the primary code quality check (`tsc --noEmit` via tsconfig).

## Architecture

### Entry Points

- `src/index.ts` — Main terminal entry; launches the CLI REPL. Default (`bun run start`) launches the desktop app.
- `src/server/index.ts` — Standalone WebSocket server
- `src/cli/repl.ts` — CLI REPL (connects to server via JSON-RPC WebSocket)

### Core Loop

`src/agent.ts` contains the agent turn logic. `createRunTurn()` is a factory that accepts injectable dependencies (for testing) and returns `runTurn()`. Each turn assembles the effective tool set, injects turn-scoped context (including harness context), and delegates model execution to the configured runtime.

### Server & Protocol

`src/server/session/AgentSession.ts` — `AgentSession` manages per-session state: message history, turn execution, backups, harness context, and pending ask/approval requests via deferred promises. The server uses a JSON-RPC-lite protocol over WebSocket (`cowork.jsonrpc.v1`). Internal event types are defined as `SessionEvent` in `src/server/protocol.ts`; the JSON-RPC protocol types are in `src/server/jsonrpc/protocol.ts`.

### Provider System

`src/providers/` — Provider/runtime integrations plus provider catalog/auth helpers. Provider selection flows through config with env var override (`AGENT_PROVIDER`).

### Tool System

`src/tools/index.ts` — `createTools(ctx: ToolContext)` produces the full tool map. Each tool is a factory function in its own file under `src/tools/`. Tools receive a `ToolContext` (config, log, askUser, approveCommand, updateTodos). MCP tools are loaded separately and merged in at runtime, namespaced as `mcp__{serverName}__{toolName}`.

### Configuration

Three-tier hierarchy (each overrides the previous): built-in (`config/defaults.json`) → user (`~/.agent/config.json`) → project (`.agent/config.json`). Environment variables (`AGENT_PROVIDER`, `AGENT_MODEL`, etc.) override all. Config loading and deep-merge logic is in `src/config.ts`.

The same three-tier pattern applies to skills (`skills/` directories), memory (`memory/` directories), and MCP server configs (`mcp-servers.json` files).

### Key Patterns

- **Dependency injection via factories**: `createRunTurn()`, `createTools()`, and tool factories all accept overridable deps, making them testable without mocks on module scope.
- **Deferred promises**: `AgentSession` uses deferred promise maps for async ask/approval flows between the WebSocket protocol and the agent turn.
- **Zod schemas**: Tools define their parameters with Zod, consumed by the AI SDK.
- **ESM throughout**: The project uses `"type": "module"` with ESNext target. Imports use explicit `.ts` extensions in some places; Bun handles resolution.

## WebSocket-First Development Rule

**All new features and capabilities MUST be built on top of the CLI/core logic and exposed via WebSocket controls.** The server + protocol layer is the canonical interface that every UI (desktop app, CLI REPL, or any future frontend) consumes. Never build logic directly into a specific UI — wire it through the server so any client can use it.

When adding a new JSON-RPC method or notification:

1. Add the route handler in the appropriate file under `src/server/jsonrpc/routes/`.
2. Register it in `src/server/jsonrpc/routes/index.ts`.
3. If it produces streaming events, add projection logic in `src/server/jsonrpc/notificationProjector.ts` or `src/server/jsonrpc/threadJournalNotificationProjector.ts`.
4. **Update `docs/websocket-protocol.md`** with the new method, params, result, and where it fits in the flow.

The protocol doc (`docs/websocket-protocol.md`) is the source of truth for anyone building an alternative UI. Keep it accurate and complete.
The harness docs index (`docs/harness/index.md`) is the system-of-record map for harness behavior, context, and runbook guidance.

## Testing

Tests live in `test/` and use Bun's built-in test runner (`bun:test`). Test files follow `*.test.ts` naming. Provider-specific tests are under `test/providers/`. Tests extensively use the dependency injection factories to mock AI SDK calls without patching modules.

**Always run tests while doing work.**

**Commits & PRs**

- Commit messages: Follow the [Conventional Commits](https://www.conventionalcommits.org/) format (e.g. `fix:`, `feat:`, `refactor:`, `chore:`, `test:`, `docs:`). Liberally make commits as you go.
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
### 3. Self-Improvement
After ANY correction from the user, distill the pattern into a durable rule and add it to the Engineering Rules section below.
Apply existing rules before editing, not after.
Review the rules at session start.
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
### 6. Autonomous Bug Fixing
When given a bug report: just fix it. Don't ask for hand-holding Point at logs, errors, failing tests then resolve them
Zero context switching required from the user
Go fix failing CI tests without being told how
## Task Management
1. **Plan First**: Write a plan with checkable items using the built-in todo/tasks tool.
2. **Verify Plan**: Check in before starting implementation.
3. **Track Progress**: Mark items complete as you go.
4. **Explain Changes**: High-level summary at each step.

## Core Principles
**Simplicity First**: Make every change as simple as possible. Impact minimal code.
**No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
**Minimal Impact**: Changes should only touch what's necessary. Avoid introducing bugs.

## Engineering Rules

Durable rules distilled from prior corrections. Apply before editing, not after. When the user corrects you, add the new rule here.

### PR Review Workflow
- Re-fetch unresolved review threads and verify each comment against current `HEAD` before editing — don't assume an open thread is still real.
- After fixing locally, reply on each addressed GitHub thread and resolve it in the same pass.
- Re-scan the latest SHA for both unresolved threads AND newer top-level review bodies before declaring PR feedback handled.
- When the user asks for subagent verification, spawn one targeted subagent per reported issue before editing — never batch.
- Before claiming a comment is fixed, re-check the exact current branch path it points at.
- Inspect the latest GitHub Actions run when babysitting a PR; flaky lanes (e.g. remote MCP smoke) can still be the real blocker after comments resolve.

### Scope & Plan Discipline
- When the user narrows a contract, apply that exact direction; don't preserve broader backward-compat assumptions.
- When the user expands scope mid-task ("include the failures you found"), treat every surfaced error as in-scope.
- When cleaning unrelated local diffs, never revert adjacent user-wanted changes without confirming intent.
- Carry user-added requirements (commit trailers, contract changes) forward into the plan and the eventual commit message.
- When the user explicitly accepts a change ("delete the workflow"), execute that — don't keep refining the prior approach.
- Confirm the active branch is rebased on current `origin/main` before stacking multi-commit work; if `main` moved mid-feature, rebase before more branch work.
- When the user says a surface is "retired" or "archived", do the full deletion in one pass: code, tests, docs, entrypoints, now-unused deps. No dormant compatibility shells.

### Verification Before Done
- Run the same lane CI runs (`bun test --max-concurrency 1` plus `bun run typecheck` and `bun run docs:check`); cross-file Bun module mocks can pass in isolation and still fail in the full suite.
- For desktop UI changes, verify the live running app via the Playwright/CDP workflow with `COWORK_ELECTRON_REMOTE_DEBUG=1`. Tests alone are not proof.
- For Expo mobile changes, run an explicit Metro bundle path (e.g. `expo export`) — `run:ios`/`run:android` success alone misses repo-root import and Babel/plugin drift.
- Before creating a GitHub release from a local tag, confirm the tag has been pushed to `origin`.

### Repo-Specific Contracts
- **Auth home**: `~/.cowork` is the only auth home. Never derive auth from a workspace `.agent` path. Pin `HOME` in tests that fabricate auth state.
- **Codex auth**: lives only at `~/.cowork/auth/codex-cli/auth.json`. No copies, restores, or fallbacks to other tool stores.
- **Workspace settings**: any new field must round-trip through `PersistenceService.sanitizeWorkspaces()` — partial sanitizer updates silently drop fields on save/load. Audit every new field, not just the headline one.
- **Tool prompt guidance**: use actual callable tool IDs (`bash`, `glob`, `grep`); generic names like `shell`/`search` route the model into nonexistent calls.
- **JSON-RPC projector**: item IDs must be occurrence-stable within a turn. Always forward `itemId` on `item/agentMessage/delta`. Close the current assistant item before reasoning/tool phases. Don't key assistant items only by `turnId`.
- **New provider**: audit every provider-gated tool factory in `src/tools/` and add a `createTools(...)` regression — missing branches crash PI tool mapping before the turn starts.
- **MCP tool schemas**: normalize tuple-style JSON Schema arrays (`items: [{...}, {...}]`) to provider-safe object/boolean nodes before registration; OpenAI-compatible runtimes reject otherwise.
- **Settings toggles**: shared `Switch` for binary on/off; reserve `Checkbox` for checklist selection.
- **Optimistic chat sends**: preserve `clientMessageId` through `turn/start`/`turn/steer` and the projected `item/userMessage` notifications, or duplicate user bubbles render.
- **OAuth**: never share one constant between listener bind host and advertised redirect host. Bind both `::1` and `127.0.0.1` when using `localhost`. Pin the production redirect URI to the provider-accepted host and cover the advertised URL in tests.
- **Bun-compiled sidecars**: never read `package.json` via runtime `__dirname` paths — compiled binaries run from `/$bunfs`. Use bundled imports or build-time injection.
- **Three-tier inherit semantics**: never overload `undefined` for both "no-op" and "inherit"; add a dedicated clear/inherit path end-to-end so reset-to-default deletes persisted overrides instead of pinning the current built-in.
- **Tool output overflow**: spill-to-workspace truncation is the default; the `read` tool is exempted so large file contents stay inline when explicitly requested.

### Desktop UI Patterns
- Use the Playwright/CDP workflow (`COWORK_ELECTRON_REMOTE_DEBUG=1`) before declaring a UI change done.
- For shared dialogs/modals: portal to `document.body`, own the centered overlay, never let the backdrop sit at a higher `z-*` than the dialog body.
- For desktop renderer wrappers re-exporting core types, prefer repo-root relative imports over `@cowork/*` aliases — `electron-vite` accepts the alias in TS but Rollup can fail at renderer build.
- For Electron preloads, bundle deps like `zod` into `out/preload/preload.js`; do not externalize runtime deps.
- For Electron main-process CommonJS deps, use `createRequire` interop, not named ESM imports.
- For dense desktop settings panels, prefer compact controls and separators over nested rounded subcards.
