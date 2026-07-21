# Desktop design system (Cowork)

Short reference for the Electron desktop UI. Source of truth lives in code under `apps/desktop/src/styles/` and shadcn primitives in `apps/desktop/src/components/ui/`. Prefer tokens and existing components over new one-offs.

## Stack

- **Components:** shadcn/ui (Radix base) — `Button`, `Dialog`, `Switch`, `DropdownMenu`, etc.
- **Icons:** lucide-react; buttons use `data-icon="inline-start|inline-end"` for sizing
- **Styling:** Tailwind v4 + CSS variables (`styles.css` → `tokens/` → `theme-bridge.css`)
- **Fonts:** IBM Plex Sans (UI), IBM Plex Mono (code)

## Tokens overview

Palette philosophy: **neutral canvas, olive signature**. Surfaces/borders/text are warm-neutral grays; the olive `--accent-base` (`#6f8042` light / `#a8b963` dark) is reserved for primary actions, active nav, focus rings, and live status — never as a wash over whole surfaces.

| Layer | Path | Role |
|-------|------|------|
| Palette / bases | `styles/tokens/base.css` | Light/dark app colors, radius base, surface shadows, motion easings |
| Platform overrides | `styles/tokens/platform.css` | Glass, blur, high-contrast |
| Semantic bridge | `styles/theme-bridge.css` | Maps bases → shadcn/Tailwind (`--color-*`, surfaces, focus) |
| Utilities | `styles/token-utilities.css` | Shared helpers (e.g. focus utility) |
| Platform chrome | `styles/platform/{darwin,win32,linux}.css` | Titlebar z-index, drag regions, caption buttons |

**Pitfall:** in this theme `text-accent` / `bg-accent` refer to the neutral *surface* accent (hover fill), not the brand olive. For olive text/fills use `text-primary` / `bg-primary/10`-style classes.

### Surfaces (semantic)

Use these instead of raw hex:

- `--surface-window`, `--surface-shell`, `--surface-sidebar`, `--surface-sidebar-pane`
- `--surface-workspace-pane`, `--surface-main`, `--surface-card`, `--surface-overlay`
- `--surface-muted-fill` (background tint; **not** muted text)
- Settings: `--surface-settings-*`; spreadsheet: `--surface-spreadsheet*`

### Text

- `--text-primary`, `--text-secondary`, `--text-muted`, `--text-subtle`, `--text-emphasis`, `--text-link`, `--text-inverse`

### Border / shadow / radius

- Borders: `--border-default`, `--border-subtle`, `--border-strong`, context variants
- Radius: `--radius` (from `--radius-base` ≈ `0.5rem`); Tailwind `--radius-sm|md|lg`
- Shadows: `--shadow-surface`, `--shadow-surface-elevated`, `--shadow-overlay`, `--shadow-popover`

### Status

- Success / warning / danger via `--status-*` and Tailwind `success`, `warning`, `destructive`

### High contrast

`data-high-contrast="true"` on `:root` flattens glass, strengthens borders/type, and disables backdrop blur (`tokens/platform.css`).

## Z-index

Keep floating UI in documented bands. Do not invent `z-[9999]`.

| Band | Value | Use |
|------|------:|-----|
| Shell fills / chrome underlays | 0–2 | Topbar fills, sidebar strips |
| Thread popover (in topbar) | 30 | `AppTopBar` usage details |
| Canvas maximized / skip links | 40–50 | Fullscreen canvas shell, focus skip |
| Platform titlebar / drag | 60–81 | Platform CSS; caption controls above drag |
| **Portaled overlays** | **`--desktop-portal-layer` (120)** | Dialog, dropdown, select, tooltip, sheet, popover, etc. |

Portaled content is forced to `var(--desktop-portal-layer)` in `styles.css` via `[data-slot="…"]` selectors. Always portal floating layers to `document.body` (shadcn defaults). Never put a backdrop at a higher z-index than its dialog body.

## Focus

Default interactive focus (buttons, treeitems, links, inputs):

```css
box-shadow: var(--focus-ring-shadow);
/* 0 0 0 2px window surface + 0 0 0 4px accent mix */
```

Exceptions (intentionally no ring frame):

- Composer textarea (`[data-slot="message-composer"]`) — shell owns focus affordance
- Command palette input (`[data-slot="command-input"]`)

Prefer `focus-visible` and, for hover-only row actions, **`group-focus-within:`** so keyboard users see overflow menus (sidebar, file explorer, message actions).

## Motion

