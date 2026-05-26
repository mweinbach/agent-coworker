# Direct mobile pairing over HTTP/3

Cowork Mobile pairs to the desktop app directly over a local HTTPS endpoint served by the workspace sidecar. The endpoint enables Bun HTTP/3 with `h3: true` when available, but the route contract also works over ordinary HTTPS so the transport can fall back without changing mobile code.

## Pairing ticket

Desktop renders a QR containing:

```text
cowork-pair://<base32-json>
```

The decoded JSON payload is:

```json
{
  "v": 1,
  "scheme": "h3",
  "hosts": ["192.168.1.10"],
  "port": 49152,
  "certSha256": "<sha256 of leaf cert DER>",
  "spkiSha256": "<base64url sha256 of SPKI>",
  "identityPub": "<base64url SPKI>",
  "nonce": "<one-time pairing nonce>",
  "expiresAt": 1777329000000
}
```

`certSha256` is what the mobile client pins. `spkiSha256` is included for platform pinning APIs
that operate on public keys, such as Cronet. The desktop validates the full scanned ticket during
`/pair`; the request ticket must match the live advertised scheme, ordered hosts, port,
certificate pin, SPKI pin, identity public key, nonce, and expiry.

## Routes

All routes are served from the direct endpoint advertised in the ticket.

- `POST /pair` accepts `{ ticket, nonce, deviceId, identityPub, displayName }`, validates the
  full ticket and one-time nonce, persists the trusted device under `~/.cowork/mobile-pairing`,
  and returns `{ sessionToken, trustedDevice }`.
- `POST /rpc` accepts one JSON-RPC-lite message and returns one JSON-RPC-lite response. The request
  must include `Authorization: Bearer <sessionToken>` and
  `x-cowork-mobile-device-id: <deviceId>`.
- `GET /events` is an SSE stream of JSON-RPC-lite notifications and server requests. It requires
  the same bearer token and mobile device id header. The server emits SSE comment keepalive frames
  every 15 seconds so idle streams are not dropped by NATs or mobile network stacks.
- `GET /health` returns endpoint status for diagnostics.

## JSON-RPC contract

Mobile uses the same JSON-RPC-lite protocol as the WebSocket transport:

1. `initialize`
2. `initialized`
3. `thread/*`, `turn/*`, and `cowork/*` requests

`POST /rpc` carries request/response traffic. `GET /events` carries pushed notifications and server requests.

The mobile JSON-RPC client coalesces concurrent `initialize` calls into one handshake. If the
transport resets while initialization is in flight, that stale handshake is rejected and the next
active transport must initialize again.

## Device permissions

Pairing creates or refreshes a trusted-device record, but all elevated permissions default to
`false`. The desktop app can update permissions per device.

Always allowed after pairing:

- `initialize`, `initialized`
- thread reads and resume/hydrate/unsubscribe
- workspace list/bootstrap and selected workspace previews
- session state/harness-context reads
- provider catalog/status/auth-method reads
- MCP server reads/validation
- skills, plugins, memory, and connector reads

Permission-gated methods:

- turns: `thread/start` and `turn/*`
- server requests: JSON-RPC responses to server-initiated requests
- provider auth: `cowork/provider/auth/*`
- MCP auth: `cowork/mcp/server/auth/*`
- backups: `cowork/backups/*`
- workspace settings: all other mutable workspace control methods

## Trust model

The QR is the trust root. Mobile must validate the server certificate against the QR fingerprint
before sending `/pair`. Native builds enforce this through the Expo base app's pinned HTTPS module:

- iOS: `URLSessionDelegate.urlSession(_:didReceive:completionHandler:)` and a SHA-256 comparison of the leaf certificate DER.
- Android: Cronet `addPublicKeyPins` using `spkiSha256`.

No third-party data relay is involved. Phase 1 assumes both devices can reach each other on the same LAN or via a user-provided reachable address.

The mobile client keeps the active session on transient stream loss, emits a reconnecting state,
and reopens `/events` with bounded exponential backoff. Fatal authorization errors clear the active
session instead of retrying, so revoked or mismatched devices do not loop forever. If the desktop
certificate or listener address changes, scan the QR again to refresh pins.

The desktop persists its mobile H3 TLS certificate and listener port under
`~/.cowork/mobile-pairing/` so trusted phones can reconnect after a desktop restart without
re-pairing. Manual QR rotation intentionally invalidates the old pins.

For simulator development, the mobile client tries the advertised `hosts` first, then local host
aliases (`127.0.0.1`, `localhost`, and Android emulator `10.0.2.2`) using the same ticket and pins.
The desktop validates the original ticket during `/pair`, so these fallbacks only help a simulator
reach the same trusted endpoint from the Mac host.
