# Desktop UI & Electron

Load this file when working in `apps/desktop/`.

## Key files

| Concern | Location |
|---|---|
| shadcn registry config (source of truth) | `apps/desktop/components.json` |
| Tailwind v4 tokens / theme | `apps/desktop/src/styles.css` |
| shadcn component set | `apps/desktop/src/components/ui/` |
| App state + WebSocket management | `apps/desktop/src/app/store.ts` |
| Reconnecting WS client | `apps/desktop/src/lib/agentSocket.ts` |
| IPC contract / channel names | `apps/desktop/src/lib/desktopApi.ts` |
| Preload bridge (`window.cowork`) | `apps/desktop/electron/preload.ts` |
| IPC handlers (main process) | `apps/desktop/electron/ipc.ts` |
| Workspace/thread persistence | `apps/desktop/electron/services/persistence.ts` |

## shadcn/ui

- The desktop renderer uses shadcn/ui as the component system. Do not add HeroUI or custom component libraries for new desktop UI.
- Tailwind v4 CSS lives in `apps/desktop/src/styles.css`; imports use `@/components/ui/*`, utilities `@/lib/utils`, icons are lucide.
- Before adding or changing a shadcn component, run `bunx --bun shadcn@latest info --json` from `apps/desktop` and use that output as the source of truth for aliases, base (`radix`), icon library, and installed components.
- Use the CLI for registry work: `bunx --bun shadcn@latest add <component>` from `apps/desktop`. For existing components, preview first with `--dry-run` or `--diff` and do not overwrite local wrappers without checking their desktop-specific behavior and tests.
- Compose existing shadcn primitives first: `Button`, `Card`, `Dialog`, `Sheet`, `Tabs`, `Select`, `Switch`, `Checkbox`, `Tooltip`, `DropdownMenu`, `Command`, `Field`, `InputGroup`, `Separator`, `Skeleton`, `Badge`, etc.
- Follow shadcn composition rules: use variants before custom styling, semantic tokens (`bg-background`, `text-muted-foreground`, `border-border`) instead of raw colors, `gap-*` instead of `space-*`, `size-*` for square icons/controls, and `cn()` for conditional classes.
- Buttons with icons use lucide icons with `data-icon="inline-start"` or `data-icon="inline-end"`; let the `Button` component own icon sizing. For binary settings use the shared `Switch`; reserve `Checkbox` for checklist selection.
- Keep desktop UI thin. Business logic belongs in the harness/server, exposed through JSON-RPC/WebSocket controls.

## Electron tooling

- Start dev mode from the repo root: `bun run desktop:dev` (builds sidecar resources via `build:desktop-resources` first, then `electron-vite dev`). The app starts its own server process per workspace.
- Set `COWORK_ELECTRON_REMOTE_DEBUG=1` to expose a CDP port for external inspection or automation; override `COWORK_ELECTRON_REMOTE_DEBUG_PORT` if `9322` (default) is taken. The default avoids `9222`, which Chrome's own remote-debugging endpoint conventionally binds.
- UI automation preference: Computer Use tools/skills first, then Chrome DevTools MCP; Playwright is the last option.
- D-Bus and GPU errors in logs are cosmetic on headless Linux.
- Quality gates: `bun run desktop:quality` (build + Playwright + screenshot check), `bun run desktop:quality:update` to refresh snapshots.

## Desktop UI patterns

- For a truly solid desktop surface, use `app-surface-opaque`; `bg-background` maps to `--surface-window`, which can be intentionally translucent even without opacity or backdrop-blur classes.
- When removing a composer's typing focus frame, remove and test every root `focus-within` treatment, including both shadow and border-color classes; checking only the shadow can leave the visible outline intact.
- Treat Settings as a full-window shell: its navigation replaces the chat sidebar and its page chrome replaces the thread top bar. Never mount `SettingsShell` inside `ChatShell`.
- For long first-run downloads, do not strand a small progress row in a large otherwise-interactive shell. Use an intentional setup state with clear hierarchy, phase context, and unavailable regions visually de-emphasized.
- Use the Playwright/CDP workflow (`COWORK_ELECTRON_REMOTE_DEBUG=1`) before declaring a UI change done.
- For macOS menu bar and Windows tray features, verify the packaged app bundles and resolves the tray asset correctly; dev-only checks are not enough.
- When both an installed app and a repo-local app bundle exist, verify the exact on-disk bundle path for the running process instead of trusting the shared app name or bundle ID.
- When a tray/menu-bar utility window and a quick chat window both exist, treat them as separate surfaces: tray clicks should open the explicitly requested utility popup instead of reusing quick chat.
- For shared dialogs/modals: portal to `document.body`, own the centered overlay, never let the backdrop sit at a higher `z-*` than the dialog body.
- For desktop renderer wrappers re-exporting core types, prefer repo-root relative imports over `@cowork/*` aliases — `electron-vite` accepts the alias in TS but Rollup can fail at renderer build.
- For Electron preloads, bundle deps like `zod` into `out/preload/preload.js`; do not externalize runtime deps.
- For Electron main-process CommonJS deps, use `createRequire` interop, not named ESM imports.
- For dense desktop settings panels, prefer compact controls and separators over nested rounded subcards.
- Make sure all platform-specific desktop behavior is properly handled and tested for that platform. When making changes with native elements, do not rely on platform defaults or implicit behavior — always specify explicit styles and behaviors.
- For sidebar project new-chat affordances, open the new-chat landing with the clicked project preselected; do not immediately create a project draft unless the user explicitly asks for instant draft creation.
