# Cowork Desktop Agent Context

This directory contains the desktop application for the Agent Coworker project. It is a native GUI built using Tauri, React, and TypeScript, designed to manage workspaces, threads, and chat sessions with AI agents.

## Project Overview

*   **Purpose:** Provides a native desktop interface for interacting with `agent-coworker` servers.
*   **Architecture:**
    *   **Frontend:** React 19 SPA powered by Vite and Zustand for state management.
    *   **Backend:** Tauri (Rust) orchestrating system-level operations like process management (for workspace servers) and file I/O.
    *   **Communication:** Dual WebSocket architecture:
        *   **Control Socket:** Manages workspace-level configurations, skills, and provider status.
        *   **Thread Sockets:** Dedicated connections for individual chat sessions.
*   **Key Technologies:** Tauri v2, React, TypeScript, Bun (runtime/package manager), Zustand, Rust.

## Building and Running

The desktop app requires the core server and resources to be built first.

*   **Install Dependencies:** `bun install`
*   **Development (Full App):** `bun run dev:tauri` (Launches the Tauri window with hot-reloading frontend).
*   **Development (Frontend Only):** `bun run dev` (Vite dev server at localhost).
*   **Build Production App:** `bun run build` (Compiles Rust backend and bundles frontend).
*   **Tauri CLI:** `bun run tauri <command>`

## Development Conventions

*   **Language & Style:**
    *   TypeScript (Strict mode) for frontend.
    *   Rust for system-level backend logic in `src-tauri/`.
    *   2-space indentation, `camelCase` for variables/functions, `PascalCase` for types/components.
*   **State Management:**
    *   Single-store pattern using **Zustand** (`src/app/store.ts`).
    *   Runtime state (sockets, timers) is kept in a `RUNTIME` object to avoid React re-render cycles for non-visual data.
*   **Persistence:**
    *   App state (workspaces, threads) is persisted to `state.json` in the app data directory via Tauri commands.
    *   Transcripts are stored as `.jsonl` files per thread in a `transcripts/` subdirectory.
*   **Error Handling:**
    *   Rust uses `thiserror` for structured internal errors, converted to strings for Tauri's IPC.
    *   Frontend uses a notification system managed via the Zustand store.

## Project Structure

*   `src/`: Frontend React application.
    *   `app/`: Core logic, Zustand store (`store.ts`), and type definitions.
    *   `ui/`: React components and views (Chat, Sidebar, Settings, etc.).
    *   `lib/`: Utilities, WebSocket protocol wrappers, and Tauri command bindings.
*   `src-tauri/`: Rust backend.
    *   `src/lib.rs`: Main logic, command handlers, and server process management.
*   `test/`: Playwright or similar integration tests for UI flows.

## Operational Notes

*   **Workspace Servers:** Each workspace selected by the user spawns a separate `cowork-server` process via `bun`. The Tauri backend manages these lifecycles.
*   **IPC:** Frontend communicates with Rust via `invoke` calls defined in `src/lib/tauriCommands.ts` and implemented in `src-tauri/src/lib.rs`.
*   **Sidecars:** The app expects `cowork-server` to be available (either via source in dev or as a bundled resource/sidecar in production).
