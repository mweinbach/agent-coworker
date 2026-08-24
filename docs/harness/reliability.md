# Product Reliability Contract

Reliability is a property of the conversation, not an optional capability of a
particular provider, feature, or client. Desktop, mobile, and CLI must preserve
the same user-visible guarantees across disconnects, process failures, provider
outages, concurrent actions, and restarts.

## User-visible guarantees

1. **An accepted action is visible immediately.** Sending, stopping, approving,
   and changing important settings expose an honest pending state until the
   authoritative operation succeeds or reports an actionable failure.
2. **A conversation never silently disappears or runs twice.** A chat submission
   has one stable `clientMessageId`. Only requests whose server-side idempotency
   survives the relevant failure boundary may be replayed automatically.
3. **A temporary disconnect does not erase work.** Active turns, their start
   times, unsent drafts, queued submissions, and pending interactions survive
   transient transport replacement. Terminal reconnect exhaustion is surfaced
   explicitly instead of pretending the action completed.
4. **Restart recovery is truthful.** Every root chat, task thread, and child agent
   durably transitions through its real execution lifecycle. Interrupted work
   becomes recoverable or visibly failed; it must not remain "working" forever.
5. **One workspace cannot break another.** Startup recovery, idle eviction, task
   reconciliation, and shared-provider cleanup are scoped to their owning
   workspace. Disposing one idle chat must not stop another chat's shared model
   process.
6. **Approvals are authoritative and shared.** A decision remains pending until
   its matching server receipt exists. Its resolution reaches every subscribed
   client; reconnect replay cannot clear a different outstanding interaction.
7. **Stop actually stops.** Cancellation interrupts startup, model execution,
   connector preparation, and provider backoff. When explicitly requested, the
   harness also stops the active turn's subagents.
8. **Offline state preserves user intent.** Drafts, attachments, failed
   submissions, and their retry identities survive application suspension and
   restart. Late disk/cache hydration never overwrites newer live state.
9. **Failures are honest.** Interrupted model streams are failed turns, not
   successful partial answers. Permission denials explain the missing grant.
   Connected means its event stream is genuinely usable.

## Architecture ownership

- The harness owns canonical execution state, durable journals, idempotency,
  interaction receipts, task lifecycle, authorization, and recovery.
- The JSON-RPC transport owns bounded request waits, reconnect attempts,
  causal message ordering, bounded queues, and generation-safe event delivery.
- Clients own optimistic presentation and locally durable drafts. They reconcile
  against harness-owned snapshots; they do not invent authoritative execution or
  permission state.
- Shared provider runtimes are workspace-scoped resources. They are not owned by
  whichever individual conversation happens to terminate first.
- Diagnostic trace capture must not be allowed to corrupt authoritative user
  work. Durability of canonical messages, interactions, and execution state takes
  precedence over optional observability.

## Recovery invariants

### Connection and replay

- Every connection attempt has bounded open and initialization waits.
- Every application request has a bounded response wait.
- Old connection callbacks and asynchronously decoded messages cannot mutate a
  replacement connection.
- Socket delivery remains FIFO under backpressure. Replaceable streaming deltas
  must never evict approvals, terminal events, or request responses.
- Replay cursors advance only after the corresponding events are applied. A
  thread-list summary is not evidence that a client consumed its latest events.
- Snapshot and replay metadata are sampled after the journal persistence barrier.
  Older snapshots cannot replace newer visible conversation state.

### Persistence and shutdown

- Successful-write deduplication advances only after a durable write succeeds.
- Concurrent writes are serialized, and transient failures remain retryable.
- Startup recovery reconciles only sessions and tasks owned by that workspace.
- Idle-session eviction counts actual client subscribers, not permanent internal
  journal sinks; active turns remain protected.
- Server shutdown drains journals, sessions, and analytics within its bounded
  grace period. Its desktop supervisor grants a longer grace period before
  forcefully terminating the process.

### Providers and mobile lifecycle

- Retry temporary rate limits, provider 5xx responses, and transient network
  failures only before visible assistant content or tool effects exist.
- Authentication failures, invalid requests, cancellations, and already visible
  output never receive an unsafe automatic provider retry.
- Returning from mobile background replaces a potentially stale event stream,
  rebuilds the session handshake, and resumes the active thread from its last
  applied event.
- Transport-level HTTP acceptance does not replace an authoritative approval or
  question-resolution receipt.

## Regression matrix

Reliability fixes require deterministic, user-visible fault-injection coverage:

- server death before acknowledgment and reconnect with the same message ID;
- multiple workspaces with simultaneous live chats and tasks;
- delayed snapshot after a newer response has completed;
- stale completion for turn A while turn B is active;
- stalled connection, handshake, model startup, connector, or HTTP send;
- queued approvals and messages while a reconnect itself fails;
- desktop/mobile approval resolution from a second device;
- offline draft restoration and late cache hydration;
- mobile background-to-foreground stream replacement;
- provider outage before versus after visible assistant output; and
- graceful shutdown, failed state writes, and idle-runtime cleanup.

Run the complete project verification rather than relying only on isolated
tests:

```bash
bun run test
bun run typecheck
bun run lint
bun run docs:check
bun run app:mobile:typecheck
```
