# Repository Guidelines

agent-coworker is a coworker agent built on Bun + TypeScript (ESM) with a WebSocket server and CLI REPL.

When you have access to subagents or agent teams, feel free to use them. Subagents are good for delegating tasks for searching and performing specific actions. Be specific with your delegation, and feel free to use them liberally.  

All logic for the application should be done in the harness itself, consider the desktop app just a UI layer. The only things that should be specific to that are things that are relavent, like UI layout or platform-specific behavior. All logic on how the agent works on the users system, saves files, etc should be done in the harness THEN exposed and connected to the UI layers via the websocket. 

## Project Structure & Module Organization

- `src/`: application code
- `src/server/`: WebSocket server, protocol, and session state
- `src/tui/`: thin TUI wrapper (archived, may be removed)
- `src/cli/`: CLI REPL and argument parsing
- `src/providers/`: model/provider integrations (OpenAI/Google/Anthropic and `*-cli`)
- `src/tools/`: built-in tools (`bash`, `read`, `write`, `webSearch`, etc.)
- `apps/TUI/`: main TUI built with OpenTUI + Solid.js (archived, may be removed)
- `apps/desktop/`: Electron desktop application
- `test/`: Bun tests (`*.test.ts`)
- `config/`: built-in defaults and MCP server defaults
- `prompts/`: system + sub-agent prompts
- `skills/`: bundled skill docs/assets used by the agent
- `docs/harness/index.md`: harness context/observability/SLO system-of-record map

## Build, Test, and Development Commands

- `bun install`: install dependencies.
- `bun run start`: run the desktop app (starts the server automatically).
- `bun run cli`: run the plain CLI REPL.
- `bun run serve`: run the server only.
- `bun run dev`: watch mode for local iteration.
- `bun test`: run the full test suite.

Example (CLI with initial workspace): `bun run cli -- --dir /path/to/project`. Desktop `bun run start` does not forward `--dir` (use in-app workspace selection).

Always run tests while doing work, make sure you run these tests.

## Coding Style & Naming Conventions

- TypeScript is `strict` (see `tsconfig.json`); prefer `async/await` and explicit types at module boundaries.
- Indentation is 2 spaces. Keep imports grouped (Node built-ins, deps, local).
- Naming: `camelCase` for values, `PascalCase` for types. Tests are `*.test.ts` and may add qualifiers (e.g. `agent.remote-mcp.grep.test.ts`).

## Testing Guidelines

- Use Bun’s runner (`import { describe, test, expect } from "bun:test"`).
- Keep tests deterministic: avoid network calls; isolate filesystem via temp dirs and use DI hooks/mocks where available (e.g. `__internal` shims, `mock.module()`).

## Commit & Pull Request Guidelines

