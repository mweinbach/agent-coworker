# Desktop App (apps/desktop)

Electron + React + TypeScript GUI for the agent-coworker server. This is a UI layer only — business logic lives in the harness/server and is consumed over JSON-RPC WebSocket (see root `AGENTS.md`). Read `../../agent_docs/desktop-ui.md` before UI or Electron work.

## Layout

- `apps/desktop/src/` — renderer React app: `apps/desktop/src/app/store.ts` (Zustand store, WebSocket management), `apps/desktop/src/ui/` (components), `apps/desktop/src/lib/` (`desktopApi.ts` IPC contract, `desktopCommands.ts` preload wrappers, `agentSocket.ts` reconnecting WS client)
- `apps/desktop/electron/` — main/preload: `main.ts` (window lifecycle), `preload.ts` (context-isolated `window.cowork` bridge), `ipc.ts` (handlers), `services/` (server process manager, persistence)
- `apps/desktop/src/components/ui/` — shadcn/ui component set
- `apps/desktop/test/` — Bun tests (`*.test.ts`)

## Commands

From the repo root:

- `bun run desktop:dev` — dev mode (builds sidecar resources first, then `electron-vite dev`)
- `bun run typecheck:desktop` — desktop TypeScript check
- `bun run test -- apps/desktop/test` — desktop tests
- `bun run desktop:build` — distributables (macOS/Windows)
- `bun run web:build` — browser production build through local Vite+
- `bun run check:tooling` — strict build-config lint, format, and type checks

Electron-vite still orchestrates main/preload/renderer using the pinned Vite+ core.
The build configs and four new navigation/loading modules listed in root
`vite.config.ts` use Oxlint/Oxfmt; existing renderer and Electron source, tests,
and CSS remain under Biome. See `docs/ui-foundation-plan.md` for rollout boundaries.

## Invariants

- Each workspace runs its own `cowork-server` process; the renderer opens a per-workspace control socket plus per-thread chat sockets against it.
- `BrowserWindow` runs with `contextIsolation: true`, `nodeIntegration: false`. All privileged actions go through explicit preload methods; validate sender and inputs in the main process. Never expose unrestricted Node APIs to the renderer.
- API keys are handled by the core server, never the desktop UI. Never log sensitive workspace paths, keys, or session data.
- New desktop command: channel in `apps/desktop/src/lib/desktopApi.ts` → expose in `apps/desktop/electron/preload.ts` → handler in `apps/desktop/electron/ipc.ts` → renderer wrapper in `apps/desktop/src/lib/desktopCommands.ts`. Keep all four in sync.
- New WebSocket message: schema/route in `crates/cowork-protocol/` and `crates/cowork-server/` first, then renderer handling in `apps/desktop/src/app/store.ts`; update `docs/websocket-protocol.md` and run `bun run docs:generate-jsonrpc`.
- Verify affected UI behavior in the live running app using the tool preference and evidence requirements in `../../agent_docs/desktop-ui.md` — tests alone are not proof.

## Read when relevant

- `../../agent_docs/desktop-ui.md` — shadcn/ui rules, Electron tooling, desktop UI patterns
- `../../agent_docs/code-review-rules.md` — IPC / persistence / message-identity review rules
