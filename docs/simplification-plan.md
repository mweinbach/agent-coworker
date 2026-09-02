# Simplification pass

## Scope

The behavior-preserving cleanup is implemented in small, separate commits.
The starting revision is `0d1b41dd3`; existing features, provider support, protocol formats,
snapshot versions, auth boundaries, and offline recovery remain supported.

Across `src/`, `apps/desktop/src/`, and `apps/mobile/src/`, the pass removes
**1,381 net source lines**: 526 added and 1,907 deleted. Tests and build configuration
are counted separately. This is a targeted reduction, not a claim that the whole project is simple.

## Completed changes

| Area | Simplification |
| --- | --- |
| Providers | Deleted the unused model-factory façade and 14 wrappers. Credential and model tests now exercise the runtime implementations. Removed adapter-only metadata. |
| Model metadata | One static projection replaces repeated field copying and an always-true provider classification. |
| Runtime preparation | Shared continuation fingerprints; OpenAI no longer converts history just to derive request options. |
| Agent admission | One settlement map tracks in-flight operations while retaining separate synchronous capacity reservations. |
| Protocol | Shared handshake schemas and thread read/hydrate assembly, with method-specific validation and cursor behavior intact. |
| Session ownership | Removed the always-null session socket field. Actual transports retain connection ownership and shutdown responsibilities. |
| Session storage | One summary query and composed snapshot schemas, retaining strict version-specific acceptance and normalization for versions 1–7. |
| Desktop sends | One queued record carries text, attachments, references, optimistic identity, and draft ownership; one flusher replaces duplicated paths. |
| Mobile home | Removed unused section-open state and an unused refresh callback. Old cache versions remain readable without discarding history. |
| Skills/plugins | One agent-interface parser and YAML selector; icon containment and size policies stay with each caller. |
| Advanced memory | One index renderer consumes already-loaded entries during consolidation; maintenance tools still read fresh state. |
| Task reviews | Reuse normalized rounds within review tools, coordinator operations, and task prompts. No cross-operation cache. |
| Sync outbox | Serialize each candidate once, then evict the oldest prefix by UTF-8 byte count. |
| Transcript merging | Serialize overlap candidates once, avoiding repeated encoding and temporary slices. |
| Build tooling | One root+harness typecheck graph replaces overlapping compiler invocations. Complexity comparison skips unused file inventories. |

## Measured work reduction

These counts come from deterministic fixtures, not wall-clock performance benchmarks:

- OpenAI history conversions: **2 → 1** per tested runtime invocation.
- MCP credential-file reads for three servers: **6 → 2** per operation; subsequent calls read fresh credentials.
- Sync outbox serialization calls in the eviction fixture: **11 → 4**.
- Memory consolidation directory scans: **2 → 1**.
- Task review normalization: **3 → 1** for the tool; **2 → 1** for coordinator operations and prompt rendering.
- Transcript candidate encoding is linear; longest-overlap comparisons remain **O(k²)** in the worst case.
- The existing Biome scan reports **705 → 698** non-test functions above its cognitive-complexity threshold.
- Unified typechecking preserves the exact repository-source union of the former root and harness graphs,
  including all six harness entry files. Desktop and mobile checks remain separate.

## Verification

- Focused characterization and regression tests cover each slice.
- Independent reviews covered providers, lifecycle/storage, desktop state, mobile/builds, and skills/memory/tasks.
- Review caught a Windows-specific Antigravity test expectation; it now uses the existing platform-support helper.
- Full-suite testing caught a test caller retaining removed reducer arguments; its reconnect assertions remain intact.
- Fixed the existing mobile provider test's mismatched React Native mock instance without changing production behavior.
- Root/desktop/mobile typechecks, lint, formatting, documentation checks, and whitespace checks pass.
- Desktop quality build passes. Three live macOS Electron/CDP smoke tests pass for guidance, interaction queues,
  and reconnect preserving drafts and transcript identity.
- The normal recorded desktop journeys require the Linux CI container. Native smoke checks use the fixture's
  existing no-video option; they do not claim the complete Linux visual/performance suite passed.
- Metro exports pass for iOS and Android. No simulator or manual accessibility verification is claimed.
- Final `bun run test`: **10,307 passed, 0 failed, 39 skipped**; the runner reports all 736 test files passed.

## Sandbox and harness follow-up

The follow-up starts from `dabbe7437` and removes a further **145 net source lines**
across `src/` and `packages/harness/src/` (191 added, 336 removed). Expanded regression
coverage is counted separately; this is not a wall-clock performance claim.

| Area | Simplification |
| --- | --- |
| Policy roots | Deduplicate lexical candidates before canonicalization and reuse the project reference within one resolution. Symlinks are resolved afresh on later calls; protected metadata checks remain. |
| Filesystem invalidation | Scan directory-listing slots once across workspaces, preserving generation invalidation and diagnostic counts. |
| Permission APIs | Remove unused boolean predicates; tests exercise the production read/write assertions and symlink/credential boundaries. |
| Native sandbox setup | Stop Windows bundle verification at the first failure, parse each setup-state file once, and share network-policy interpretation across backends. |
| Tool execution | Classify eligible shell denials once; grep tests use the same tree-aware process-runner seam as production. |
| Turn setup | Skip skill discovery when no skills are referenced, avoid a duplicate environment copy, and avoid empty MCP cleanup waits after successful setup. Late-connection cleanup remains. |
| Runtime adapters | Remove discarded Google-to-PI option/model adaptation and temporary arrays from nested tool matching, retaining telemetry and match precedence. |
| Workflow lifecycle | Share terminal failure handling, remove an unused in-memory journal mirror, and fix pending RPC entries leaked by failed transport sends. |
| Development harness | Build only the selected scenario, share synchronous evidence scans, and validate repaired output through the same path with fresh artifact checks. |

Regression tests cover retargeted symlinks, stale directory generations, network-policy
combinations, integrity failures, explicit environment ownership, cancellation/completion
races, late cleanup, transport failures, checkpoint recovery, and repaired-artifact escapes.
The strict-mode runbook now accurately distinguishes disabling repair from disabling retries.

The full isolated test runner reports **10,430 passed, 0 failed, 39 skipped**, with all
**736 test files passed**. Root/desktop typechecks, lint, formatting, documentation consistency, whitespace checks, and the
platform-boundary ratchet pass. Native macOS sandbox enforcement passes **14 tests**;
the 10 Linux/Windows native checks are skipped on this host, not claimed as verified.

The proposed UI/toolchain follow-up is separate: see the [UI foundation migration
plan](ui-foundation-plan.md). No Vite+, router, or UI migration is included in this pass.

## Deliberately retained

Recovery journals, snapshot migrations, H3 authorization, sandbox/approval enforcement, provider support,
SQLite memory, offline transcripts, and the distinct Task/workflow lifecycles remain intact.
Removing these would change product behavior or retention guarantees rather than simplify implementation.

See [architecture](architecture.md), [WebSocket protocol](websocket-protocol.md),
and [complexity tracker](complexity-tracker.md) for the continuing contracts.
