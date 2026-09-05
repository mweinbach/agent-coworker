# agent-coworker

A local-first AI coworker agent: Bun + TypeScript (ESM) harness with a JSON-RPC WebSocket server, a CLI REPL, and thin UI clients (Electron desktop, Expo mobile).

## Execution and communication

- Treat actionable requests such as "can you fix…" or "help me add…" as instructions to do the work. Infer routine, reversible details from the conversation and repository; continue until the requested outcome and applicable checks are complete.
- Ask only when an unresolved decision materially changes scope, risk, or the result. Complete independent, already-authorized preparation first. Preserve explicit approval gates and obtain authorization before unrequested external writes, publishing, or destructive actions.
- User instructions override skill defaults, subject to higher-priority instructions and enforced tool/security boundaries. A skill must not silently change an implementation request into an audit, a plan, or a request for confirmation. If a skill requirement genuinely blocks work, link the exact `SKILL.md`, quote the instruction, and distinguish the requirement from your interpretation.
- Delegate independent research, exploration, or verification when it can save time or improve quality. Give each child a bounded task, relevant context, constraints, and a concrete deliverable. Continue independent work while it runs; integrate its result before completing dependent work. Avoid duplicate investigation and overlapping edits. If delegation is unavailable, continue directly and report material coverage gaps.
- Lead with the outcome. Use concise, plain language and short paragraphs. Use lists or tables when they make the result easier to understand, or when requested. Avoid stock phrases, unnecessary recaps, and promises to continue instead of finishing. Keep subagent messages equally legible.

These defaults incorporate [OpenAI's Astra guidance](agent_docs/astra.md); they do not require a particular model or change the verification requirements below.

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

Use Bun, not npm. Vite+ owns lint/format for the build configs and new navigation
modules listed in root `vite.config.ts`; Biome owns all remaining scopes, including
the existing renderer source and CSS.
Use the root scripts to run both non-overlapping scopes; do not hand-maintain style.

- `bun install` — install root and workspace dependencies
- `bun install --cwd apps/mobile --frozen-lockfile` — install the locked mobile SDK dependencies required by the full test suite
- `bun run start` / `bun run cli` / `bun run serve` — desktop app / CLI REPL / standalone server (`ws://127.0.0.1:7337/ws`)
- `bun run desktop:dev` — Electron dev mode
- `bun run test` — full suite via the project runner (`scripts/run_tests.ts`). Do not substitute bare `bun test`; the runner isolates test files in fresh processes where required.
- `bun run typecheck` — TypeScript strict, root + `packages/harness` + `apps/desktop`
- `bun run lint` / `bun run check:write` — scoped Biome + Vite+ lint / lint+format fix
- `bun run check:tooling` — scoped Vite+ lint/format plus strict build-config TypeScript check
- `bun run web:build` — browser production build through the local Vite+ CLI
- `bun run docs:check` — protocol/docs consistency (runs in CI)
- `bun run knip` — dead-export check

For code, dependency, build, and runtime configuration changes, the canonical pre-commit verification lane is `bun run test`, `bun run typecheck`, `bun run check`, and `bun run docs:check`. `bun run check` includes lint and format checks for both tooling scopes. Run this lane for each committed logical slice; results from the same unchanged slice need not be repeated just to finish the task.

Read-only audits require source-backed verification, not runtime tests. For instruction-only or prose-only changes, inspect the full diff, validate affected skill metadata and documentation links, and run applicable documentation checks; runtime tests are required only if executable behavior or a test-consumed contract changes, or the user explicitly requests them. Report which checks ran and any unresolved failures.

## Testing

- Do not write tests for reversible, low-impact changes that mirror the implementation. If you do choose to verify your work with tests, make sure that the tests are meaningful and necessary to verify implementation.
- Run tests appropriate to the change and complete required checks. Once those pass, broaden or repeat testing only when new changes, failures, or unresolved concerns justify it; otherwise, continue toward completing the task.
- `import { describe, test, expect } from "bun:test"`; files are `*.test.ts`.
- Deterministic only: no network calls; isolate the filesystem in temp dirs; use the DI factories (`createRunTurn()`, `createTools()`, tool factories) or `mock.module()` instead of live calls.
- Bug fixes: reproduce the issue and fix the root cause. Write a failing regression test when it meaningfully protects behavior, not when it only mirrors a reversible, low-impact implementation change. Keep the diff minimal — no opportunistic refactors.

## Conventions

- Commits: [Conventional Commits](https://www.conventionalcommits.org/) (`fix:`, `feat:`, `refactor:`, `chore:`, `test:`, `docs:`), short imperative subjects. Commit logical slices as you go.
- Never commit secrets or local state; `.env`, `.agent/`, `.cowork/`, `output/`, `uploads/` are gitignored. Runtime config/auth/MCP state lives in `.cowork/` and `~/.cowork/` — `~/.cowork` is the only auth home.
- `--yolo` disables approval prompts and the OS sandbox; local experiments only.
- TypeScript is `strict`. Match existing code patterns; use the formatter assigned to the file's scope.

## Read when relevant

Task-specific docs — load the one that matches your task before starting:

- `agent_docs/engineering-rules.md` — durable rules from past corrections: PR review workflow, scope discipline, verification gates
- `agent_docs/repo-contracts.md` — repo-specific invariants (auth, config tiers, JSON-RPC projector, tools, runtime)
- `agent_docs/code-review-rules.md` — review checklist for contract, authority-boundary, and IPC diffs
- `agent_docs/desktop-ui.md` — shadcn/ui + Electron patterns, desktop verification workflow
- `agent_docs/mobile-ui.md` — Expo/mobile patterns and verification
- `agent_docs/model-selection.md` — which models to use for which work
- `agent_docs/astra.md` — GPT-6 Astra prompting guidance, skill audit rules, and API migration constraints
- `agent_docs/adding-models.md` — model registry metadata rules
- `agent_docs/cursor-cloud.md` — Cursor Cloud environment specifics
- `docs/websocket-protocol.md` — WebSocket protocol source of truth
- `docs/harness/index.md` — harness context/observability/SLO docs map
- `CONTRIBUTING.md` — architecture deep-dive: adding tools, skills, MCP servers

[Ask DeepWiki](https://deepwiki.com/mweinbach/agent-coworker)
