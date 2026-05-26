# Mobile Remote Access

Cowork mobile remote access uses a direct device-to-device HTTP/3 (QUIC) pairing path.
The desktop app shows a `cowork-pair://` QR code. The mobile app scans it, verifies the
desktop's ephemeral certificate fingerprint, exchanges a one-time pairing nonce, and then sends
the normal Cowork JSON-RPC messages directly to the desktop sidecar. There is no hosted relay in
the data path.

## What is in place

### Desktop

Open the desktop app and navigate to:

- `Settings`
- `Remote Access`

If you need to suppress it in development, start the desktop app with `COWORK_ENABLE_REMOTE_ACCESS=0`.

From there you can:

- start remote access for the selected workspace
- view the local direct endpoint
- render a direct pairing QR ticket
- rotate the QR and ephemeral certificate
- view every trusted phone for the selected workspace
- grant or revoke each trusted phone's permissions independently
- forget one trusted phone or revoke all trusted phones

The desktop sidecar keeps trusted mobile device records under `~/.cowork/mobile-pairing`.
Renderer-persisted workspace state never stores pairing tokens or device trust state.

Trusted devices are keyed by the mobile device id. The desktop UI exposes these permission gates:

- turns: `thread/start` and `turn/*`
- server requests: client responses to server-initiated requests
- provider auth: `cowork/provider/auth/*`
- MCP auth: `cowork/mcp/server/auth/*`
- workspace settings: workspace mutation methods not otherwise covered
- backups: `cowork/backups/*`

All trusted-device permission defaults are `false`. Read-only catalog, thread, workspace, provider,
skills, plugins, MCP, memory, connector, and initialization methods remain available after pairing
so the mobile app can render state before the desktop owner grants mutation permissions.

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
- the mobile device id is stable across pairing attempts and is sent on authenticated requests
- JSON-RPC requests are sent to `/rpc`
- server notifications are streamed from `/events` as SSE
- the thread UI is wired around `coworkSnapshot.feed`-compatible types and reducers
- stream loss preserves the active session and reconnects with bounded exponential backoff
- fatal auth errors (`401`, `403`, or `Unauthorized`) clear the active session instead of retrying
- concurrent JSON-RPC initialization calls share one handshake, and stale handshakes are rejected

The native pinned HTTPS module is part of the Expo base app. The JavaScript transport uses the
module when present and falls back to standard `fetch` only in test/dev environments.

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
bunx expo export --platform ios
```

## Pairing flow

1. Start the desktop app in development mode.
2. Select a workspace.
3. Open `Settings -> Remote Access`.
4. Enable remote access.
5. Scan the QR from the mobile app pairing flow.

The QR ticket contains the local endpoint, certificate pins, and one-time nonce. Mobile must be on
the same network as the desktop for the v1 flow. See `docs/quic-pairing.md` for the route contract.

Simulator builds use the same QR/pasted ticket as the trust root, then try simulator host aliases
after the advertised desktop addresses. This lets an iOS Simulator reach the Mac through
`127.0.0.1` / `localhost`, and lets the Android emulator try `10.0.2.2`, without exposing an
unauthenticated LAN discovery endpoint.

## Security notes

- Pairing tickets bind the full advertised endpoint material: scheme, ordered hosts, port,
  certificate pin, SPKI pin, identity public key, nonce, and expiry.
- Simulator host aliases do not weaken the QR trust root: mobile still sends the original ticket,
  nonce, and certificate pins, and desktop still validates the exact advertised ticket during
  `/pair`.
- Pairing nonces are one-time use, including concurrent `/pair` attempts.
- Session tokens are returned once to the mobile client and persisted on desktop only as hashes.
- `/rpc` and `/events` require both `Authorization: Bearer <sessionToken>` and the matching
  `x-cowork-mobile-device-id` header.
- Permission updates are per trusted device and happen through the desktop-managed sidecar path.
- Native permission tightening lives in the Expo source config and config plugin, not in hand edits
  to generated native project files.

## Native permissions

The source of truth for generated native permissions is:

- `apps/mobile/app.json`
- `apps/mobile/plugins/with-minimal-native-permissions.js`

Do not hand-edit `apps/mobile/ios` or `apps/mobile/android` to tighten release permissions. The
Expo config/plugin layer prunes generated native permissions when native projects are generated.

Expected native surface:

- Android source config requests camera for QR scanning. The generated manifest keeps camera and
  internet only, and disables app backup.
- iOS keeps camera and the Cowork local-network usage description. Generated microphone, Face ID,
  and Expo dev Bonjour entries are removed by the config plugin.

## Validation run

The current slices were validated with:

```bash
bun test apps/desktop/test/mobile-relay-bridge.test.ts apps/desktop/test/mobile-relay-ipc.test.ts apps/desktop/test/desktop-schemas.test.ts apps/desktop/test/remote-access-page.test.ts test/h3.mobile-server-pairing.test.ts test/h3.pairing-store.test.ts
bun test test/mobile.native-permissions.test.ts test/mobile.native-module-autolinking.test.ts
bun test test/mobile.secure-transport-client.test.ts test/mobile.jsonrpc-client.test.ts test/mobile.control-store.test.ts
bun test test/shared.cowork-ticket.test.ts test/shared.quic-cert.test.ts test/mobile.pairing-qrcode.test.ts test/mobile.pairing-scan-handler.test.ts apps/desktop/test/remote-access-page.test.ts apps/desktop/test/desktop-schemas.test.ts
bun run typecheck
bun run app:mobile:typecheck
cd apps/mobile && bunx expo export --platform ios
```
