# Mobile transcript and home list performance contract

The mobile transcript and home surfaces have one vertical gesture owner each:

- Transcript: one `FlatList`; Activity disclosures render inline.
- Home: one `SectionList`; chat, project, and expanded project-thread rows are flattened.
- Horizontal source and subagent carousels may remain nested because they do not compete for the
  vertical gesture.

## Follow-tail behavior

Follow-tail is user controlled. A drag more than 96 px from the transcript tail suspends following.
Changed row keys are counted once while suspended, even if the same message receives many deltas.
Returning within 96 px or pressing Jump clears the unseen count and resumes following. Programmatic
scroll events never change this state.

Streaming row changes may call `scrollToEnd` only while a turn is active and follow-tail is enabled.
Turn completion never calls `scrollToEnd`. `maintainVisibleContentPosition` keeps the first visible
cell anchored while an Activity disclosure expands or collapses.

## Deterministic budgets

`mobilePerformanceContracts.ts` is the executable source of truth. Both iOS and Android use:

| Surface | Initial rows | Rows per batch | Window (viewports) | Scheduled-row budget |
| --- | ---: | ---: | ---: | ---: |
| Transcript | 12 | 8 | 7 | 80 |
| Home | 12 | 8 | 7 | 80 |

Android enables clipped-subview removal; iOS leaves it disabled to avoid native clipping defects.
Both platforms still use React Native virtualization.

Long fixtures are fixed at 1,000 inputs:

- 1,000 raw deltas must remain one-to-one, produce one retained feed item, and issue zero network
  requests.
- A 1,000-row transcript must materialize one list model per row, revise at most one row for one
  immutable tail update, and retain at most 512,000 serialized model bytes.
- A 1,000-row home fixture must remain flat, retain at most 768,000 serialized model bytes, and
  satisfy the platform render-window contract.

These are structural budgets rather than wall-clock thresholds, so they are deterministic across CI
hosts. Delta coalescing is intentionally absent. Add it only after device profiling identifies
per-delta ingestion as the bottleneck and records a before/after trace.