- Commit messages must use [Conventional Commits](https://www.conventionalcommits.org/) format (e.g. `fix: …`, `feat: …`, `refactor: …`, `chore: …`, `test: …`, `docs: …`). Keep subjects short and imperative.
- PRs should include: what/why, how to test (`bun test`), and screenshots or a short recording for desktop app changes. Keep changes focused and add tests for fixes/features.

## WebSocket-First Development

All new features MUST be built on top of the CLI/core logic and exposed via WebSocket controls in the server protocol. UIs are thin clients that consume `ServerEvent`s and send `ClientMessage`s — never put business logic directly in a UI layer.

When adding a new WebSocket message or event:
1. Define the type in `src/server/protocol.ts` (`ClientMessage` / `ServerEvent` unions).
2. Add validation in `safeParseClientMessage()` for client messages.
3. Wire the handler in `src/server/startServer/dispatchClientMessage.ts` and/or the appropriate manager under `src/server/session/`.
4. **Document it in `docs/websocket-protocol.md`** — this is the source of truth for alternative UI builders.

## Security & Configuration Tips

- Don’t commit secrets or local state. `.env`, `.agent/`, `.cowork/`, `output/`, and `uploads/` are gitignored.
- Prefer environment variables (e.g. `OPENAI_API_KEY`) and local `.agent/config.json` / `.agent/mcp-servers.json` for developer setup. MCP server configs, auth, and session backups also live in `.cowork/` (project-level or `~/.cowork/`).
- `--yolo` bypasses command approvals; use only for local experiments.
- Make commits liberally as you go with meaningful detailed messages.

## Model Metadata Rules

When adding a new supported model:

- Add a dedicated config file under `config/models/<provider>/` and make that file the source of truth for the model.
- Include, at minimum: canonical `id`, `displayName`, `knowledgeCutoff`, `supportsImageInput`, `promptTemplate`, `providerOptionsDefaults`, and `isDefault` when applicable.
- Verify published model metadata against current vendor docs before landing it. If an exact cutoff or capability is not currently published, use an explicit conservative value like `Unknown` instead of guessing.
- Keep prompt/runtime behavior aligned with the registry entry. `supportsImageInput` must match both prompt instructions and runtime/tool payload handling.
- Update any related pricing/catalog tests and docs when model metadata changes.
- Do not add unsupported/custom model IDs as passthroughs. New models must be added to the registry explicitly before they are selectable.

## Electron Desktop App

For the Electron desktop app (`apps/desktop`):
- Start app in dev mode: `bun run desktop:dev`
- Set `COWORK_ELECTRON_REMOTE_DEBUG=1` when you need to expose a CDP port for external inspection or automation.
- Override `COWORK_ELECTRON_REMOTE_DEBUG_PORT` if `9222` is already in use.

## Cursor Cloud specific instructions

### Runtime

Bun is installed at `~/.bun/bin/bun`. Ensure `$BUN_INSTALL/bin` is on `PATH` (the update script handles this). No Docker or external services are required.

### Services

| Service | Command | Notes |
|---|---|---|
| WebSocket server | `bun run serve` | Listens on `ws://127.0.0.1:7337/ws`. Add `--json` for machine-readable startup output. |
| Desktop app | `bun run start` | Starts the server automatically. |
| CLI REPL | `bun run cli` | Also auto-starts the server. Needs TTY input. |

For headless/cloud testing, prefer `bun run serve` and interact via WebSocket (see `docs/websocket-protocol.md`).

### Testing

- `bun test` runs the full suite (~1590 tests). All tests are deterministic and require no network or API keys.
- Two tests are skipped by default (remote MCP integration tests requiring network).
- There is no configured linter or formatter. `bun run typecheck` is the code quality check; it runs the repo-root core typecheck plus `apps/desktop` (including `electron/*`). `apps/TUI` is archived and not part of the default typecheck command.

### Desktop App

`bun run desktop:dev` (from repo root) launches the Electron desktop app. It first builds sidecar resources (`build:desktop-resources`), then runs `electron-vite dev`. The app starts its own server process per workspace. D-Bus and GPU errors in logs are cosmetic on headless Linux and do not affect functionality. Set `COWORK_ELECTRON_REMOTE_DEBUG=1` if you need to attach external UI automation or inspection over CDP.

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
After ANY correction from the user: update `tasks/lessons.md` with the pattern
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
### 6. Autonomous Bug Fixing
When given a bug report: just fix it. Don't ask for hand-holding Point at logs, errors, failing tests then resolve them
Zero context switching required from the user
Go fix failing CI tests without being told how
## Task Management
1. **Plan First**: Write plan with checkable items, use your todo or tasks tool if available.
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Mark items complete as you go
4. **Explain Changes**: High-level summary at each step
5. **Capture Lessons**: Update `tasks/lessons.md` after corrections

## Core Principles
**Simplicity First**: Make every change as simple as possible. Impact minimal code.
**No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
**Minimal Impact**: Changes should only touch what's necessary. Avoid introducing bugs.