- Motion tokens in `tokens/base.css`: durations `--motion-fast/base/slow` (120/200/320ms) and easings `--ease-standard`, `--ease-out-strong` (entering elements), `--ease-in-out-strong` (on-screen movement), `--ease-drawer`. Keep UI animation under 300ms; never use `ease-in`.
- Press feedback: `Button` scales to `0.97` on `:active` (150ms ease-out); hover transforms belong behind `@media (hover: hover) and (pointer: fine)`.
- Overlays (popover/dropdown/select/tooltip) scale from their trigger via Radix `--radix-*-transform-origin` (already wired in the shadcn primitives); dialogs stay centered.
- Chat/activity utilities in `styles.css`: `activity-trace-content` (Radix-height expand/collapse for every collapsible in the activity system — nothing snaps open), `activity-live-dot` (soft 2s pulse for in-progress state — use instead of `animate-pulse`), `reasoning-section-in`, `chat-feed-content > *` (mount-only row entrances; never animate streaming deltas), `chat-jump-in`.
- Respect `prefers-reduced-motion`: global kill-switch in `styles.css` zeros animation/transition duration; each chat/activity utility also has an explicit off-rule. Reduced motion means fades only, no movement.
- Sidebar collapse and file-explorer row enter animations are reduced-motion aware.

## Density & type

- Chat reading column: ~`max-w-3xl` for feed rows
- Message body text: `text-[15px] leading-[1.65]` (assistant and user bubbles); activity/tool rows stay compact at `text-[13px]` / `text-[11px]`
- Compact chrome: `text-xs` / `text-[11px]` for labels; avoid sub-10px for primary copy
- Hit targets: icon buttons typically `size-6`–`size-7` (aim ≥ 28px for primary chrome)
- Binary settings: shared `Switch`; multi-select checklists: `Checkbox`
- Settings sections are flat: one `rounded-xl border border-border/50 bg-card` container with `divide-y` hairlines per section — compact rows and separators, **no nested rounded subcards**. Inner wells for raw code/JSON: `rounded-lg bg-foreground/[0.04]`, no border.

## Layout owners

| Surface | Owner | Notes |
|---------|--------|------|
| App shell topbar | `AppTopBar` | Title + progressive usage disclosure (thread details popover). Do not also mount floating usage headers. |
| Settings | `SettingsShell` | Full-window shell; not nested inside `ChatShell` |
| File previews | `CanvasFilePreviewLayout` | Shared padding/titlebar for spreadsheet, PPTX, etc. |
| Approvals | Inline feed cards for sandbox; modal for generic ask/approval | Match `size="sm"` outline/destructive buttons |

## Patterns to keep

1. **Progressive disclosure** for usage (summary chip → expand “More”), not dual usage UIs.
2. **Hover + focus-within** for row overflow menus.
3. **Semantic tokens** (`bg-background`, `text-muted-foreground`, `border-border`) over raw colors / `dark:` forks.
4. **In-app toasts** for ephemeral feedback; OS notifications are reserved for background outcomes while the app is not foregrounded.
5. **Canvas save status** chip: `data-slot="canvas-save-status"` with Saved / Unsaved / Saving / Save failed.

## Acknowledged foreground operations

Foreground mutations use the shared store contract in `apps/desktop/src/app/types.ts` and lifecycle helper in `apps/desktop/src/app/store.helpers/operations.ts`:

- Actions return `Promise<OperationResult<T>>`; callers close or clear editors only when `result.ok` is `true`.
- `operationsByKey` exposes typed `pending`, `success`, and `error` states. Stable keys deduplicate matching in-flight requests.
- Optimistic actions provide a rollback callback. The helper runs rollback before publishing the failure state.
- A successful JSON-RPC envelope is not sufficient acknowledgment. Control-event adapters use typed, event-specific decoders so domain failures such as `ok: false`, failed status entries, and their `message` or `error` details settle the operation as an error.
- `OperationFeedback` renders pending status as a polite live region and failures as an assertive alert with a retry or repair action. It never moves focus.
- Foreground failures are also added to `InAppToasts` with `audience: "foreground"`. Only notifications explicitly marked `audience: "background"` may be mirrored to the operating system, and only while the app is unfocused or hidden. Missing audiences fail closed as foreground.

Canvas document persistence retains its existing typed JSON-RPC result envelopes and controller state machine. Its save status, retry controls, duplicate-save coalescing, and transition guard provide the same acknowledged behavior for document edits.
Canvas collaboration prompts likewise remain populated while sending and clear only after `sendMessage` returns an acknowledged `true`; rejected, disconnected, or missing-session sends surface an assertive in-app error without discarding the prompt.

## Related

- UI backlog: `docs/ui-quality-audit-2026-07.md`
- Settings audit: `docs/desktop-settings-ui-ux-audit-2026-03-13.md`
- WebSocket/protocol (not visual): `docs/websocket-protocol.md`
