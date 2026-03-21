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
If `ELECTRON_RENDERER_URL` points to another app on the wrong host or port, desktop falls back to its own renderer URL.

## Native Integration

- Desktop now uses an application menu with platform-native roles and accelerators.
- Menu actions dispatch to renderer commands for `New Thread`, `Toggle Sidebar`, `Skills`, and settings views.
- Destructive confirmations use native `dialog.showMessageBox` (instead of browser `window.confirm`).
- System appearance comes from Electron `nativeTheme` and is pushed to the renderer (`dark`, high-contrast, reduced transparency).
- Desktop notifications are routed through Electron `Notification`.

On Windows, the app sets `AppUserModelId` (`com.cowork.desktop`) for better notification/taskbar integration.

## Remote Debugging

Cowork no longer ships an `agent-browser` wrapper or bundled browser-automation skill.
If you need to inspect or automate the Electron app over CDP, enable remote debugging when you launch dev mode and attach your preferred external tooling to `COWORK_ELECTRON_REMOTE_DEBUG_PORT` (default `9222`).

```bash
COWORK_ELECTRON_REMOTE_DEBUG=1 bun run dev
```

## Build

```bash
bun run build
```

The build pipeline rebuilds bundled desktop resources (`cowork-server` sidecar + prompts/config by default, with docs opt-in via `COWORK_BUNDLE_DESKTOP_DOCS=1`) via the root `build:desktop-resources` script. Curated default skills are bootstrapped by the shared agent runtime into `~/.cowork/skills` from GitHub instead of being bundled into the app.
`build:desktop-resources` is target-aware. It defaults to the host platform and arch locally, and CI can override that with `COWORK_BUILD_PLATFORM` / `COWORK_BUILD_ARCH` (or explicit `--platform` / `--arch` flags when invoking the script directly).
Desktop packaging clears `apps/desktop/resources/binaries/`, emits exactly one target-specific sidecar payload, and writes `cowork-server-manifest.json` beside it so the packaged app launches that pinned payload instead of scanning for an arbitrary match.
Most targets still bundle a compiled `cowork-server-*` executable. Windows ARM64 instead bundles `bun.exe` plus `server/index.js`, and the manifest tells the packaged app to launch that runtime bundle.
The source macOS icon lives at `apps/desktop/build/icon.icon`. For packaging with the current `electron-builder`, regenerate `apps/desktop/build/icon.icns` from that source with `xcrun actool apps/desktop/build/icon.icon --app-icon icon --compile <outdir> --output-partial-info-plist <outdir>/assetcatalog_generated_info.plist --minimum-deployment-target 12.0 --platform macosx --target-device mac`, then copy the emitted `icon.icns` into `apps/desktop/build/icon.icns`. Regenerate `apps/desktop/build/icon.ico` from `apps/desktop/build/icon.png` (for example with Pillow) so Windows packaging stays aligned with the same source art.

For macOS notarization, you can use either `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`, or `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`.
Local packaging still skips notarization when that credential set is incomplete.

## Release CI

`.github/workflows/desktop-release.yml` builds desktop release artifacts on native macOS and Windows runners.
It runs on tag pushes matching `v*` or `desktop-v*`, and it can also be started manually with `workflow_dispatch`.

Each run:
- validates the repo on Ubuntu with `bun run docs:check`, `bun test`, and `bun run typecheck`
- packages the desktop app on macOS, Windows x64, and Windows ARM64
- uploads the generated installers as workflow artifacts
- uploads an unpacked Windows ARM64 build for native smoke verification
- runs a native `windows-11-arm` smoke job that launches the packaged ARM64 app and verifies the sidecar reaches `server_listening`
- publishes those installers to the matching GitHub Release when the workflow is running on a tag ref

Windows release artifact names are arch-specific, and the ARM64 updater metadata is published as `latest-arm64.yml` instead of sharing the default Windows `latest.yml`. The packaged Windows ARM64 app sets that updater channel at runtime, so x64 installs continue to read `latest.yml` while ARM64 installs read `latest-arm64.yml`.

Required for signed and notarized macOS releases:
- `CSC_LINK`, `CSC_KEY_PASSWORD` for the Developer ID Application certificate (`.p12`)
- either `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` for App Store Connect API-key notarization
- or `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` for Apple ID notarization

Windows release secrets:
- `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` for Windows-only signing

If `WIN_CSC_LINK` is not configured, the Windows CI job still publishes the platform-specific updater metadata (`latest.yml` for x64, `latest-arm64.yml` for ARM64) and the installer `.blockmap` alongside the unsigned `.exe`, so GitHub Releases remain usable as the Windows auto-update feed. This keeps updater-driven installs working without Windows signing, but new installs should still expect SmartScreen warnings and there is no signature-based trust check on the downloaded update payload.

In GitHub Actions, store `APPLE_API_KEY` as the raw `.p8` file contents. The workflow writes it to a temporary file before packaging.
The macOS job now fails before upload if those signing/notarization inputs are missing, and it validates the packaged `.app` with `codesign`, `stapler`, and `spctl`.
