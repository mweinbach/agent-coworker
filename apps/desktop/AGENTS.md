# Desktop App (apps/desktop)

Electron + React + TypeScript GUI for the agent-coworker server. This is a UI layer only — business logic lives in the harness/server and is consumed over JSON-RPC WebSocket (see root `AGENTS.md`). Read `../agent_docs/desktop-ui.md` before UI or Electron work.

## Layout

- `src/` — renderer React app: `src/app/store.ts` (Zustand store, WebSocket management), `src/ui/` (components), `src/lib/` (`desktopApi.ts` IPC contract, `desktopCommands.ts` preload wrappers, `agentSocket.ts` reconnecting WS client)
- `electron/` — main/preload: `main.ts` (window lifecycle), `preload.ts` (context-isolated `window.cowork` bridge), `ipc.ts` (handlers), `services/` (server process manager, persistence)
- `src/components/ui/` — shadcn/ui component set
- `test/` — Bun tests (`*.test.ts`)

## Commands

From the repo root:

- `bun run desktop:dev` — dev mode (builds sidecar resources first, then `electron-vite dev`)
- `bun run typecheck:desktop` — desktop TypeScript check
- `bun run test -- apps/desktop/test` — desktop tests
- `bun run desktop:build` — distributables (macOS/Windows)

## Invariants

- Each workspace runs its own `cowork-server` process; the renderer opens a per-workspace control socket plus per-thread chat sockets against it.
- `BrowserWindow` runs with `contextIsolation: true`, `nodeIntegration: false`. All privileged actions go through explicit preload methods; validate sender and inputs in the main process. Never expose unrestricted Node APIs to the renderer.
- API keys are handled by the core server, never the desktop UI. Never log sensitive workspace paths, keys, or session data.
- New desktop command: channel in `src/lib/desktopApi.ts` → expose in `electron/preload.ts` → handler in `electron/ipc.ts` → renderer wrapper in `src/lib/desktopCommands.ts`. Keep all four in sync.
- New WebSocket message: schema/route in `src/server/jsonrpc/` first, then renderer handling in `src/app/store.ts`; update `docs/websocket-protocol.md`.
- Verify UI changes against the live running app via the CDP workflow (`COWORK_ELECTRON_REMOTE_DEBUG=1`) — tests alone are not proof.

## Read when relevant

- `../agent_docs/desktop-ui.md` — shadcn/ui rules, Electron tooling, desktop UI patterns
- `../agent_docs/code-review-rules.md` — IPC / persistence / message-identity review rules
