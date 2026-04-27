# Mobile Remote Access

Cowork mobile remote access now uses a direct device-to-device HTTP/3 (QUIC) pairing path.
The desktop app shows a `cowork-pair://` QR code. The mobile app scans it, verifies the
desktop's ephemeral certificate fingerprint, exchanges a one-time pairing nonce, and then sends
the normal Cowork JSON-RPC messages directly to the desktop sidecar. There is no hosted relay in
the data path.

## What is in place

### Desktop

Remote Access is currently a development-only desktop feature. Open a development build of the desktop app and navigate to:

- `Settings`
- `Remote Access`

If you need to suppress it in development, start the desktop app with `COWORK_ENABLE_REMOTE_ACCESS=0`.

From there you can:

- start remote access for the selected workspace
- view the local direct endpoint
- render a direct pairing QR ticket
- rotate the QR and ephemeral certificate
- forget the currently trusted phone

The desktop sidecar keeps trusted mobile device records under `~/.cowork/mobile-pairing`.
Renderer-persisted workspace state never stores pairing tokens or device trust state.

### Mobile app

The mobile app lives at:

- `apps/mobile`

Important structure:

- routes are under `apps/mobile/src/app`
- there is intentionally no `apps/mobile/app` route tree

Included areas:

- pairing landing + QR scan routes
- app tabs for threads and settings
- thread detail screen
- shared pairing store
- shared thread/feed store

The mobile implementation is a direct H3 vertical slice:

- QR validation parses `cowork-pair://` tickets
- pairing calls the desktop `/pair` endpoint and stores the returned session token in secure storage
- JSON-RPC requests are sent to `/rpc`
- server notifications are streamed from `/events` as SSE
- the thread UI is wired around `coworkSnapshot.feed`-compatible types and reducers

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

## Pairing flow

1. Start the desktop app in development mode.
2. Select a workspace.
3. Open `Settings -> Remote Access`.
4. Enable remote access.
5. Scan the QR from the mobile app pairing flow.

The QR ticket contains the local endpoint, certificate pins, and one-time nonce. Mobile must be on
the same network as the desktop for the v1 flow. See `docs/quic-pairing.md` for the route contract.

## Scope notes

Current implementation status:

- desktop direct pairing service/UI: implemented
- mobile QR parsing and direct H3 transport scaffold: implemented
- mobile transcript/thread UI shell: implemented
- native platform certificate pinning shim: pending
- mDNS/mobile local-network entitlement: pending

## Validation run

The current slices were validated with:

```bash
bun test test/shared.cowork-ticket.test.ts test/shared.quic-cert.test.ts test/mobile.pairing-qrcode.test.ts test/mobile.pairing-scan-handler.test.ts apps/desktop/test/remote-access-page.test.ts apps/desktop/test/desktop-schemas.test.ts
bun run typecheck
```
