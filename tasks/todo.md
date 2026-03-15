# Task Group: agent-coworker desktop iOS relay loom sidecar

scope: Add a macOS-only SwiftPM relay sidecar and desktop control surface that exports one workspace server to one paired iOS client without changing the existing Cowork WebSocket protocol used by Electron.

## Plan

- [x] Generalize packaged-binary manifest/lookup helpers so `cowork-server` and `cowork-loom-bridge` share one runtime packaging path.
- [x] Add `native/CoworkLoomBridge` SwiftPM package with relay core/client types, the macOS host executable, and unit tests.
- [x] Extend `build_desktop_resources.ts` and desktop packaging so macOS bundles the relay helper binary alongside the existing server sidecar.
- [x] Add `LoomBridgeManager` in Electron main with a typed stdio protocol, app lifecycle wiring, and IPC handlers/preload bridge for relay commands and live state events.
- [x] Persist relay config safely (`version` 3, top-level `iosRelayConfig`, workspace `iosRelayEnabled`) and mirror runtime relay state into the desktop store.
- [x] Add the Workspaces settings “iOS Relay” controls and publish/unpublish behavior without changing the existing desktop renderer WebSocket path.
- [x] Cover the new behavior with desktop + Swift tests and update the relevant desktop/architecture docs.

## Verification

- [x] `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer swift build -c release --package-path native/CoworkLoomBridge`
- [x] `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer swift test --package-path native/CoworkLoomBridge`
- [x] `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer bun test`
- [x] `bun run typecheck`
- [x] `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer bun run build:desktop-resources`
- [x] `bun run build:server-binary`
- [x] `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer bun run desktop:build`

## Verification Notes

- `swift test` passed 4 relay-package tests: `relayHostRejectsUnpublishedWorkspace`, `peerDisconnectClosesAllOpenRelayChannels`, `relayChannelMultiplexerPreservesOpenTextCloseOrdering`, and `relayEnvelopeCodecRoundTrip`.
- `bun test` passed `2280` tests with `2` skipped remote MCP integration tests and `0` failures after fixing the desktop control-socket startup regression introduced by the relay publication sync.
- `bun run build:server-binary` produced `dist/cowork-server` plus the bundled `prompts`, `config`, and `docs` directories.
- `bun run build:desktop-resources` produced `apps/desktop/resources/binaries/cowork-server-aarch64-apple-darwin` and `apps/desktop/resources/binaries/cowork-loom-bridge-aarch64-apple-darwin`.
- `bun run desktop:build` completed successfully and produced `release/Cowork-0.1.22-mac-arm64.dmg` and `release/Cowork-0.1.22-mac-arm64.zip`.
