# Cowork Desktop

Electron + React + TypeScript desktop client for `agent-coworker`.

## Development

```bash
bun install
bun run dev
```

Dev mode keeps Electron remote debugging disabled unless explicitly enabled.
Set `COWORK_ELECTRON_REMOTE_DEBUG=1` to enable it, and optionally set `COWORK_ELECTRON_REMOTE_DEBUG_PORT` (default `9222`).

Desktop renderer dev URL is restricted to loopback on `COWORK_DESKTOP_RENDERER_PORT` (default `1420`).
If `ELECTRON_RENDERER_URL` points to another app (for example the harness portal), desktop falls back to its own renderer URL.

## Native Integration

- Desktop now uses an application menu with platform-native roles and accelerators.
- Menu actions dispatch to renderer commands for `New Thread`, `Toggle Sidebar`, `Skills`, and settings views.
- Destructive confirmations use native `dialog.showMessageBox` (instead of browser `window.confirm`).
- System appearance comes from Electron `nativeTheme` and is pushed to the renderer (`dark`, high-contrast, reduced transparency).
- Desktop notifications are routed through Electron `Notification`.

On Windows, the app sets `AppUserModelId` (`com.cowork.desktop`) for better notification/taskbar integration.

## Control With agent-browser

Use [agent-browser](https://github.com/vercel-labs/agent-browser) to drive the Electron app over CDP.

Recommended once per machine:

```bash
brew install agent-browser
# or: npm install -g agent-browser
```

1. Start desktop in dev mode:

```bash
bun run dev
```

2. In another terminal (repo root), run agent-browser commands through the wrapper:

```bash
bun run desktop:browser -- snapshot -i
bun run desktop:browser -- click @e2
bun run desktop:browser -- screenshot tmp/desktop.png
```

From `apps/desktop`, you can also run:

```bash
bun run browser -- snapshot -i
```

When enabled, the wrapper targets CDP port `9222`, or `COWORK_ELECTRON_REMOTE_DEBUG_PORT` when set.
The wrapper prefers a globally installed `agent-browser` binary and falls back to `bunx agent-browser` if it is not in `PATH`.

## Build

```bash
bun run build
```

The build pipeline rebuilds bundled desktop resources (`cowork-server` sidecar + prompts/config/skills/docs) via the root `build:desktop-resources` script.

For macOS notarization, set `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`.
Without those variables, packaging continues but notarization is skipped.
