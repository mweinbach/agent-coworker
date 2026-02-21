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
