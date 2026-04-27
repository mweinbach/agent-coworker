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

`certSha256` is what the mobile client pins. `spkiSha256` is included for platform pinning APIs that operate on public keys, such as Cronet.

## Routes

All routes are served from the direct endpoint advertised in the ticket.

- `POST /pair` accepts `{ ticket, nonce, deviceId, identityPub, displayName }`, validates the one-time nonce, persists the trusted device under `~/.cowork/mobile-pairing`, and returns `{ sessionToken, trustedDevice }`.
- `POST /rpc` accepts one JSON-RPC-lite message and returns one JSON-RPC-lite response. The request must include `Authorization: Bearer <sessionToken>`.
- `GET /events` is an SSE stream of JSON-RPC-lite notifications and server requests. It also requires the bearer token.
- `GET /health` returns endpoint status for diagnostics.

## JSON-RPC contract

Mobile uses the same JSON-RPC-lite protocol as the WebSocket transport:

1. `initialize`
2. `initialized`
3. `thread/*`, `turn/*`, and `cowork/*` requests

`POST /rpc` carries request/response traffic. `GET /events` carries pushed notifications and server requests.

## Trust model

The QR is the trust root. Mobile must validate the server certificate against the QR fingerprint before sending `/pair`. The current JS scaffold records the expected pin in the ticket; native builds should enforce it with:

- iOS: `URLSessionDelegate.urlSession(_:didReceive:completionHandler:)` and a SHA-256 comparison of the leaf certificate DER.
- Android: Cronet `addPublicKeyPins` using `spkiSha256`.

No third-party data relay is involved. Phase 1 assumes both devices can reach each other on the same LAN or via a user-provided reachable address.
