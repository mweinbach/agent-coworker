# Desktop iOS Relay Architecture

## Summary

Cowork Desktop can optionally export one workspace server to one paired iOS client over a native Loom helper on macOS.
The Electron renderer keeps using the existing local workspace WebSocket path. The relay is an additional export path for iOS, not a replacement transport for desktop.

Defaults:

- macOS-only
- off by default
- manual peer approval
- one paired device at a time
- one published workspace at a time
- text WebSocket frames only in v1

## Pairing Model

There is no Apple ID, iCloud, or CloudKit account linkage in the current relay design.
Pairing is local and identity-based:

- the Mac relay has a stable local device ID persisted by the helper
- the iOS app must persist its own stable Loom device ID
- desktop approves one peer identity at a time
- the iOS app must open the specific published `workspaceId`

The desktop pairing UI should surface:

- the Mac relay device ID and advertised name
- discovered Loom peers that can be remembered/paired without manual UUID typing
- the exact `workspaceId` the iOS app should pass to `connect(workspaceId:)`

The relay does not currently publish a workspace directory/listing or a full pairing payload to iOS automatically, so the product still needs an out-of-band handoff for the selected workspace ID unless another pairing channel is added.

## Build and Packaging

The native helper lives in [`native/CoworkLoomBridge`](../native/CoworkLoomBridge).

- `bun run build:desktop-resources` builds the existing `cowork-server` sidecar for all supported desktop targets.
- On macOS, the same script also runs `swift build -c release --package-path native/CoworkLoomBridge --product cowork-loom-bridge`.
- The packaged app bundles the helper in `apps/desktop/resources/binaries/` and writes `cowork-loom-bridge-manifest.json`.
- Runtime lookup is shared with the existing sidecar manifest logic, so Electron resolves the exact packaged binary instead of scanning arbitrary matches.

The Swift package pins Loom to the verified `1.5.0` release in `Package.swift`.

## Runtime Architecture

Main-process ownership:

- `ServerManager` still owns the local workspace server processes.
- `LoomBridgeManager` owns one app-global `cowork-loom-bridge` child process.
- `main.ts` broadcasts relay state changes to the renderer over the desktop preload bridge.
- `shutdown.ts` stops the helper after the workspace servers during app quit.

Renderer ownership:

- The renderer persists `iosRelayConfig` and per-workspace `iosRelayEnabled`.
- `WorkspacesPage.tsx` exposes the relay controls and status card.
- The pairing surface shows nearby peers, the local Mac relay identity, and the workspace ID the iOS client must open.
- Workspace startup and restart call `syncIosRelayPublication()` after the local server URL exists.
- Workspace removal and relay toggle-off unpublish the workspace when it was the active export.

The helper only accepts iOS socket opens for the currently published workspace and the explicitly approved Loom peer.

## Electron Helper Protocol

Electron main sends JSON lines to the helper over stdin:

- `bridge_start { deviceName? }`
- `bridge_stop`
- `bridge_connect_peer { peerId }`
- `bridge_disconnect_peer`
- `bridge_publish_workspace { workspaceId, workspaceName, serverUrl }`
- `bridge_unpublish_workspace { workspaceId }`
- `bridge_get_state`

The helper emits JSON lines over stdout:

- `bridge_ready`
- `bridge_state { supported, advertising, peer, publishedWorkspaceId, openChannelCount, lastError }`
- `bridge_log { level, message }`
- `bridge_fatal { message }`

`LoomBridgeManager` treats `bridge_state` as the source of truth for the live relay runtime state shown in the desktop UI.

## Relay Envelope Protocol

The helper tunnels Cowork WebSocket text frames over one Loom session with a small multiplexed protocol:

- `hello { protocolVersion, appVersion, peerName }`
- `open_socket { channelId, workspaceId, resumeSessionId? }`
- `socket_opened { channelId }`
- `socket_text { channelId, text }`
- `socket_closed { channelId, code?, reason? }`
- `socket_error { channelId, message, retryable }`
- `ping { nonce }`
- `pong { nonce }`

Each `open_socket` creates one local WebSocket client connection from the helper to the published workspace server URL. The helper forwards text frames only.

## iOS Client Contract

The future iOS app imports `CoworkLoomRelayClient` from the Swift package.

Public surface:

- `connect(workspaceId:resumeSessionId:) async throws -> RelaySocket`
- `RelaySocket.send(text:)`
- `RelaySocket.messages`
- `RelaySocket.close()`

Important integration requirements for the iOS app:

- Persist `CoworkLoomRelayClientConfiguration.deviceID`; the default initializer creates a new UUID if the app does not save one.
- If the app does not know the Mac relay ID, `peerID` may be omitted and the client will connect to the first discovered relay peer.
- The app must know the published `workspaceId` before calling `connect(workspaceId:)`.

This keeps the iOS client as a normal Cowork client speaking the existing workspace WebSocket protocol through the relay tunnel.

## Verification

Expected verification gates for this feature:

```bash
swift build -c release --package-path native/CoworkLoomBridge
swift test --package-path native/CoworkLoomBridge
bun test
bun run typecheck
bun run build:desktop-resources
bun run build:server-binary
bun run desktop:build
```
