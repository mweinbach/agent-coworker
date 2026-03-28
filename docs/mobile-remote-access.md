# Mobile Remote Access

This repo now includes the first vertical slices for mobile remote access:

- desktop Electron remote-access bridge and Settings UI
- standalone Expo app scaffold at `apps/mobile`
- local Expo native module scaffold for Remodex secure transport
- workspace-scoped JSON-RPC methods that no longer require the mobile client to know host filesystem paths

## What is in place

### Desktop

Open the desktop app and navigate to:

- `Settings`
- `Remote Access`

From there you can:

- start remote access for the selected workspace
- view current relay state
- render a pairing QR payload
- rotate the active relay session
- forget the currently trusted phone

The desktop bridge keeps its trust state and private identity material in Cowork-owned storage under `~/.cowork/mobile-relay`, not in renderer-persisted workspace state or `~/.remodex`.

### Mobile app

The mobile app lives at:

- `apps/mobile`

Important structure:

- routes are under `apps/mobile/src/app`
- there is intentionally no `apps/mobile/app` route tree

Included scaffolded areas:

- pairing landing + QR scan routes
- app tabs for threads and settings
- thread detail screen
- shared pairing store
- shared thread/feed store
- local Expo module scaffold:
  - `apps/mobile/modules/remodex-secure-transport`

The current mobile implementation is a scaffolded vertical slice:

- the secure transport module exposes the intended JS/native API surface
- the fallback JS path simulates trust/connect flows plus a mock Cowork JSON-RPC sidecar for development
- the thread UI is wired around `coworkSnapshot.feed`-compatible types and reducers
- the mobile fallback can now exercise:
  - `initialize` / `initialized`
  - `thread/list`
  - `thread/read`
  - `turn/start`
  - `turn/interrupt`
  - approval request round-trips
  - ask-for-input round-trips
- end-to-end native secure transport parity with the real Remodex wire protocol is still the next step

## Commands

From repo root:

```bash
bun run app:mobile:dev
bun run app:mobile:ios
bun run app:mobile:android
bun run app:mobile:typecheck
```

Desktop:

```bash
bun run desktop:dev
```

Repo validation:

```bash
bun run typecheck
bun run app:mobile:typecheck
```

## Pairing flow today

1. Start the desktop app.
2. Select a workspace.
3. Open `Settings -> Remote Access`.
4. Enable remote access.
5. Scan the QR from the mobile app pairing flow.

At this stage, the QR payload and trusted-device state flow are scaffolded and typed end-to-end. Cowork Desktop now owns the relay identity/trust state directly under `~/.cowork/mobile-relay`, while the Expo fallback path can demo the secure-transport-facing JSON-RPC client and approval/input UX locally on Linux.

## Local mobile fallback demo

The Expo-side fallback transport now acts like a tiny mock desktop session once you pair:

1. Open the mobile app and scan the desktop QR.
2. The fallback transport will hydrate a demo thread list.
3. Open the demo thread and send prompts.
4. Use prompts containing:
   - `approval` to trigger a command approval request
   - `input` to trigger an ask-for-input request

This gives a local end-to-end demo of the mobile JSON-RPC client, thread hydration, turn streaming, and server-request response handling without requiring iOS/Xcode or the full native Remodex transport to be present on this Linux VM.

## Scope notes

Current implementation status:

- desktop bridge/service/UI: implemented
- mobile Expo project scaffold: implemented
- native secure-transport module surface: scaffolded
- mobile JSON-RPC client + fallback transport integration: implemented
- mobile transcript/thread UI shell: implemented for fallback/demo path
- final secure transport handshake parity for the app-owned mobile transport: pending
- raw Cowork JSON-RPC over encrypted mobile transport: pending

## Validation run

The current slices were validated with:

```bash
bun test test/server.jsonrpc.flow.test.ts test/mobile.pairing-qrcode.test.ts test/mobile.jsonrpc-client.test.ts test/mobile.transport-integration.test.ts apps/desktop/test/mobile-relay-bridge.test.ts apps/desktop/test/remote-access-page.test.ts apps/desktop/test/settings-nav.test.ts apps/desktop/test/desktop-schemas.test.ts
bun run typecheck
bun run app:mobile:typecheck
```
