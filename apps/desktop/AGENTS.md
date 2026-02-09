# Desktop App Guidelines

The Cowork Desktop App is a Tauri (Rust) + React + TypeScript application that provides a native GUI for the agent-coworker server. It manages workspaces, threads, and chat sessions via WebSocket connections to the core server.

## Project Structure & Module Organization

- `src/`: Frontend React application
  - `src/App.tsx`: Root component with topbar controls and view routing
  - `src/main.tsx`: React app entry point
  - `src/app/`: State management and types
    - `store.ts`: Zustand store with all app state, WebSocket management, and server lifecycle
    - `types.ts`: TypeScript interfaces for threads, workspaces, feed items, etc.
  - `src/ui/`: React components
    - `ChatView.tsx`: Main chat interface with message feed
    - `Sidebar.tsx`: Workspace/thread navigation
    - `SettingsView.tsx`: Provider configuration UI
    - `SkillsView.tsx`: Skills management interface
    - `PromptModal.tsx`: Ask/approval prompt modals
  - `src/lib/`: Utilities and protocol
    - `agentSocket.ts`: WebSocket wrapper with auto-reconnect
    - `wsProtocol.ts`: Re-exports from @cowork/server/protocol
    - `tauriCommands.ts`: Rust command bindings via Tauri API
    - `modelChoices.ts`: Available model choices per provider
    - `time.ts`: Time formatting utilities
  - `src/styles.css` & `src/App.css`: App styling
- `src-tauri/`: Rust/Tauri backend
  - `src/lib.rs`: Core Rust library with server lifecycle, file I/O, state persistence
  - `src/main.rs`: Binary entry point
  - `tauri.conf.json`: Tauri configuration

## Build, Test, and Development Commands

From the desktop app directory:

- `bun install`: Install dependencies
- `bun run dev`: Run Vite dev server only (no Tauri)
- `bun run dev:tauri`: Run full Tauri app in dev mode (recommended)
- `bun run build`: Build production app
- `bun run tauri`: Tauri CLI wrapper

The desktop app depends on the core server being built first. The `dev:tauri` and `build` scripts automatically run `bun run --cwd ../.. build:desktop-resources` to ensure the core is compiled.

## Coding Style & Naming Conventions

- TypeScript strict mode enabled
- 2-space indentation
- Prefer `camelCase` for values, `PascalCase` for types
- Group imports: Node/builtins, third-party, local aliases (`@cowork/*`), relative imports
- React functional components with hooks
- Zustand for state management (single store pattern)

## Architecture Notes

### WebSocket Communication

The desktop app maintains two types of WebSocket connections to the agent-coworker server:

1. **Control Socket**: Per-workspace connection for management operations (skills, provider config)
2. **Thread Sockets**: Per-thread connections for chat sessions

All WebSocket logic is in `src/app/store.ts`. The `AgentSocket` class in `src/lib/agentSocket.ts` handles connection lifecycle with exponential backoff.

### State Persistence

App state (workspaces, threads) is persisted via Tauri commands to the filesystem. See `src/lib/tauriCommands.ts` for the Rust↔TypeScript bridge. Transcripts are stored per-thread and loaded on-demand when selecting a thread.

### Server Lifecycle

Each workspace runs its own agent-coworker server process:

1. User selects workspace → `selectWorkspace()` called
2. `ensureServerRunning()` starts the server process via Tauri command
3. `ensureControlSocket()` connects WebSocket to the started server
4. Thread sockets connect independently when user selects a thread

### Protocol

The desktop app re-exports protocol types from `@cowork/server/protocol`. All messages follow the server protocol defined in `src/server/protocol.ts` of the core package.

## Security & Configuration

- API keys for providers are handled by the core server, not the desktop app
- Workspace paths are selected via Tauri's native file dialog
- State is stored in the app's data directory (managed by Tauri)
- Never log or expose workspace paths, API keys, or session data in UI

## Adding New Views

1. Add view ID to `ViewId` type in `src/app/types.ts`
2. Add route handling in `App.tsx` topbar title and content area
3. Create view component in `src/ui/`
4. Add navigation trigger in `Sidebar.tsx` if needed

## Common Tasks

### Adding a new WebSocket message type

1. Add type to `src/server/protocol.ts` in core package (ClientMessage/ServerEvent unions)
2. Add handler in `src/app/store.ts` in `handleThreadEvent()` or control socket `onEvent`
3. Update protocol re-exports if needed in `src/lib/wsProtocol.ts`

### Adding a new Tauri command

1. Implement command in `src-tauri/src/lib.rs`
2. Add TypeScript binding in `src/lib/tauriCommands.ts`
3. Call from store or components as needed

### Styling Guidelines

- Use CSS custom properties for theming (defined in `src/styles.css`)
- Prefer flexbox for layout
- Keep styles co-located: global styles in `src/styles.css`, component-specific in `src/App.css` or CSS modules
