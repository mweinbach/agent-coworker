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

Desktop renderer protocol types are re-exported from `@cowork/server/protocol`. Messages follow `src/server/protocol.ts` in the core package.

## Security & Configuration

- `BrowserWindow` runs with `contextIsolation: true`, `nodeIntegration: false`
- Do not expose unrestricted Node APIs to renderer; all privileged actions go through explicit preload methods
- API keys are handled by the core server, not desktop UI
- Never log sensitive workspace paths, API keys, or session data in UI

## Common Tasks

### Adding a new WebSocket message type

1. Add type to `src/server/protocol.ts` in core package
2. Add handler in `src/app/store.ts`
3. Update protocol re-exports if needed in `src/lib/wsProtocol.ts`

### Adding a new desktop command

1. Add a new channel/method in `src/lib/desktopApi.ts`
2. Expose the method in `electron/preload.ts`
3. Implement IPC handler in `electron/ipc.ts`
4. Add renderer wrapper in `src/lib/desktopCommands.ts`

### Styling Guidelines

- Use CSS custom properties for theming (`src/styles.css`)
- Prefer flexbox for layout
- Keep styles co-located: global styles in `src/styles.css`, component styles in `src/App.css` or colocated files
