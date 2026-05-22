# Desktop Platform Chrome

One visual language, three native shells. The Cowork desktop app renders the same
design across macOS, Windows, and Linux, but keeps native chrome behavior isolated
behind a single platform contract.

## Contract

All platform-specific values live in
`apps/desktop/electron/services/windowChrome/platformChrome.ts` as a single
`PlatformChromeContract` object. Both the Electron main process and the renderer
read from this same source.

Fields:

- `platform` — normalized platform: `macos`, `windows`, `linux`, `other`.
- `titlebarHeight` — titlebar height in px.
- `dragStripHeight` — top-edge drag strip height in px.
- `leftNativeReserve` — pixels reserved for traffic lights / window buttons on the left.
- `rightNativeReserve` — pixels reserved for caption buttons / window controls on the right.
- `captionButtonReserve` — Windows-specific caption button reserve.
- `collapsedLeftRailWidth` — Windows collapsed sidebar left-rail width in px.
- `topbarToolbarGap` — gap between the right toolbar and native caption buttons in px.
- `trafficLightPosition` — macOS traffic light position.
- `windowMaterial` — Windows-specific background material (e.g. `tabbed` on Win11).
- `sidebarTitlebandMode` — `native` (sidebar owns titleband, Windows) or `topbar`
  (topbar owns it, macOS/Linux).
- `topbarControlPlacement` — `sidebar` (macOS SidebarCollapseControl),
  `left-rail` (Windows collapsed rail), or `inline` (Linux inline toggle).
- `usesNativeGlass` — whether the platform uses native vibrancy/acrylic.
- `disableCssBlur` — whether to skip CSS backdrop-filter to avoid stacking
  against native materials.

## Platform naming

- Electron / Node / `data-platform` use raw OS ids: `darwin`, `win32`, `linux`.
- Renderer TypeScript uses normalized ids: `macos`, `windows`, `linux`, `other`.
- CSS selectors target raw values (`:root[data-platform="win32"]`).
- Components should use `useDesktopPlatform()` rather than hardcoding either form.

## Electron main process

Per-platform chrome modules live under
`apps/desktop/electron/services/windowChrome/`:

- `darwin.ts` — hidden inset titlebar, traffic lights, native vibrancy.
- `win32.ts` — `titleBarOverlay` with transparent color, caption buttons, Tabbed material.
- `linux.ts` — `titleBarOverlay` overlay (where supported), opaque fallback.

Each module calls `getPlatformChrome(platform)` to resolve its constants instead
of hardcoding them.

## Renderer

The renderer reads the current platform chrome at startup through
`window.cowork.getPlatformChrome()` (see `desktopCommands.getPlatformChrome`) and
writes the contract values onto `document.documentElement` as CSS variables:

- `--platform-titlebar-height`
- `--platform-drag-strip-height`
- `--platform-left-native-reserve`
- `--platform-right-native-reserve`
- `--platform-caption-button-reserve`
- `--platform-collapsed-left-rail-width`
- `--platform-topbar-toolbar-gap`

It also sets these data attributes used by platform CSS and components:

- `data-platform="darwin|win32|linux"`
- `data-sidebar-titleband-mode="native|topbar"`
- `data-topbar-control-placement="sidebar|left-rail|inline"`
- `data-uses-native-glass="true|false"`
- `data-disable-css-blur="true|false"`
- `data-caption-button-reserve`, `data-collapsed-left-rail-width`, `data-topbar-toolbar-gap`

Renderer components use the `useDesktopPlatform()` hook
(`apps/desktop/src/lib/useDesktopPlatform.ts`) to read normalized platform info
instead of inlining `process.platform` or `dataset.platform` checks.

## Components

- `AppTopBar` — orchestrates the top bar. Delegates left-side native chrome to
  `PlatformTopBarChrome` and uses platform chrome metrics for shared spacing.
- `PlatformTopBarChrome` — renders macOS SidebarCollapseControl, Windows
  collapsed left rail, or Linux/other inline toggle based on
  `topbarControlPlacement`.
- `Sidebar` — enables the Windows-style native titleband when
  `sidebarTitlebandMode === "native"`.
- `QuickChatShell` / `MenuBarUtilityShell` — frameless popup shells styled via
  `desktop-popup-shell` classes and platform CSS.

## Platform CSS

Platform CSS lives in `apps/desktop/src/styles/platform/`:

- `shared.css` — design-invariant rules that use `--platform-*` variables.
- `darwin.css` — macOS traffic-light clearance, drag strips, settings offset.
- `win32.css` — Windows titlebar drag zones, caption reserve, titleband drag
  layer, chat-body card layout, frameless popup surfaces.
- `linux.css` — Linux title bar padding and settings offsets.

Hardcoded pixel values have been replaced with `var(--platform-*)` so the main
process contract is the single source of truth.

## Adding a new platform tweak

1. Add the new field to `PlatformChromeContract` and populate it for each
   platform in `platformChrome.ts`.
2. If the renderer needs it, forward it through `PlatformChromeInfo` in
   `desktopApi.ts` and the `getPlatformChrome` IPC handler in
   `electron/ipc/window.ts`.
3. Expose it on `document.documentElement` from `platformChromeDom.ts` and
   consume it via CSS variables or `useDesktopPlatform()`.
4. Add a platform chrome test in `test/platform-chrome.test.ts`.
