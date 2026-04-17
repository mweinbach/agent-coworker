# A2UI (Agent-to-UI) Generative UI Support

`agent-coworker` implements the
[A2UI v0.9 protocol](https://a2ui.org/specification/v0.9-a2ui/) for agents to
render rich UI surfaces back to the user, rather than settling for plain
Markdown. This document is the single source of truth for the feature — the
protocol integration, the new tool, the desktop renderer, and the security
rules.

## Status

- **Phase 1 (shipped):** read-only rendering of A2UI v0.9 surfaces inside
  the desktop main chat view. Agents emit envelopes via a new `a2ui` tool;
  the harness folds them into a resolved surface and broadcasts events over
  the WebSocket protocol. The desktop app renders the v0.9 basic catalog.
- **Phase 2 (planned):** round-trip interactions (Button clicks, TextField
  submits) back to the agent via a new `ui/action` JSON-RPC method.
- **Phase 3 (planned):** extended catalogs (tables, charts), per-workspace
  theme persistence, and mobile parity.

The feature is opt-in and **disabled by default**.

## Enabling the feature

Set `enableA2ui` to `true` in any config layer, or export
`AGENT_ENABLE_A2UI=true`:

```json
// ~/.agent/config.json  OR  .agent/config.json  OR  config/defaults.json
{ "enableA2ui": true }
```

Restart the harness (or reopen the workspace in the desktop app). When the
flag is on, the `a2ui` tool is registered on the model's toolbelt and the
desktop UI will render surfaces emitted by tool calls.

## Architecture

```
agent model
   │  calls tool  a2ui({ envelopes: [...] })
   ▼
TurnExecutionManager (src/server/session/TurnExecutionManager.ts)
   │  ctx.applyA2uiEnvelope(envelope)
   ▼
A2uiSurfaceManager (src/server/session/A2uiSurfaceManager.ts)
   │  applyEnvelope() — pure reducer from src/shared/a2ui
   │  emit "a2ui_surface" ServerEvent
   ▼
Event fan-out:
   • JSON-RPC projector → cowork/session/a2ui/surface
                        → item/started + item/completed (uiSurface)
   • Session snapshot   → feed item kind "ui_surface"
   • Persistence        → part of the session's feed, survives reload
   ▼
Desktop A2uiSurfaceCard (apps/desktop/src/ui/chat/a2ui/)
```

The reducer (`src/shared/a2ui/surface.ts`) is pure TypeScript with no React,
zod side-effects, or server-only dependencies, so the same module can be
reused by any alternative UI (mobile, web, CLI) in the future.

## Source-of-truth files

| Concern | File |
|---|---|
| Envelope zod schema + parser | `src/shared/a2ui/protocol.ts` |
| Pure reducer (`applyEnvelope`) | `src/shared/a2ui/surface.ts` |
| Sandboxed binding / `formatString` | `src/shared/a2ui/expressions.ts` |
| Supported basic-catalog types | `src/shared/a2ui/component.ts` |
| Session-scoped manager | `src/server/session/A2uiSurfaceManager.ts` |
| `a2ui` tool | `src/tools/a2ui.ts` |
| ServerEvent type | `src/server/protocol.ts` (look for `a2ui_surface`) |
| Projection into session feed | `src/server/projection/conversationProjection.ts` |
| JSON-RPC notification routing | `src/server/jsonrpc/eventProjector.ts` |
| Feed item variant | `src/shared/sessionSnapshot.ts` |
| Desktop renderer | `apps/desktop/src/ui/chat/a2ui/` |
| Agent-facing guide | `skills/a2ui/SKILL.md` |

## Server → client event shape

See [`docs/websocket-protocol.md#a2ui_surface`](./websocket-protocol.md#a2ui_surface) for the canonical event shape. On the JSON-RPC transport the harness also projects the event as a `uiSurface` ProjectedItem in the `item/started` / `item/completed` stream so thin clients don't need bespoke plumbing.

## Security contract

1. **No HTML execution.** The renderer treats every string value as plain
   text. `<script>` tags, `javascript:` URLs, and `onerror` handlers are
   rendered as literal characters.
2. **Restricted image schemes.** `Image.src` values are only honored when
   they are `http:`, `https:`, or `data:` URLs. Anything else falls back to
   a muted placeholder.
3. **Sandboxed bindings.** The expression evaluator (`src/shared/a2ui/expressions.ts`)
   only supports JSON-pointer lookups and `${...}` template interpolation.
   Arbitrary JS (`new Function`, arithmetic, property access) is not
   supported. Unknown tokens render as empty string.
4. **Bounded state.** Each surface is capped at ~256 KB of resolved JSON,
   and each session may hold at most 16 active surfaces (the oldest
   non-deleted surface is evicted when that cap is exceeded). Envelopes
   over 128 KB are rejected at parse time.
5. **Feature flag gate.** Without `enableA2ui`, the tool is not registered
   and no A2UI events are emitted.

## Testing

- `test/a2ui/protocol.test.ts` — envelope parse / version enforcement.
- `test/a2ui/surface.test.ts` — reducer idempotency, data-model patches, delete.
- `test/a2ui/expressions.test.ts` — binding / formatString evaluator.
- `test/a2ui/feedItem.test.ts` — snapshot schema round trip.
- `test/a2ui/surfaceManager.test.ts` — session-scoped manager + event emission.
- `test/a2ui/conversationProjection.test.ts` — projection into the feed.
- `test/tools/a2ui.test.ts` — tool execute path.
- `apps/desktop/test/a2ui-surface-card.test.tsx` — React renderer (RTL-style static markup).

All tests are deterministic and part of the standard `bun test` run.

## Roadmap

Phase 2 introduces:

- A `ui/action` JSON-RPC method that clients call when a user interacts with
  an A2UI `Button`, `TextField`, or `Checkbox`.
- An "action observation" fed back to the agent as a structured steer so the
  turn can respond.
- Optimistic local data-model mutation paired with a server-side echo.

Phase 3 adds extended catalogs (tables, charts, agentic form validation
through v0.9 `Functions`), a mobile renderer, and an open-in-sidebar mode
for large surfaces.
