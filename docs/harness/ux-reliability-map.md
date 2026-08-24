# User Experience to Harness Reliability Map

The interface is the observable contract for the harness. A successful network
response, an optimistic local update, or a cached list is not proof that the
user's requested work happened. Audit each journey in both directions: from the
visible control back to its authoritative operation, then from every durable
server transition forward to every affected client.

## Forward map: user expectation to authoritative owner

| User expectation | User-visible surface | Authoritative owner | Required visible outcome |
| --- | --- | --- | --- |
| I can start where I left off. | Desktop workspace/sidebar; mobile chat list. | Workspace authorization, durable session snapshots, and client draft storage. | Previously saved projects, chats, and drafts remain discoverable, including when a project drive or desktop connection is unavailable. |
| I can write before reconnecting. | Desktop and mobile message composers. | Local draft persistence; the harness owns actual turn admission. | Typing remains available. An offline message remains an explicitly unsent draft unless an acknowledged durable delivery queue exists. |
| Send means the agent received my message. | Composer button, transcript row, pending/sending indicator. | `thread/start`, `turn/start`, stable `clientMessageId`, and canonical session events. | One accepted message has one identity; failures preserve text and expose retry. A local-only echo never masquerades as delivery. |
| A disconnect does not erase my work. | Desktop recovery banner; mobile connection banner; existing transcript. | Socket generation, bounded reconnect, replay cursor, and durable session snapshots. | Automatic reconnection is described as automatic. Existing drafts, responses, queued sends, and pending prompts remain visible. |
| Stop always finishes. | Stop button and stopping indicator. | `turn/interrupt`, active-turn admission, cancellation, and terminal turn events. | An active turn remains stopping until authoritative completion. A stale client turn settles immediately when the server reports no live work. |
| I can see when the agent needs me. | Desktop/mobile approval cards, thread-list badges, and accessible announcements. | Durable interaction state, thread summaries, and `serverRequest/resolved`. | Pending approval or question state is discoverable without opening every conversation; cancellation, timeout, or another device's decision clears it everywhere. |
| A partial answer is not a successful answer. | Transcript, error/retry treatment, run status. | Provider terminal status and canonical turn completion. | Externally cancelled or interrupted provider work retains partial output but appears failed/retryable rather than successfully complete. |
| Settings describe the actual connection. | Provider badges, loading states, toasts, and refresh controls. | Control-session readiness and authoritative provider/catalog events. | Cached provider availability is not confused with current transport failure; overlapping refreshes cannot create duplicate or stale error notifications. |
| An unavailable project cannot damage other work. | Project row, creation readiness, settings, and drafts. | Persisted trusted workspace roots, path revalidation, and serialized state persistence. | The project and its history remain present; unrelated saves succeed; reconnect guidance is specific without expanding filesystem access. |

## Reverse map: authoritative transition to every client

Every new harness state transition must answer all of these questions before it
is considered product-complete:

1. Which desktop and mobile surface first exposes this state to the user?
2. Can an unsubscribed or unopened conversation discover it from a list summary?
3. What event clears the state on another device and after reconnect replay?
4. Does the pending state survive an application restart without inventing a
   completed action?
5. What happens if the operation was already complete before the client asks to
   stop, approve, retry, or refresh it?
6. Does failure preserve the user's original text, attachment, request identity,
   and actionable recovery detail?
7. Is the same transition announced accessibly and represented honestly while
   offline, reconnecting, or running in a different client?

## Regression ownership

- Harness route, session, provider, persistence, and notification regressions
  belong under `test/`; integration tests should exercise real JSON-RPC
  connections when the failure crosses a client boundary.
- Desktop component and store regressions belong under `apps/desktop/test/` and
  should verify the visible copy, enabled/disabled controls, and terminal state.
- Mobile component and store regressions belong under `test/mobile*.test.ts` or
  `test/mobile*.test.tsx`; shared surfaces must be exercised for both iOS and
  Android when the interaction differs by platform.
- Public request, result, notification, or summary changes must also update
  `docs/websocket-protocol.md` and generated protocol artifacts.
- The broader product guarantees and fault-injection checklist remain defined
  in `docs/harness/reliability.md`.
