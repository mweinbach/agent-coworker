# Mobile transcript and home list performance contract

The mobile transcript and home surfaces have one vertical gesture owner each:

- Transcript: one `FlatList`; Activity disclosures render inline.
- Home: one `SectionList`; chat, project, and expanded project-thread rows are flattened.
- Activity: one inline page of at most 24 entries. Earlier and newer controls make every entry
  reachable without adding another vertical scroller.
- Horizontal source and subagent carousels may remain nested because they do not compete for the
  vertical gesture.

## Follow-tail behavior

Follow-tail is user controlled. A drag more than 96 px from the transcript tail suspends following.
Changed row keys are counted once while suspended, even if the same message receives many deltas.
Returning within 96 px resumes following. Pressing Jump requests the tail, but `followTail` remains
false until content height, viewport height, and offset prove the list is within 96 px of the tail.
An empty-to-hydrated transcript therefore exposes Jump if its initial `scrollToEnd` does not settle
at the measured bottom.

Programmatic instant and animated scrolls have an explicit guard. In particular, Android momentum
events emitted by an animated Jump may update the measured position but cannot be interpreted as a
user gesture or cancel the follow-tail intent. A real drag cancels the guard and restores user
ownership.

Streaming row changes may call `scrollToEnd` only while a turn is active and follow-tail is enabled.
Turn completion never calls `scrollToEnd`. `maintainVisibleContentPosition` keeps the first visible
cell anchored while an Activity disclosure expands or collapses.

## Platform list contracts

`mobilePerformanceContracts.ts` is the executable source of truth. Both iOS and Android use:

| Surface | Initial rows | Rows per batch | Batch period | Window (viewports) |
| --- | ---: | ---: | ---: | ---: |
| Transcript | 12 | 8 | 16 ms | 7 |
| Home | 12 | 8 | 24 ms | 7 |

Android enables clipped-subview removal; iOS leaves it disabled to avoid native clipping defects.
Both platforms still use React Native virtualization.

## Measured long-fixture budgets

`mobile.runtime-performance.test.ts` uses the real React profiler, real immutable list models,
`process.memoryUsage()`, forced garbage collection, and intercepted `fetch` calls. It mounts a
1,000-row transcript, keeps a 40-row active window, and commits 1,000 distinct tail revisions
without coalescing.

| Metric | Budget |
| --- | ---: |
| Update commits | exactly 1,000 |
| Row renders, including the initial active window | at most 1,040 |
| Update commits over the 16.67 ms frame budget | at most 10 |
| Total React update commit duration | at most 1,500 ms |
| Heap after the 1,000-row fixture mount | at most 96 MiB |
| Heap after 1,000 revisions | at most 112 MiB |
| Additional retained heap after 1,000 revisions | at most 48 MiB |
| Network requests | 0 |

The store ingestion test separately proves that 1,000 raw deltas remain one-to-one, produce one
retained feed item, and issue zero requests. The Activity pagination test traverses all 1,000
entries while asserting that no page renders more than 24.

The profiler runs the shared JavaScript render/model path available on a headless host. iOS and
Android still require their independent Expo exports, and their native list settings are asserted
separately. Delta coalescing is intentionally absent. Add it only after device profiling identifies
per-delta ingestion as the bottleneck and records a before/after trace.
