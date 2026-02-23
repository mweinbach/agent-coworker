# Repository Guidelines

agent-coworker is a terminal-first coworker agent built on Bun + TypeScript (ESM) with a WebSocket server, an OpenTUI + Solid.js TUI, and a CLI REPL.

When you have access to subagents or agent teams, feel free to use them. Subagents are good for delegating tasks for searching and performing specific actions. Be specific with your delegation, and feel free to use them liberally.  

## Project Structure & Module Organization

- `src/`: application code
- `src/server/`: WebSocket server, protocol, and session state
- `src/tui/`: thin TUI wrapper (launches the main TUI from `apps/TUI/`)
- `src/cli/`: CLI REPL and argument parsing
- `src/providers/`: model/provider integrations (OpenAI/Google/Anthropic and `*-cli`)
- `src/tools/`: built-in tools (`bash`, `read`, `write`, `webSearch`, etc.)
- `apps/TUI/`: main TUI built with OpenTUI + Solid.js
- `apps/desktop/`: Electron desktop application
- `apps/portal/`: portal web application
- `test/`: Bun tests (`*.test.ts`)
- `config/`: built-in defaults and MCP server defaults
- `config/observability/`: local observability stack definitions (Vector + Victoria)
- `prompts/`: system + sub-agent prompts
- `skills/`: bundled skill docs/assets used by the agent
- `docs/harness/index.md`: harness context/observability/SLO system-of-record map

## Build, Test, and Development Commands

- `bun install`: install dependencies.
- `bun run start`: run the default TUI (starts the server automatically).
- `bun run cli`: run the plain CLI REPL.
- `bun run serve`: run the server only.
- `bun run dev`: watch mode for local iteration.
- `bun test`: run the full test suite.

Example: `bun run start -- --dir /path/to/project`

Always run tests while doing work, make sure you run these tests.

## Coding Style & Naming Conventions

- TypeScript is `strict` (see `tsconfig.json`); prefer `async/await` and explicit types at module boundaries.
- Indentation is 2 spaces. Keep imports grouped (Node built-ins, deps, local).
- Naming: `camelCase` for values, `PascalCase` for types. Tests are `*.test.ts` and may add qualifiers (e.g. `agent.remote-mcp.grep.test.ts`).

## Testing Guidelines

- Use Bun’s runner (`import { describe, test, expect } from "bun:test"`).
- Keep tests deterministic: avoid network calls; isolate filesystem via temp dirs and use DI hooks/mocks where available (e.g. `__internal` shims, `mock.module()`).

## Commit & Pull Request Guidelines

- Recent history favors short, imperative commit subjects (“Add …”, “Handle …”, “Refactor …”); use `chore:` for dependency bumps when applicable.
- PRs should include: what/why, how to test (`bun test`), and screenshots or a short recording for TUI changes. Keep changes focused and add tests for fixes/features.

## WebSocket-First Development

All new features MUST be built on top of the CLI/core logic and exposed via WebSocket controls in the server protocol. UIs are thin clients that consume `ServerEvent`s and send `ClientMessage`s — never put business logic directly in a UI layer.

When adding a new WebSocket message or event:
1. Define the type in `src/server/protocol.ts` (`ClientMessage` / `ServerEvent` unions).
2. Add validation in `safeParseClientMessage()` for client messages.
3. Wire the handler in `src/server/startServer.ts` and/or `src/server/session.ts`.
4. **Document it in `docs/websocket-protocol.md`** — this is the source of truth for alternative UI builders.

## Security & Configuration Tips

- Don’t commit secrets or local state. `.env`, `.agent/`, `.cowork/`, `output/`, and `uploads/` are gitignored.
- Prefer environment variables (e.g. `OPENAI_API_KEY`) and local `.agent/config.json` / `.agent/mcp-servers.json` for developer setup. MCP server configs, auth, and session backups also live in `.cowork/` (project-level or `~/.cowork/`).
- `--yolo` bypasses command approvals; use only for local experiments.
- Make commits liberally as you go with meaningful detailed messages.

## agent-browser Skill + Electron

If the project has `.agent/skills/agent-browser/SKILL.md`, use that skill for desktop UI/browser automation tasks.

For the Electron desktop app (`apps/desktop`):
- Start app in dev mode: `bun run desktop:dev`
- Control it via CDP with: `bun run desktop:browser -- <agent-browser args>`
- Preferred interaction loop: `snapshot -i` -> use `@eN` refs -> re-snapshot after navigation/DOM changes

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
