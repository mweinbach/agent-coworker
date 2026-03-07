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

The build pipeline rebuilds bundled desktop resources (`cowork-server` sidecar + prompts/config/docs) via the root `build:desktop-resources` script. Curated default skills are bootstrapped by the shared agent runtime into `~/.cowork/skills` from GitHub instead of being bundled into the app.

For macOS notarization, you can use either `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`, or `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`.
Without a complete notarization credential set, packaging continues but notarization is skipped.

## Release CI

`.github/workflows/desktop-release.yml` builds desktop release artifacts on native macOS and Windows runners.
It runs on tag pushes matching `v*` or `desktop-v*`, and it can also be started manually with `workflow_dispatch`.

Each run:
- validates the repo on Ubuntu with `bun run docs:check`, `bun test`, and `bun run typecheck`
- packages the desktop app on macOS and Windows
- uploads the generated installers as workflow artifacts
- publishes those installers to the matching GitHub Release when the workflow is running on a tag ref

Optional release secrets:
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` for Apple ID notarization
- `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` for App Store Connect API-key notarization
- `CSC_LINK`, `CSC_KEY_PASSWORD` for shared code-signing certificates
- `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` for Windows-only signing

In GitHub Actions, store `APPLE_API_KEY` as the raw `.p8` file contents. The workflow writes it to a temporary file before packaging.
The workflow also sets `CSC_IDENTITY_AUTO_DISCOVERY=false` so unsigned CI builds still succeed when signing certificates are not configured yet.

