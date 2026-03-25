# Mobile Remote Access

This repo now includes the first vertical slices for mobile remote access:

- desktop Electron remote-access bridge and Settings UI
- standalone Expo app scaffold at `app/mobile`
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

The desktop bridge keeps its trust state and private identity material in Electron main-process storage under the app `userData` directory, not in renderer-persisted workspace state.

### Mobile app

The mobile app lives at:

- `app/mobile`

Important structure:

- routes are under `app/mobile/src/app`
- there is intentionally no `app/mobile/app` route tree

Included scaffolded areas:

- pairing landing + QR scan routes
- app tabs for threads and settings
- thread detail screen
- shared pairing store
- shared thread/feed store
- local Expo module scaffold:
  - `app/mobile/modules/remodex-secure-transport`

The current mobile implementation is a scaffolded vertical slice:

- the secure transport module exposes the intended JS/native API surface
- the fallback JS path simulates trust/connect flows for development
- the thread UI is wired around `coworkSnapshot.feed`-compatible types and reducers
- end-to-end secure transport + raw Cowork JSON-RPC wiring is still the next integration step

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

At this stage, the QR payload and trusted-device state flow are scaffolded and typed end-to-end, while the final secure relay transport and raw Cowork JSON-RPC bridge on mobile still need to be completed.

## Scope notes

Current implementation status:

- desktop bridge/service/UI: implemented
- mobile Expo project scaffold: implemented
- native secure-transport module surface: scaffolded
- mobile transcript/thread UI shell: scaffolded
- final secure transport handshake parity with Remodex references: pending
- raw Cowork JSON-RPC over encrypted mobile transport: pending

## Validation run

The current slices were validated with:

```bash
bun test test/server.jsonrpc.flow.test.ts test/jsonrpc.codegen.test.ts test/docs.check.test.ts apps/desktop/test/mobile-relay-bridge.test.ts apps/desktop/test/remote-access-page.test.ts apps/desktop/test/settings-nav.test.ts apps/desktop/test/desktop-schemas.test.ts
bun run typecheck
bun run app:mobile:typecheck
```
