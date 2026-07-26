# agent-coworker

A local-first AI coworker agent: Bun + TypeScript (ESM) harness with a JSON-RPC WebSocket server, a CLI REPL, and thin UI clients (Electron desktop, Expo mobile).

## Core architecture rule: WebSocket-first

All product logic lives in the harness/server (`src/`). UIs are thin clients that send typed JSON-RPC requests and consume typed notifications — never put business logic in a UI layer. Implement it in the harness, then expose it over the WebSocket.

When adding a JSON-RPC method or notification:

1. Add schema + validation in `src/server/jsonrpc/schema.ts` and the relevant module under `src/server/jsonrpc/`.
2. Wire the handler in `src/server/jsonrpc/routes/` and/or the manager under `src/server/session/`.
3. Document it in `docs/websocket-protocol.md` — the source of truth for alternative UI builders.

## Layout

- `src/` — harness: agent loop (`src/agent.ts`), server (`src/server/`), tools (`src/tools/`), providers (`src/providers/`), runtime adapters (`src/runtime/`), CLI (`src/cli/`)
- `apps/desktop/` — Electron app, UI layer only (see `apps/desktop/AGENTS.md`)
- `apps/mobile/` — Expo mobile app (React Native)
- `packages/harness/` — dev harness, docs generation and checks
- `test/`, `apps/desktop/test/` — Bun tests (`*.test.ts`)
- `config/` — built-in defaults; model registry lives in `config/models/<provider>/`
- `prompts/`, `skills/` — system + sub-agent prompts, bundled skills
- `docs/` — architecture and protocol docs; `docs/harness/index.md` is the harness docs map

## Commands

Use Bun, not npm. Biome is the linter/formatter — run it, don't hand-maintain style.

- `bun install` — install dependencies
- `bun run start` / `bun run cli` / `bun run serve` — desktop app / CLI REPL / standalone server (`ws://127.0.0.1:7337/ws`)
- `bun run desktop:dev` — Electron dev mode
- `bun run test` — full suite via the project runner (`scripts/run_tests.ts`). Do not substitute bare `bun test`; the runner isolates test files in fresh processes where required.
- `bun run typecheck` — TypeScript strict, root + `packages/harness` + `apps/desktop`
- `bun run lint` / `bun run check:write` — Biome lint / lint+format fix
- `bun run docs:check` — protocol/docs consistency (runs in CI)
- `bun run knip` — dead-export check

Before committing, run the CI lane: `bun run test`, `bun run typecheck`, `bun run lint`, `bun run docs:check`.

## Testing

- `import { describe, test, expect } from "bun:test"`; files are `*.test.ts`.
- Deterministic only: no network calls; isolate the filesystem in temp dirs; use the DI factories (`createRunTurn()`, `createTools()`, tool factories) or `mock.module()` instead of live calls.
- Bug fixes: reproduce the issue, write a failing regression test, fix the root cause until it passes. Keep the diff minimal — no opportunistic refactors.

## Conventions

- Commits: [Conventional Commits](https://www.conventionalcommits.org/) (`fix:`, `feat:`, `refactor:`, `chore:`, `test:`, `docs:`), short imperative subjects. Commit logical slices as you go.
- Never commit secrets or local state; `.env`, `.agent/`, `.cowork/`, `output/`, `uploads/` are gitignored. Runtime config/auth/MCP state lives in `.cowork/` and `~/.cowork/` — `~/.cowork` is the only auth home.
- `--yolo` disables approval prompts and the OS sandbox; local experiments only.
- TypeScript is `strict`. Match existing code patterns; let Biome own formatting.

## Read when relevant

Task-specific docs — load the one that matches your task before starting:

- `agent_docs/engineering-rules.md` — durable rules from past corrections: PR review workflow, scope discipline, verification gates
- `agent_docs/repo-contracts.md` — repo-specific invariants (auth, config tiers, JSON-RPC projector, tools, runtime)
- `agent_docs/code-review-rules.md` — review checklist for contract, authority-boundary, and IPC diffs
- `agent_docs/desktop-ui.md` — shadcn/ui + Electron patterns, desktop verification workflow
- `agent_docs/mobile-ui.md` — Expo/mobile patterns and verification
- `agent_docs/model-selection.md` — which models to use for which work
- `agent_docs/adding-models.md` — model registry metadata rules
- `agent_docs/cursor-cloud.md` — Cursor Cloud environment specifics
- `docs/websocket-protocol.md` — WebSocket protocol source of truth
- `docs/harness/index.md` — harness context/observability/SLO docs map
- `CONTRIBUTING.md` — architecture deep-dive: adding tools, skills, MCP servers

[Ask DeepWiki](https://deepwiki.com/mweinbach/agent-coworker)
