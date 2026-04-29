# Desktop App Guidelines

The Cowork Desktop App is an Electron + React + TypeScript application that provides a native GUI for the agent-coworker server. It manages workspaces, threads, and chat sessions via WebSocket connections to the core server.

## Project Structure & Module Organization

- `src/`: Renderer React application
  - `src/App.tsx`: Root component with topbar controls and view routing
  - `src/main.tsx`: Renderer entry point
  - `src/app/`: State management and types
    - `store.ts`: Zustand store with app state, WebSocket management, and server lifecycle
    - `types.ts`: TypeScript interfaces for threads, workspaces, feed items, etc.
  - `src/ui/`: React components
  - `src/lib/`: Renderer utilities and desktop bridge wrappers
    - `desktopApi.ts`: Shared IPC contract/channel names
    - `desktopCommands.ts`: Renderer wrappers for preload APIs
    - `agentSocket.ts`: WebSocket wrapper with reconnect behavior
- `electron/`: Electron main/preload process code
  - `main.ts`: BrowserWindow lifecycle
  - `preload.ts`: Context-isolated bridge exposed to renderer (`window.cowork`)
  - `ipc.ts`: IPC handler registration
  - `services/`: Main-process services (server process manager, persistence)
- `test/`: Bun tests (`*.test.ts`)
- `electron.vite.config.ts`: Electron build config (main, preload, renderer)
- `electron-builder.yml`: macOS/Windows packaging configuration

## Build, Test, and Development Commands

From the desktop app directory:

- `bun install`: Install dependencies
- `bun run dev`: Run full Electron app in dev mode
- `bun run build`: Build distributables (macOS/Windows)
- `bun run test`: Run desktop tests

The desktop app depends on the core server resources. Scripts run `bun run --cwd ../.. build:desktop-resources` to rebuild sidecar + bundled assets.

## Coding Style & Naming Conventions

- TypeScript strict mode enabled
- 2-space indentation
- Prefer `camelCase` for values, `PascalCase` for types
- Group imports: Node built-ins, third-party, local aliases (`@cowork/*`), relative imports
- React functional components with hooks
- Zustand single-store pattern

## Architecture Notes

### WebSocket Communication

The desktop app maintains two WebSocket connection types to the agent-coworker server:

1. **Control Socket**: Per-workspace connection for management operations (skills, provider config)
2. **Thread Sockets**: Per-thread connections for chat sessions

All WebSocket logic is in `src/app/store.ts`. The `AgentSocket` class in `src/lib/agentSocket.ts` handles connection lifecycle with exponential backoff.

### State Persistence

State (workspaces/threads) and per-thread transcript JSONL files are persisted by Electron main-process services. Renderer code accesses these through the preload bridge in `window.cowork` and `src/lib/desktopCommands.ts`.

### Server Lifecycle

Each workspace runs its own `cowork-server` process:

1. User selects workspace → `selectWorkspace()`
2. Renderer requests `startWorkspaceServer()` via IPC
3. Main process starts/reuses workspace server and returns websocket URL
4. Renderer opens control + thread sockets against that URL

### Protocol

Desktop renderer WebSocket traffic uses JSON-RPC over `cowork.jsonrpc.v1`. Shared JSON-RPC schemas live under `src/server/jsonrpc/`; internal session event payload types are re-exported from `src/server/protocol.ts`.

## Security & Configuration

- `BrowserWindow` runs with `contextIsolation: true`, `nodeIntegration: false`
- Do not expose unrestricted Node APIs to renderer; all privileged actions go through explicit preload methods
- API keys are handled by the core server, not desktop UI
- Never log sensitive workspace paths, API keys, or session data in UI

## Common Tasks

### Adding a new WebSocket message type

1. Add the JSON-RPC schema/route in `src/server/jsonrpc/`
2. Add renderer handling in `src/app/store.ts` or the focused helper module
3. Update protocol re-exports if needed in `src/lib/wsProtocol.ts`

### Adding a new desktop command

1. Add a new channel/method in `src/lib/desktopApi.ts`
2. Expose the method in `electron/preload.ts`
3. Implement IPC handler in `electron/ipc.ts`
4. Add renderer wrapper in `src/lib/desktopCommands.ts`

### Styling Guidelines

- Use shadcn/ui specifically for desktop renderer UI. Do not add HeroUI or another component library.
- The shadcn config is `components.json`: Vite, Tailwind v4, radix base, lucide icons, `@/components/ui/*` imports, and `@/lib/utils`.
- Run shadcn commands from `apps/desktop` with Bun: `bunx --bun shadcn@latest info --json`, `bunx --bun shadcn@latest docs <component>`, and `bunx --bun shadcn@latest add <component>`.
- Prefer existing shadcn primitives in `src/components/ui` before custom markup. The full registry component set should be present there, alongside any app-specific local components.
- Compose components using shadcn conventions: full `Card` structure, `Dialog`/`Sheet` titles, `TabsTrigger` inside `TabsList`, `SelectItem` inside groups where applicable, `Field`/`FieldGroup` and `InputGroup` for form layout, `Separator`/`Skeleton`/`Badge` instead of custom one-off divs.
- Style with semantic CSS tokens from `src/styles.css`, component variants, `gap-*` instead of `space-*`, `size-*` for equal dimensions, and `cn()` for conditional classes.
- Use lucide icons with `data-icon="inline-start"` or `data-icon="inline-end"` inside `Button`; let the component own icon sizing.
- Use the shared `Switch` for binary settings and reserve `Checkbox` for checklist selection.
- Preview updates to existing components with `--dry-run` or `--diff`; do not overwrite desktop-customized wrappers without checking the diff and running relevant tests.

<!-- HEROUI-REACT-AGENTS-MD-END -->
