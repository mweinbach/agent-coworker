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

## UI Components

Use shadcn/ui specifically for the desktop renderer. Do not add HeroUI or another component system.

- `components.json` is the source of truth: Vite, Tailwind v4, radix base, lucide icons, `@/components/ui/*`, and `@/lib/utils`.
- Run shadcn commands from this directory with Bun: `bunx --bun shadcn@latest info --json`, `bunx --bun shadcn@latest docs <component>`, and `bunx --bun shadcn@latest add <component>`.
- Use the source components in `src/components/ui` before writing custom markup. The full shadcn registry component set should be present there.
- Follow shadcn patterns: component variants, semantic tokens, `gap-*` instead of `space-*`, `size-*` for square controls/icons, `cn()` for conditionals, and lucide icons with `data-icon` inside buttons.
- Use `Field`/`FieldGroup` and `InputGroup` for form layout, `Separator` instead of custom divider divs, `Skeleton` for loading states, `Badge` for status labels, `Switch` for binary settings, and `Checkbox` for checklist selection.
- Preview changes to existing shadcn files with `--dry-run` or `--diff`; do not overwrite local wrappers without checking desktop behavior and tests.

## Key Paths

- `src/app/store.ts`: Zustand store and socket orchestration
- `src/lib/desktopApi.ts`: shared IPC contract
- `src/lib/desktopCommands.ts`: renderer command wrappers
- `electron/main.ts`: BrowserWindow lifecycle
- `electron/preload.ts`: secure bridge (`window.cowork`)
- `electron/ipc.ts`: IPC routing
- `electron/services/`: server lifecycle + persistence
