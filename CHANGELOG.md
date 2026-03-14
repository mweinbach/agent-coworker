# Changelog

All notable changes to this project will be documented in this file.

## 0.1.22 - 2026-03-14

### Changed

- Bumped project version metadata to 0.1.22 for the next tagged release.

## 0.1.21 - 2026-03-12

### Fixed

- Fixed the macOS desktop auto-update path from `0.1.19` to `0.1.20` by disabling differential updater downloads on packaged macOS builds, forcing ShipIt to install from the full signed zip instead of a cached patched bundle that could fail code-sign validation.

## 0.1.20 - 2026-03-12

### Added

- Added a dedicated `cowork-server` release track with Bun-built macOS and Windows binaries plus a GitHub Actions workflow that publishes them from `cowork-server-v*` tags.
- Added OpenCode provider support for the harness, including the new OpenCode Zen path, shared provider metadata, and saved-key aware auth handling for compatible provider flows.
- Added file-spill handling for oversized tool output so long tool responses can be written to disk with consistent preview text across the runtime, desktop UI, and docs.

### Changed

- Reworked `webFetch` to route downloadable content into the workspace `Downloads` folder, use Exa-backed extraction for non-download content, and prefer saved Exa credentials when available.
- Updated provider and pricing metadata so usage-based OpenCode variants, model adapter wiring, and provider defaults are exposed consistently across the harness and desktop settings surfaces.
- Expanded desktop developer/provider settings and websocket protocol coverage to expose the new tool/provider behaviors more clearly.

### Fixed

- Fixed download path reservation so fetched files claim their destination safely instead of risking collisions or default-reset regressions.
- Fixed OpenCode routing, markdown-download handling, persistence edge cases, and overflow defaults that were causing inconsistent tool/provider behavior across desktop and runtime flows.
- Fixed the observability health schema TypeScript regression and isolated the TUI socket lifecycle test double so the websocket/REPL suite no longer flakes during release validation.

## 0.1.19 - 2026-03-11

### Added

- Added a recovery-focused backup workflow across the harness and desktop app. Workspaces can now browse backup history, inspect checkpoint file deltas, restore originals or checkpoints, delete whole backup entries, and reveal backup folders from the Backup settings page.
- Added workspace/session backup controls for disabled backups, whole-entry deletion, and seeded initial checkpoints so new sessions start with a recoverable baseline instead of waiting for the first manual checkpoint.

### Changed

- Reworked the desktop sidebar into a denser workspace-first layout with explicit expand controls, drag-and-drop workspace reordering, and a default cap of the 10 most recent threads per workspace with an overflow affordance.
- Refined the desktop composer so send and stop have distinct visual treatments, and the stop action remains available while a run is active.
- Made developer-mode diagnostics consistent between live sessions and transcript replay for observability, harness-context, and backup-status system notices.

### Fixed

- Fixed Codex auth persistence so desktop restarts no longer make recoverable Cowork-owned auth look lost after refresh failures or cross-process token races.
- Fixed Cowork auth recovery so usable legacy `~/.codex/auth.json` material is imported into `~/.cowork/auth/codex-cli/auth.json` when needed instead of leaving users unexpectedly signed out.
- Fixed the desktop Backup settings page freeze-on-open loop by stabilizing its initial refresh path.
