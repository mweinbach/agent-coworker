# Cowork Desktop Agent Context

This directory contains the desktop application for the Agent Coworker project. It is a native GUI built with Electron, React, and TypeScript.

## Project Overview

- **Purpose:** Desktop interface for interacting with `agent-coworker` workspace servers.
- **Architecture:**
  - **Renderer:** React 19 SPA with Zustand state.
  - **Main process:** Electron IPC handlers for process management and filesystem persistence.
  - **Communication:** Dual WebSocket model:
    - Control socket (workspace-level)
    - Thread sockets (session-level)

## Build and Run

- Install deps: `bun install`
- Full desktop dev app: `bun run dev`
- Build distributables: `bun run build`
- Run tests: `bun run test`

Desktop scripts rebuild bundled resources (`cowork-server` sidecar + `dist` assets) via root `build:desktop-resources`.

## Key Paths

- `src/app/store.ts`: Zustand store and socket orchestration
- `src/lib/desktopApi.ts`: shared IPC contract
- `src/lib/desktopCommands.ts`: renderer command wrappers
- `electron/main.ts`: BrowserWindow lifecycle
- `electron/preload.ts`: secure bridge (`window.cowork`)
- `electron/ipc.ts`: IPC routing
- `electron/services/`: server lifecycle + persistence
