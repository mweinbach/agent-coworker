# Task Plan

## Fix Mobile Relay Pairing Trust and Workspace Cache

- [x] Confirm the three mobile-relay review findings are still real against current `HEAD`.
- [x] Require QR-derived pairing proof plus encrypted handshake proof before either side persists a newly trusted phone/desktop or marks the secure relay connected.
- [x] Invalidate the mobile relay workspace cache when the desktop save-state path updates persisted workspaces.
- [x] Re-run the focused relay/mobile pairing tests and `bun run typecheck`.

## Fix Mobile Relay Pairing Trust and Workspace Cache Review

- `src/shared/mobileRelaySecurity.ts` now carries the hardened pairing contract: QR payloads include a per-session `pairingSecret`, first contact can include a deterministic `pairingProof`, and both peers can recognize a dedicated encrypted `relay/handshakeProof` payload before trusting the other side.
- `apps/desktop/electron/services/mobileRelayBridge.ts` no longer persists a new trusted phone or marks the bridge connected from plaintext relay control traffic. First-time pairing now requires a valid QR-derived proof on `clientHello`, plaintext `secureReady` is rejected, and trust/connected state advance only after the phone proves it can decrypt the shared-key envelope.
- `apps/mobile/modules/remodex-secure-transport/src/index.ts` no longer saves a trusted desktop from plaintext `relayMacRegistration`, rejects plaintext `secureReady`, and only persists the desktop plus flips to `connected` after receiving the encrypted desktop handshake proof.
- `apps/desktop/electron/ipc/mobileRelay.ts` now exposes workspace-cache invalidation, and `apps/desktop/electron/ipc/workspace.ts` fires that hook immediately after `saveState(...)`, so mobile relay `workspace/list` and `workspace/switch` reload fresh persisted workspaces after edits instead of serving stale entries for the TTL window.
- Focused verification passed with:
  - `~/.bun/bin/bun test apps/desktop/test/mobile-relay-bridge.test.ts apps/desktop/test/mobile-relay-ipc.test.ts test/mobile.pairing-qrcode.test.ts test/mobile.pairing-scan-handler.test.ts test/mobile.transport-integration.test.ts apps/desktop/test/desktop-schemas.test.ts apps/desktop/test/remodex-state.test.ts apps/desktop/test/remote-access-page.test.ts`
  - `~/.bun/bin/bun run typecheck`

## Cap Attachment Picker and Pending Steer Queues

- [x] Confirm the three new unresolved review threads are still real against current HEAD.
- [x] Reject oversized attachment selections in the desktop picker before `arrayBuffer()` and base64 encoding run in the renderer.
- [x] Bound pending steer attachment payload growth while a turn is still accepting queued steers.
- [x] Deduplicate attachment-aware requeue logic and rerun focused verification, typecheck, and the full suite.

## Cap Attachment Picker and Pending Steer Queues Review

- `apps/desktop/src/ui/ChatView.tsx` was still reading selected files into memory and base64-encoding them before any size check. That made the new attachment limits enforceable only after the renderer had already buffered the payload.
- `src/shared/attachments.ts` now exposes shared base64-size helpers, and `apps/desktop/src/app/attachmentInputs.ts` uses them to validate raw file sizes plus already-queued attachments before the picker starts reading any file bytes.
- `src/server/session/TurnExecutionManager.ts` was still letting repeated accepted steers accumulate arbitrarily large attachment payloads in `pendingSteers`. It now rejects new steer attachments once the queued attachment payload would exceed one turn-sized combined budget.
- `apps/desktop/src/app/store.helpers/runtimeState.ts` now owns `prependPendingThreadMessageWithAttachments(...)`, and both `threadEventReducer.ts` and `workspaceDefaults.ts` use it so attachment-only requeues cannot drift out of sync across the two FIFOs.
- Added focused regressions in `apps/desktop/test/attachment-inputs.test.ts`, `apps/desktop/test/runtimeState.test.ts`, and `test/session.test.ts`.
- Verification passed with:
  - `~/.bun/bin/bun test apps/desktop/test/attachment-inputs.test.ts apps/desktop/test/runtimeState.test.ts test/session.test.ts`
  - `~/.bun/bin/bun run typecheck`
  - `~/.bun/bin/bun test --max-concurrency 1` on 2026-03-27 (`2750 pass`, `3 skip`, `0 fail`)

## Resolve Attachment Review Threads

- [x] Confirm each unresolved attachment review thread is still real against current HEAD before editing.
- [x] Fix the server attachment path so turn-start and steer attachments honor `uploadsDirectory` and reject oversized payloads before decode.
- [x] Fix the desktop attachment send path so attachment-only sends/steers stop injecting fake prompt text, the file picker uses linear-time base64 conversion, and pending-steer duplicate detection stays attachment-aware.
- [x] Update focused tests plus generated JSON-RPC schema artifacts, then rerun targeted verification, typecheck, and the full suite.

## Resolve Attachment Review Threads Review

- Confirmed real before patching:
  - `src/server/session/TurnExecutionManager.ts` was decoding `contentBase64` without a size guard and hardcoding attachment writes to `workingDirectory/User Uploads`, ignoring `config.uploadsDirectory`.
  - `apps/desktop/src/ui/ChatView.tsx` was synthesizing fake user text like `[photo.png]` for attachment-only sends and using a quadratic `Uint8Array.reduce(... String.fromCharCode ...)` base64 conversion in the picker.
  - `apps/desktop/src/app/store.helpers/threadEventReducer.ts` was still treating same-text pending steers as duplicates even when their attachments differed, which also collapsed attachment-only steers because the text key was empty in both cases.
- The harness now shares a single attachment payload cap via `src/shared/attachments.ts`, enforces it in the JSON-RPC turn schemas, validates it again in the session runtime before any decode, and uses the configured `uploadsDirectory` for message/steer attachment writes when one is set.
- Attachment-only turns and steers now keep the model input empty while still projecting a user-visible attachment label in the transcript/feed/session events. That keeps replay/history readable without mutating model context.
- The desktop picker now uses a chunked linear-time array-buffer-to-base64 helper, and pending-steer state now carries an attachment signature so duplicate suppression only triggers when both text and attachments match.
- Regenerated `docs/generated/websocket-jsonrpc.schema.json` and `docs/generated/websocket-jsonrpc.d.ts` after the JSON-RPC schema change.
- Verification passed with:
  - `~/.bun/bin/bun test test/session.test.ts test/server.jsonrpc.flow.test.ts apps/desktop/test/jsonrpc-single-connection.test.ts apps/desktop/test/chat-reasoning-ui.test.ts`
  - `~/.bun/bin/bun run typecheck`
  - `~/.bun/bin/bun test test/jsonrpc.codegen.test.ts`
  - `~/.bun/bin/bun test --max-concurrency 1` on 2026-03-26 (`2740 pass`, `3 skip`, `0 fail`)

## Preserve Queued Attachments During Workspace-Default Flush

- [x] Confirm the remaining unresolved workspace-default review thread is still real against current HEAD.
- [x] Make the workspace-default queued-message flush path replay attachment payloads atomically with their queued text.
- [x] Add a desktop regression covering attachment-only queued sends after defaults apply, then rerun focused verification plus repo-wide checks.

## Preserve Queued Attachments During Workspace-Default Flush Review

- `apps/desktop/src/app/store.actions/workspaceDefaults.ts` was still draining only `pendingThreadMessages` and replaying text-only sends after defaults applied. That dropped queued attachments entirely, and attachment-only queued sends were discarded because the empty string was trimmed before replay.
- The workspace-default flush path now mirrors the shared thread reducer behavior: it shifts queued attachments alongside queued text, replays them together through `sendUserMessageToThread(...)`, and requeues both FIFOs atomically if the send cannot proceed yet.
- `apps/desktop/src/app/store.helpers.ts` now re-exports `shiftPendingThreadAttachments`, which the workspace-default action needs for the shared runtime helper contract.
- `apps/desktop/test/workspace-settings-sync.test.ts` now clears `RUNTIME.pendingThreadAttachments` in test setup and covers the attachment-only queued-send regression so the workspace-default replay path stays aligned with the normal reducer path.
- Verification passed with:
  - `~/.bun/bin/bun test apps/desktop/test/workspace-settings-sync.test.ts`
  - `~/.bun/bin/bun run typecheck`
  - `~/.bun/bin/bun test --max-concurrency 1` on 2026-03-26 (`2741 pass`, `3 skip`, `0 fail`)

## Finish Attachment Turn Limits

- [x] Confirm the remaining transcript-only attachment send and aggregate turn-size review threads are still real.
- [x] Ensure attachment-only transcript sends start a live session immediately instead of returning success on a draft-only path.
- [x] Add shared aggregate/count attachment limits for JSON-RPC turn requests and session runtime validation, regenerate JSON-RPC artifacts, and rerun verification.

## Finish Attachment Turn Limits Review

- `apps/desktop/src/app/store.actions/thread.ts` was still treating `newThread({ attachments, firstMessage: "" })` as a draft path unless `mode === "session"` or the text was non-empty. That meant transcript-only attachment sends returned success, cleared the composer, and never started a live session.
- `newThread(...)` now treats attachments as real first-turn input, mirrors `reconnectThread(...)` by queueing the initial text/attachment pair through `queuePendingThreadMessage(...)`, and lets the shared thread reducer flush attachment-only first turns once the JSON-RPC thread is live.
- `src/shared/attachments.ts` now defines shared per-turn attachment limits: max file count, max per-file base64 size, and a combined base64 budget. `src/server/jsonrpc/schema.threadTurn.ts` enforces those limits at request validation time, and `src/server/session/TurnExecutionManager.ts` reuses the same helper for runtime validation.
- Added regressions for attachment-only transcript sends in `apps/desktop/test/jsonrpc-single-connection.test.ts`, request-layer aggregate/count failures in `test/server.jsonrpc.flow.test.ts`, and runtime count validation in `test/session.test.ts`.
- Regenerated `docs/generated/websocket-jsonrpc.schema.json` and `docs/generated/websocket-jsonrpc.d.ts` after the turn-schema change.
- Verification passed with:
  - `~/.bun/bin/bun test apps/desktop/test/jsonrpc-single-connection.test.ts test/server.jsonrpc.flow.test.ts test/session.test.ts`
  - `~/.bun/bin/bun run docs:generate-jsonrpc`
  - `~/.bun/bin/bun run typecheck`
  - `~/.bun/bin/bun test --max-concurrency 1` on 2026-03-27 (`2745 pass`, `3 skip`, `0 fail`)

## Stabilize JSON-RPC Replay Test Timeouts

- [x] Inspect the failing GitHub Actions `Docs + Tests` job and confirm whether the failures are timeout-budget related.
- [x] Compare the failing replay-heavy JSON-RPC tests locally to determine whether they are functionally broken or just exceeding the CI budget intermittently.
- [x] Widen only the replay-heavy test budgets that are hitting the 20s cap, rerun focused verification, and capture the evidence below.

## Stabilize JSON-RPC Replay Test Timeouts Review

- GitHub Actions runs on PR #61 showed multiple replay-heavy `test/server.jsonrpc.flow.test.ts` cases timing out exactly at the 20 second test budget on `ubuntu-latest`, including `thread/read can include journal-projected turns and thread/resume can replay from a journal cursor` (run `23628476285`) and, on an earlier commit in the same branch, `thread/read and thread/resume replay journals beyond 1000 events` (run `23628376698`).
- Local focused reruns did not reproduce a logic failure: the affected tests completed in roughly 70-130 ms in isolation, and repeated reruns stayed green. That points to CI-only replay/teardown slowness rather than a deterministic contract regression in the JSON-RPC replay flow.
- `test/server.jsonrpc.flow.test.ts` now uses explicit replay-test timeout constants so only the replay-heavy cases get a wider budget, and the mixed timeout declaration on the journal-projection test was normalized to a single Bun timeout style.
- Verification passed with:
  - `~/.bun/bin/bun test test/server.jsonrpc.flow.test.ts --max-concurrency 1 --test-name-pattern "thread/read can include journal-projected turns and thread/resume can replay from a journal cursor" --rerun-each 50`
  - `~/.bun/bin/bun test test/server.jsonrpc.flow.test.ts --max-concurrency 1 --test-name-pattern "thread/resume replays a journal cursor once before reattaching the live thread sink" --rerun-each 50`
  - `~/.bun/bin/bun test test/server.jsonrpc.flow.test.ts --max-concurrency 1 --test-name-pattern "thread/read and thread/resume replay journals beyond 1000 events" --rerun-each 20`
  - `~/.bun/bin/bun test test/server.jsonrpc.flow.test.ts --max-concurrency 1 --rerun-each 10`
  - `~/.bun/bin/bun run typecheck`
  - `~/.bun/bin/bun test --max-concurrency 1` on 2026-03-26 (`2734 pass`, `3 skip`, `0 fail`)

## Keep thread/read Citation Enrichment Off the Response Path

- [x] Confirm `thread/read` is awaiting network-backed citation enrichment before responding.
- [x] Add a cache-only snapshot enrichment path plus background cache priming for unresolved citations.
- [x] Update `thread/read` to return the local snapshot immediately, using cached citation metadata only and warming unresolved citations asynchronously.
- [x] Add focused citation/JSON-RPC regressions and rerun targeted verification.

## Keep thread/read Citation Enrichment Off the Response Path Review

- `src/server/citationMetadata.ts` now keeps a settled citation-resolution cache alongside the in-flight promise cache, exposes a cache-only assistant snapshot enrichment path, and adds a best-effort background cache-prime helper for unresolved assistant citation annotations.
- `src/server/jsonrpc/routes/thread.ts` no longer awaits network-backed citation resolution during `thread/read`. The route now rewrites snapshot assistant annotations only from already-cached citation metadata, sends the snapshot immediately, and then schedules background cache warming in a microtask for any still-unresolved Google redirect citations.
- `test/citationMetadata.test.ts` now covers cache-only snapshot enrichment, and `test/jsonrpc.router.test.ts` now covers both cache-hit enrichment and the “return immediately, then warm the cache for later reads” behavior.
- Verification passed with `bun test test/citationMetadata.test.ts test/jsonrpc.router.test.ts`, `bun run typecheck`, and `bun test` on 2026-03-23 (`2628 pass`, `3 skip`, `0 fail`).

## Keep Google Citation Enrichment Off Live Stream Path

- [x] Confirm the reviewed regression is the synchronous `content.stop` await in the Google native interaction stream loop.
- [x] Move citation enrichment onto a background path so `text-end` delivery is not blocked by network-backed citation resolution.
- [x] Preserve enriched annotations in the final assistant payload by awaiting background work before the step returns.
- [x] Add a focused regression for slow citation resolution on the Google stream path and rerun the targeted verification slice.

## Keep Google Citation Enrichment Off Live Stream Path Review

- `src/runtime/googleNativeInteractions.ts` no longer awaits citation enrichment inside the live `content.stop` event loop. The runtime now queues background annotation enrichment per completed text block, emits `text-end` immediately with the current block state, and only waits for the queued enrichment promises after stream delivery completes and before the final assistant payload is returned.
- `test/runtime.google-interactions.test.ts` now covers the slow-fetch case explicitly: a stalled citation fetch no longer blocks `text-end` projection, but the underlying text block still ends up enriched once the queued work resolves.
- Verification passed with `bun test test/runtime.google-interactions.test.ts test/citationMetadata.test.ts`, `bun run typecheck`, and `bun test` on 2026-03-23 (`2626 pass`, `3 skip`, `0 fail`).

## Google Citation Title Resolution

- [x] Confirm whether real Google native citation data already contains article titles or only opaque redirect URLs plus domain-like labels.
- [x] Add a harness-side citation resolver that can follow opaque Google grounding redirects to the final article URL and page title with caching and tight timeouts.
- [x] Use that resolver in the live Google runtime before assistant annotation items hit the UI, and in `thread/read` hydration so existing snapshots improve on reload.
- [x] Re-run focused resolver/runtime/JSON-RPC tests, repo typecheck, and the full `bun test` lane.

## Google Citation Title Resolution Review

- `src/server/citationMetadata.ts` now owns harness-side citation enrichment for opaque Google grounding redirects. It follows the redirect to the final article URL, extracts a page title from `og:title`/`twitter:title`/`<title>`, caches by original citation URL, and keeps strict timeouts and partial-failure fallback so the UI never has to guess at provider-specific redirect behavior.
- `src/runtime/googleNativeInteractions.ts` now resolves assistant text-block annotations before `text-end` events are emitted, so new Google native web-search answers stream into the projected feed with real article URLs and page titles already attached to the annotations.
- `src/server/jsonrpc/routes/thread.ts` now applies the same enrichment during `thread/read`, which upgrades existing persisted Google snapshots on hydration without changing the desktop-side rendering contract.
- Added focused regressions in `test/citationMetadata.test.ts`, `test/runtime.google-interactions.test.ts`, and `test/jsonrpc.router.test.ts`.
- Verification passed with:
  - `~/.bun/bin/bun test test/citationMetadata.test.ts test/runtime.google-interactions.test.ts test/jsonrpc.router.test.ts`
  - `~/.bun/bin/bun run typecheck`
  - `~/.bun/bin/bun test` on 2026-03-23 (`2625 pass`, `3 skip`, `0 fail`)

## Citation Popup Polish

- [x] Inspect the real Google cowork snapshot and confirm whether the popup had access to the final destination URL or only the opaque Vertex redirect.
- [x] Hide opaque Google grounding redirect URLs from the popup while keeping a clean source label/fallback favicon path.
- [x] Move the citation popup card out of the conversation flow so it can stack above the composer instead of tucking under the input surface.
- [x] Re-run focused citation tests, repo typecheck, and the full `bun test` lane.

## Citation Popup Polish Review

- The real Google cowork snapshot in `~/.cowork/sessions.db` still only exposes the opaque `vertexaisearch.cloud.google.com/grounding-api-redirect/...` URL plus a title like `cbsnews.com` on the assistant annotations. There is no stable final article URL in the persisted feed to display directly, so the renderer now treats that redirect as an opaque open target instead of printing it back to the user.
- `src/shared/displayCitationMarkers.ts` now exports shared citation-display helpers that recognize opaque Google grounding redirects and derive sane display metadata from the source title/hostname. That keeps the provider-specific redirect rule out of the desktop view logic and gives future UIs the same contract.
- `apps/desktop/src/components/ai-elements/message.tsx` now renders citation popups through a fixed body-level portal anchored to the chip button. The card clamps to the viewport, can flip upward when needed, and stacks above the composer instead of behaving like an absolutely positioned child inside the scrolling conversation log.
- The desktop popup card now hides opaque redirect bodies, avoids showing `vertexaisearch.cloud.google.com` as the source hostname/favicon, and still opens the underlying citation target when the user clicks through.
- Added regression coverage in `test/displayCitationMarkers.test.ts` and `apps/desktop/test/message-links.test.ts` for opaque Google redirect display metadata, popup portal rendering, grouped-source navigation, and the “hide redirect text but keep site label” behavior.

## Citation Popup Compactness Follow-up

- [x] Tighten the popup card sizing and control spacing so the source picker reads like a compact affordance instead of a large modal-like surface.
- [x] Stabilize favicon rendering so the popup shows an immediate placeholder and prewarms icon URLs before opening.
- [x] Re-run focused citation tests, repo typecheck, and the full `bun test` lane.

## Citation Popup Compactness Follow-up Review

- `apps/desktop/src/components/ai-elements/message.tsx` now uses a smaller citation popup surface with tighter header/body spacing, smaller arrow buttons, and reduced typography so the card reads as a lightweight source picker instead of an oversized sheet.
- Citation favicon rendering is now placeholder-first: the popup always reserves the icon slot with a compact monogram badge, then fades the favicon in only after it loads. That avoids the empty-image flash and keeps the row geometry stable.
- Citation chips now prewarm the favicon URLs as soon as the chip mounts, so by the time the user opens the popup the site icon is usually already cached instead of starting its network request on click.
- Added a focused regression in `apps/desktop/test/message-links.test.ts` to lock the smaller popup width contract and verify favicon prewarming starts before the popup opens.

## Citation Popup Card

- [x] Inspect the chip rendering path and confirm the desktop renderer can own the popup interaction while the shared normalizer still owns chip grouping/order.
- [x] Turn paragraph-end citation chips into interactive source popups with previous/next navigation over grouped URLs.
- [x] Hide the footer sources carousel for assistant messages that already render native annotation chips.
- [x] Re-run focused desktop/shared rendering tests, repo typecheck, and full `bun test`.

## Citation Popup Card Review

- Native annotation citation chips now open an anchored popup card with previous/next arrows, a current-source counter, and the selected source title/domain/URL instead of acting like a static inline label. The shared renderer still owns paragraph/list-item grouping in `src/shared/displayCitationMarkers.ts`, while the desktop `cite` component in `apps/desktop/src/components/ai-elements/message.tsx` owns the popup interaction.
- The popup uses the full grouped source list for that chip, not just the primary URL. To get that source payload through the Streamdown sanitize/component pipeline reliably, the shared HTML-mode renderer now packs the encoded source list into the chip `title` attribute with a private prefix instead of relying on a custom `data-*` prop that Streamdown did not consistently forward to the custom component.
- `apps/desktop/src/ui/ChatView.tsx` now suppresses the separate footer `SourcesCarousel` when the assistant message already has native annotation chips, so the same sources do not render twice with two different affordances.
- Added/updated regression coverage in `test/displayCitationMarkers.test.ts`, `apps/desktop/test/message-links.test.ts`, `apps/desktop/test/chat-view.stability.test.tsx`, and `apps/desktop/test/protocol-v2-events.test.ts` to lock the encoded chip contract, DOM popup behavior, arrow navigation, and the “chip instead of footer carousel” rendering path.
- Verification passed with:
  - `~/.bun/bin/bun test apps/desktop/test/message-links.test.ts test/displayCitationMarkers.test.ts apps/desktop/test/chat-view.stability.test.tsx apps/desktop/test/protocol-v2-events.test.ts`
  - `~/.bun/bin/bun run typecheck`
  - `~/.bun/bin/bun test` on 2026-03-23 (`2618 pass`, `3 skip`, `0 fail`)

## Citation Chip Polish

- [x] Inspect the current native citation rendering path and confirm the chip styling has to be applied in the shared markdown normalizer rather than provider-specific UI code.
- [x] Collapse native annotation citations into one chip per paragraph or list item instead of dropping markers inline after each sentence.
- [x] Feed source titles into the shared renderer so the chip can show a compact source label plus `+N` when multiple citations land in the same paragraph.
- [x] Re-run focused rendering/protocol tests, repo typecheck, and full `bun test`.

## Citation Chip Polish Review

- Native assistant annotation citations now render as one compact chip at the end of each markdown paragraph or list item instead of as inline superscripts. The shared resolver in `src/shared/displayCitationMarkers.ts` still uses the raw-vs-markdown anchor heuristic to find the correct containing block, but HTML-mode native citations now collapse to a block-end chip wrapper rather than attaching themselves to the middle of a sentence.
- `apps/desktop/src/components/ai-elements/message.tsx` now passes citation source metadata into the shared renderer and styles the chip through a dedicated `cite` wrapper that survives the Streamdown sanitize/render pipeline. That lets the chip show a compact source label such as `Safety Memo +1` while keeping normal inline links and legacy superscript citations unchanged.
- `apps/desktop/src/ui/ChatView.tsx` now forwards the per-message citation sources into `MessageResponse`, so native web-search and URL-context answers can label the chip from actual source metadata instead of falling back to bare numbers.
- Added/updated regression coverage in `test/displayCitationMarkers.test.ts`, `apps/desktop/test/message-links.test.ts`, and `apps/desktop/test/protocol-v2-events.test.ts` to lock paragraph-end chip placement, grouping behavior, and live feed rendering around the shared JSON-RPC path.
- Verification passed with:
  - `~/.bun/bin/bun test test/displayCitationMarkers.test.ts apps/desktop/test/message-links.test.ts apps/desktop/test/tool-card-formatting.test.ts apps/desktop/test/protocol-v2-events.test.ts`
  - `~/.bun/bin/bun run typecheck`
  - `~/.bun/bin/bun test` on 2026-03-23 (`2616 pass`, `3 skip`, `0 fail`)

## Google Cowork Citation Follow-up

- [x] Inspect the latest real Google cowork session snapshot and confirm whether native web search already arrives in the canonical feed.
- [x] Fix shared native citation insertion so Google `url_citation` indices land on stable sentence boundaries without requiring provider-specific UI logic.
- [x] Make native web-search cards show Google `queries` detail without requiring provider-specific desktop branching.
- [x] Re-run focused citation/tool-render verification plus repo typecheck and record the status.

## Google Cowork Citation Follow-up Review

- The latest real Google cowork session in `~/.cowork/sessions.db` (`df63bab0-ef91-412d-84ce-db67fd647ea3`) already contained the canonical `nativeWebSearch` tool item plus `url_citation` annotations on the assistant message. The missing behavior in the UI was not feed loss; it was citation marker placement and a formatter gap for Google-style `queries` args.
- `src/shared/displayCitationMarkers.ts` now resolves native annotation endpoints through a shared raw-vs-markdown heuristic: keep raw Google anchors when they already line up with the markdown source, otherwise fall back to markdown-aware remapping and snap short overshoots back to the prior sentence boundary. That keeps superscript source numbers out of mid-word positions and off the next bullet heading in the real Google cowork answer.
- `apps/desktop/src/ui/chat/toolCards/toolCardFormatting.ts` now treats `nativeWebSearch` payloads with top-level `queries` the same way it already treats action-shaped search payloads, so Google native web-search cards surface the actual search query without any extra provider-specific UI branch.
- Added regression coverage in `test/displayCitationMarkers.test.ts`, `apps/desktop/test/message-links.test.ts`, and `apps/desktop/test/tool-card-formatting.test.ts` to lock the markdown-aware citation placement and Google query-array rendering behavior.
- Verification passed with:
  - `~/.bun/bin/bun test test/displayCitationMarkers.test.ts apps/desktop/test/message-links.test.ts apps/desktop/test/tool-card-formatting.test.ts apps/desktop/test/store-feed-mapping.test.ts`
  - `~/.bun/bin/bun run typecheck`
  - `~/.bun/bin/bun test` on 2026-03-23 (`2616 pass`, `3 skip`, `0 fail`)

## Cowork Session UI Mapping Follow-up

- [x] Inspect the real Codex LGA cowork session in the harness snapshot store and compare the canonical projected feed to the desktop rendering.
- [x] Remove blank reasoning placeholder rows from the desktop activity timeline so harness-emitted empty reasoning items do not render as empty `Summary` blocks.
- [x] Normalize Codex native web-search start args in the harness/model-stream mapper so live desktop tool cards can show the search/open-page detail without provider-specific UI logic.
- [x] Re-run focused desktop/model-stream verification, repo typecheck, and record the current full-suite status.

## Cowork Session UI Mapping Follow-up Review

- The real session snapshot in `~/.cowork/sessions.db` already contains the Codex web-search activity as canonical projected `nativeWebSearch` tool items. The screenshot mismatch came from empty harness `reasoning` placeholders (`text: ""`) being rendered as blank `Summary` rows in the desktop activity card.
- `apps/desktop/src/ui/chat/activityGroups.ts` now skips blank reasoning placeholders during grouping/timeline construction, so the activity card only renders meaningful reasoning text alongside the tool steps that actually happened.
- `src/shared/modelStream.ts` now wraps OpenAI/Codex native web-search start args as `{ action: ... }`, which matches the shared tool-card contract and keeps the live running web-search subtitle specific instead of falling back to a generic “Searching the web”. The formatter in `apps/desktop/src/ui/chat/toolCards/toolCardFormatting.ts` also tolerates the older bare-action shape for replay compatibility.
- Verification passed with:
  - `bun test --cwd apps/desktop test/chat-activity-group-card.test.tsx test/store-feed-mapping.test.ts test/protocol-v2-events.test.ts test/chat-reasoning-ui.test.ts`
  - `bun test test/modelStreamReplay.test.ts apps/desktop/test/model-stream-mapper.test.ts apps/desktop/test/tool-card-formatting.test.ts`
  - `bun run typecheck`
  - `bun test test/permissions.test.ts` currently fails on this branch in unrelated path-allowlist coverage, and `bun test` currently stops on the same existing `test/permissions.test.ts` failures

## Harness-Owned Projection Contract

- [x] Move live conversation projection into a shared harness-owned reducer/sink so JSON-RPC live projection, journal persistence, session snapshots, and thread/read hydration all share the same ordering and item-id logic.
- [x] Switch desktop JSON-RPC feed handling to consume projected `turn/*` + `item/*` payloads and canonical `thread/read.coworkSnapshot` hydration instead of re-projecting provider/model events locally.
- [x] Update the JSON-RPC schema/docs/generated artifacts and add focused regressions for reasoning/tool ordering, repeated raw ids, non-turn projected items, ask/approval parity, and the new snapshot contract.
- [x] Re-run the projection-focused slices, `bun run typecheck`, regenerate JSON-RPC artifacts, and finish with a full `bun test` pass.

## Harness-Owned Projection Contract Review

- Added a shared harness projection core under `src/server/projection/` plus shared projected-item/model-stream utilities under `src/shared/`, then rewired the JSON-RPC live projector, journal projector, `SessionSnapshotProjector`, and `thread/read` snapshot path onto that single reducer/sink flow.
- `thread/read` now returns the canonical projected `coworkSnapshot` feed unchanged, JSON-RPC item payloads use the explicit projected-item union, non-turn feed entries ride through `item/*` with `turnId: null`, and ask/approval now emit matching projected system feed items alongside the interactive server requests.
- Desktop no longer translates projected JSON-RPC items back into synthetic `model_stream_*`, `assistant_message`, or `reasoning` events for live/persisted harness-backed threads; it applies projected items/snapshots directly and only keeps the legacy transcript replay mapper for old local transcript imports.
- Focused regressions now cover shared projector reasoning/tool ordering, repeated provider raw ids, raw Gemini/native tool replay, projected non-turn feed items, ask/approval system-entry parity, desktop projected-item consumption, canonical `thread/read` hydration, and the updated websocket protocol/schema artifacts.
- Verification passed with:
  - `bun test test/jsonrpc.projectors.test.ts test/sessionSnapshotProjector.test.ts test/jsonrpc.thread-read-projector.test.ts apps/desktop/test/control-socket.test.ts apps/desktop/test/protocol-v2-events.test.ts test/server.jsonrpc.flow.test.ts`
  - `bun run typecheck`
  - `bun run docs:generate-jsonrpc`
  - `bun test` on 2026-03-23 (`2608 pass`, `3 skip`, `0 fail`)

## Fix CLI JSON-RPC Contract Regressions

- [x] Confirm the reviewed CLI regressions against the live JSON-RPC schema and route handlers before patching.
- [x] Fix the CLI thread/auth/budget/tools/stream handling so it matches the current JSON-RPC request, result, and notification shapes.
- [x] Add focused REPL regressions for thread envelopes, provider auth method loading, API-key auth routing, tool listing, and streamed delta/toolCall handling.
- [x] Re-run focused REPL verification, repo typecheck, and the full `bun test` lane, then capture the exact evidence.

## Fix CLI JSON-RPC Contract Regressions Review

- `src/cli/repl.ts` now reads `thread/start` / `thread/resume` results from the JSON-RPC `{ thread: { ... } }` envelope, rehydrates CLI state from returned control events, and eagerly loads workspace control metadata (`session/state/read`, `provider/catalog/read`, `provider/authMethods/read`) after connect so the REPL does not start in a half-hydrated state.
- `src/cli/repl/commandRouter.ts` now clears hard caps through `cowork/session/usageBudget/set`, fetches auth methods before `/connect` uses them, routes API-key connects through `cowork/provider/auth/setApiKey`, and lists tools from the real session tool-name policy instead of misreading `cowork/session/state/read` as a registry.
- `src/cli/repl/serverEventHandler.ts` now matches the JSON-RPC notification payloads: assistant/reasoning deltas come from `params.delta`, tool lifecycle notifications use `item.type === "toolCall"`, and `thread/started` / control-event envelopes update CLI state consistently.
- Added focused REPL coverage in `test/repl.test.ts`, `test/repl.server-event-handler.test.ts`, `test/repl.thread-envelope.test.ts`, and updated the REPL websocket harness tests for the thread-envelope startup contract.
- Verification passed with:
  - `bun test test/repl.test.ts test/repl.server-event-handler.test.ts test/repl.thread-envelope.test.ts test/repl.disconnect-send.test.ts test/repl.restart-failure.test.ts`
  - `bun run typecheck`
  - `bun test` on 2026-03-23 (`2604 pass`, `3 skip`, `0 fail`)

## Remove Archived TUI Surface

- [x] Remove the archived TUI implementation and its repo entrypoints instead of keeping it as a second terminal client.
- [x] Delete the TUI-specific source, tests, docs, and package dependencies, and simplify the terminal entrypoint down to the supported CLI path.
- [x] Re-run targeted verification for the CLI/docs changes plus the full suite after the removal.

## Remove Archived TUI Surface Review

- The repo no longer carries a second terminal UI surface. `apps/TUI/`, `src/tui/`, the OpenTUI docs mirror under `docs/opentui/`, and the dedicated TUI test files were removed outright instead of being kept as archived baggage.
- The terminal entrypoint is now CLI-only: `src/index.ts` always routes to `runCliRepl(...)`, `package.json` no longer exposes `bun run tui`, and `src/cli/args.ts` dropped the retired mouse/TUI-only flags while keeping `--cli` as a harmless compatibility alias.
- Root docs and contributor guidance were updated to stop advertising the removed client, and the root package no longer installs the unused OpenTUI and Solid dependencies.
- Verification passed with `bun test test/cli-args.test.ts test/docs.check.test.ts`, `bun run docs:check`, `bun run typecheck`, and full `bun test` on 2026-03-23 (`2598 pass`, `3 skip`, `0 fail`).

## Optimize Slow Tool Tests

- [x] Measure the current slow tool-test cases precisely and identify whether the cost is subprocess spawning, HTML parser startup, or explicit timeout waits.
- [x] Refactor the slowest tool tests to use deterministic test doubles or lighter-weight code paths without weakening the behavioral contract under test.
- [x] Re-run the focused tool-test timing check, `bun test test/tools.test.ts`, `bun run typecheck`, and the full `bun test` lane, then record the before/after evidence.

## Optimize Slow Tool Tests Review

- The main hotspot was `test/tools.test.ts`, not the smaller `test/tools.*.test.ts` files. A direct timing probe showed `test/tools.test.ts` at about `0.656s`, with the worst individual cases coming from four bash tests that spawned real shells (~35-40ms each), one HTML webFetch test that paid the `jsdom` + Readability startup cost (~195ms), and the intentional timeout test (~26ms).
- `src/tools/bash.ts` now exposes a narrow `__internal` runner override for tests, and `src/tools/webFetch.ts` now exposes a narrow `__internal` HTML-render override for tests. `test/tools.test.ts` uses those hooks so the slow assertions still exercise the tool entrypoints without paying real subprocess startup or heavy HTML-parser initialization on every run.
- The focused file now runs in about `0.253s` instead of `0.656s`, and the worst avoidable cases dropped sharply: bash stderr/cwd/large-output/stdout+stderr checks are sub-millisecond, and the Exa-enriched HTML case is ~2ms instead of ~195ms. The remaining ~25ms timeout case is intentional coverage of the response-timeout path.
- Verification passed with the direct timing probes for `test/tools.test.ts` (`0.656s` before, `0.253s` after), `bun test test/tools.test.ts`, `bun run typecheck`, and full `bun test` (`2692 pass`, `3 skip`, `0 fail`).

## Remove Legacy WebSocket Test Coupling

- [x] Reproduce the current failing verification lane and confirm the remaining breakages come from tests still importing archived TUI or legacy transport surfaces rather than from active JSON-RPC behavior.
- [x] Replace stale legacy transport coverage with JSON-RPC-backed server and harness coverage, and reroute archived TUI helper tests onto leaf modules instead of restoring dead socket code.
- [x] Run targeted regression slices for the rewritten server/harness/TUI tests, then rerun `bun run typecheck` and full `bun test`.

## Remove Legacy WebSocket Test Coupling Review

- The stale legacy websocket-facing tests now either exercise supported JSON-RPC behavior (`test/server.toolstream.test.ts`, `test/helpers/wsHarness.ts`, and the added JSON-RPC agent/harness-context routes and schemas) or import archived TUI leaf helpers directly instead of pulling dead socket lifecycle modules back into scope.
- Desktop compatibility coverage stays on the active renderer contract: `apps/desktop/src/lib/wsProtocol.ts` once again parses the server events the desktop cache/store tests actually depend on, and `src/server/session/AgentSession.ts` now waits for queued persistence before clearing harness context on dispose so restart/resume tests stop racing shutdown.
- Verification passed with `bun test test/server.toolstream.test.ts`, `bun test test/tui.global-hotkeys.test.ts test/tui.sync-lifecycle.test.ts test/tui.log-filter.test.ts test/server.toolstream.test.ts test/harness.ws.e2e.test.ts`, `bun test test/tui.args.test.ts test/tui.question-prompt.test.ts apps/TUI/routes/session/question.test.ts test/jsonrpc.codegen.test.ts`, `bun test apps/TUI/context/local.test.ts apps/TUI/component/dialog-provider.test.ts`, `bun test test/harness.ws.e2e.test.ts apps/desktop/test/bootstrap-cache.test.ts apps/desktop/test/store-feed-mapping.test.ts`, `bun run docs:generate-jsonrpc`, `bun run docs:check`, `bun run typecheck`, and `bun test` on 2026-03-23 01:06:48 EDT (`2692 pass`, `3 skip`, `0 fail`).

## Fix Duplicate Final JSON-RPC Assistant Content

- [x] Inspect the latest duplicated live session in `~/.cowork/sessions.db` and confirm the duplicate comes from the final cumulative JSON-RPC `assistant_message` path rather than a replay-only issue.
- [x] Patch the live/journal JSON-RPC projectors so cumulative final assistant payloads are suppressed when streamed assistant history only differs by boundary whitespace, and ignore whitespace-only assistant segments.
- [x] Harden desktop transcript/replay assistant dedupe to use exact streamed assistant history rather than guessed paragraph joins, add focused regressions, and rerun the affected server/desktop verification slices plus `bun run typecheck`.

## Fix Duplicate Final JSON-RPC Assistant Content Review

- `src/server/jsonrpc/legacyEventProjector.ts` and `src/server/jsonrpc/journalProjector.ts` now drop whitespace-only assistant segments and suppress final cumulative assistant payloads when they only differ from streamed content by leading boundary whitespace, which stops the live duplicate-answer append after segmented streaming.
- `src/server/jsonrpc/threadReadProjector.ts` now drops older cumulative assistant duplicates during replay, so already-bad JSON-RPC journal rows no longer re-duplicate the same answer on reconnect when the only difference was boundary whitespace.
- `apps/desktop/src/app/store.feedMapping.ts` now dedupes merged `assistant_message` payloads against exact per-turn streamed assistant history instead of reconstructing the history from feed rows with synthetic paragraph separators, which keeps multi-step streamed answers and source cards from rendering twice.
- Added regressions in `test/jsonrpc.projectors.test.ts`, `test/jsonrpc.thread-read-projector.test.ts`, and `apps/desktop/test/store-feed-mapping.test.ts`.
- Verification passed with `bun test test/jsonrpc.projectors.test.ts test/jsonrpc.thread-read-projector.test.ts apps/desktop/test/store-feed-mapping.test.ts apps/desktop/test/protocol-v2-events.test.ts` and `bun run typecheck`.

## Fix Live JSON-RPC Follow-Up Activity Streaming

- [x] Confirm the refresh view is already correct and isolate the remaining defect to the desktop live JSON-RPC reducer rather than the replay/journal projector.
- [x] Patch the live reducer so reused raw `item/agentMessage/delta` ids are segmented into distinct assistant feed items whenever streamed reasoning or tool activity resumes within the same turn.
- [x] Add a focused live desktop regression for repeated raw assistant ids across reasoning/tool follow-up steps, then rerun the affected desktop verification slice plus `bun run typecheck`.

## Fix Live JSON-RPC Follow-Up Activity Streaming Review

- `apps/desktop/src/app/store.helpers/threadEventReducer.ts` now tracks occurrence-stable live assistant stream ids per raw JSON-RPC assistant item id, so follow-up turns no longer keep one assistant feed item open across multiple reasoning/tool phases.
- The live reducer now closes the current assistant segment when streamed reasoning starts/deltas or tool activity begins/completes, which makes the live feed match the already-correct post-refresh snapshot ordering for assistant -> reasoning/tool -> assistant follow-up steps.
- `apps/desktop/test/protocol-v2-events.test.ts` now asserts the interleaved follow-up sequence while the turn is still streaming and verifies that the final aggregate `item/completed` assistant payload does not append a duplicate answer.
- Verification passed with `bun test apps/desktop/test/protocol-v2-events.test.ts` and `bun run typecheck`.

## Fix Follow-Up JSON-RPC Assistant Segments

- [x] Inspect the latest affected session in `~/.cowork/sessions.db` and confirm the remaining live-only bug is caused by the server JSON-RPC projector collapsing multiple assistant segments in one turn onto a single `agentMessage` item.
- [x] Patch both JSON-RPC projector paths so assistant segments close before follow-up reasoning/tool phases and restart with a fresh assistant item when output resumes within the same turn.
- [x] Add focused regressions for reused assistant stream ids across interleaved reasoning in both live notification and journal projection paths, then rerun the affected projector, desktop JSON-RPC, thread-read, and typecheck verification slices.

## Fix Follow-Up JSON-RPC Assistant Segments Review

- `src/server/jsonrpc/legacyEventProjector.ts` and `src/server/jsonrpc/journalProjector.ts` no longer treat an entire turn as one long `agentMessage` item. Assistant text now closes before reasoning/tool follow-up phases and resumes on a fresh assistant item when output continues later in the same turn.
- The projector now preserves intra-turn ordering even when assistant output reuses the same underlying stream id or when the final legacy `assistant_message` event arrives with cumulative text for the whole turn.
- `test/jsonrpc.projectors.test.ts` now covers the exact failing shape: assistant output, reasoning, then more assistant output in the same turn with a reused stream id.
- Verification passed with `bun test test/jsonrpc.projectors.test.ts`, `bun test test/jsonrpc.thread-read-projector.test.ts`, `bun test apps/desktop/test/protocol-v2-events.test.ts`, and `bun run typecheck`.

## Fix Live JSON-RPC Interleaved Reasoning Order

- [x] Reproduce the streaming-only ordering bug where a turn emits multiple assistant segments with completed-only reasoning between them and confirm replay-on-reopen is already correct.
- [x] Patch the desktop shared JSON-RPC reducer so `item/agentMessage/delta` keeps the real item id, distinct assistant segments do not collapse onto one synthetic stream key, and completed-only reasoning only anchors ahead of an assistant item that is still streaming.
- [x] Add a focused desktop JSON-RPC regression for `assistant -> reasoning -> tool -> assistant` ordering and rerun the affected desktop verification slice.

## Fix Live JSON-RPC Interleaved Reasoning Order Review

- `apps/desktop/src/app/store.helpers/threadEventReducer.ts` now forwards the JSON-RPC `itemId` on `item/agentMessage/delta`, so multiple assistant items in one turn no longer share the same fallback `text:0` stream key while streaming.
- The same reducer now distinguishes completed-only reasoning that belongs ahead of an in-flight assistant item from reasoning that occurs after an already completed intermediate assistant message, preserving live interleaved `assistant -> reasoning -> tool -> assistant` ordering.
- `apps/desktop/src/app/store.feedMapping.ts` now tracks which assistant stream keys have already completed so the live reducer can anchor only against an actually in-flight assistant item.
- Verification passed with `bun test apps/desktop/test/protocol-v2-events.test.ts`.

## Fix JSON-RPC Replay For PI/OpenCode Providers

- [x] Inspect an affected `opencode-go` session in `~/.cowork/sessions.db` and compare the snapshot feed, JSON-RPC journal, and persisted raw stream data to isolate whether the remaining ordering bug is provider-specific or a shared replay issue.
- [x] Patch the shared JSON-RPC projector path so repeated stream/tool ids within one turn get distinct item ids and late aggregate reasoning from PI/OpenCode providers is dropped when it only repeats streamed reasoning.
- [x] Patch `thread/read` journal replay so older journals that reused reasoning/tool item ids are disambiguated on read and preserve chronological order.
- [x] Add focused regressions for repeated PI reasoning/tool ids plus late aggregate reasoning across the full PI-provider family, then rerun the JSON-RPC projector, thread-read, desktop JSON-RPC, runtime-selection, and typecheck verification slices.

## Fix JSON-RPC Replay For PI/OpenCode Providers Review

- `src/server/jsonrpc/legacyEventProjector.ts` and `src/server/jsonrpc/journalProjector.ts` now assign occurrence-stable item ids per turn/stream key for repeated reasoning and tool lifecycles, so PI/OpenCode providers can reuse `s0` or fallback tool ids across steps without collapsing later items onto the first occurrence.
- The same projector path now drops the late aggregate `reasoning` event emitted after PI/OpenCode turns when it only repeats the already-streamed reasoning text, preventing reasoning from appearing below the final assistant reply.
- `src/server/jsonrpc/threadReadProjector.ts` now disambiguates older repeated journal item ids on replay and drops late aggregate reasoning items that only repeat earlier streamed reasoning, so already-persisted PI/OpenCode journals preserve chronology without replaying the old reasoning-after-answer artifact.
- `test/jsonrpc.projectors.test.ts` and `test/runtime.selection.test.ts` now explicitly cover the full PI-provider set: `anthropic`, `baseten`, `together`, `nvidia`, `lmstudio`, `opencode-go`, and `opencode-zen`.
- Verification passed with `bun test test/jsonrpc.projectors.test.ts`, `bun test test/jsonrpc.thread-read-projector.test.ts`, `bun test test/runtime.selection.test.ts`, `bun test apps/desktop/test/protocol-v2-events.test.ts`, and `bun run typecheck`.

## Fix JSON-RPC Gemini Reasoning and Tool Projection

- [x] Inspect the affected Gemini session in `~/.cowork/sessions.db` and confirm whether the bad ordering/tool loss lives in the persisted session snapshot, the JSON-RPC journal, or the desktop renderer.
- [x] Patch the JSON-RPC live/journal projector path so raw Gemini search tool activity becomes `toolCall` items and aggregate final reasoning does not land after assistant output.
- [x] Patch the desktop shared-socket reducer so JSON-RPC `toolCall` notifications map back into the existing model-stream tool lifecycle with correct Gemini search arguments/results.
- [x] Add focused regressions for the live projector, journal replay, thread/read projection, and desktop JSON-RPC feed path, then rerun targeted verification plus `bun run typecheck`.

## Fix JSON-RPC Gemini Reasoning and Tool Projection Review

- `src/server/jsonrpc/legacyEventProjector.ts` and `src/server/jsonrpc/journalProjector.ts` now replay raw Gemini interaction events through the shared model-stream replay runtime, emit `toolCall` items for native Google web search, and suppress aggregate final reasoning when it only repeats streamed reasoning steps.
- `apps/desktop/src/app/store.helpers/threadEventReducer.ts` now treats JSON-RPC `item/started` tool notifications as metadata-only stream starts and synthesizes a proper `tool_call` from `item.args` before terminal result/error states, so Gemini native web search cards keep the correct input instead of polluted `{ id, toolName }` args.
- `test/jsonrpc.projectors.test.ts`, `test/jsonrpc.thread-read-projector.test.ts`, and `apps/desktop/test/protocol-v2-events.test.ts` now cover raw Gemini search projection, journal preservation of projected tool items, and the desktop JSON-RPC mapping for native web search plus late completed-only reasoning.
- Verification passed with `bun test test/jsonrpc.projectors.test.ts test/jsonrpc.thread-read-projector.test.ts`, `bun test apps/desktop/test/protocol-v2-events.test.ts`, and `bun run typecheck`.

## Fix Steer Replay Reasoning Ordering

- [x] Reproduce the persisted normalized streamed-turn shape from `~/.cowork/sessions.db` and confirm the bad ordering only happened because the late-reasoning replay guard was raw-backed only.
- [x] Update both the desktop transcript feed mapper and the server snapshot projector to dedupe aggregate final reasoning across streamed steps and anchor any remaining late final reasoning before the streamed assistant item.
- [x] Add focused regression coverage for the normalized streamed-turn case and rerun the affected desktop/server verification plus typecheck.

## Fix Steer Replay Reasoning Ordering Review

- `apps/desktop/src/app/store.feedMapping.ts` now keeps ordered streamed-reasoning history for the current turn, suppresses final reasoning that is just the aggregate of earlier streamed steps, and anchors any remaining late final reasoning before the streamed assistant item even on normalized-only turns.
- `src/server/session/SessionSnapshotProjector.ts` mirrors the same reasoning-history, aggregate-dedup, and late-reasoning anchoring rules so persisted snapshots match the live desktop feed.
- `apps/desktop/test/store-feed-mapping.test.ts` and `test/sessionSnapshotProjector.test.ts` now cover the exact multi-step normalized-turn shape that produced the duplicate reasoning-after-answer artifact in the SQLite session.
- Verification passed with `bun test apps/desktop/test/store-feed-mapping.test.ts`, `bun test test/sessionSnapshotProjector.test.ts`, `bun test apps/desktop/test/protocol-v2-events.test.ts`, and `bun run typecheck`.

## Stream Reasoning Before First Tool Call

- [x] Confirm the missing live reasoning was caused by JSON-RPC projector buffering rather than the desktop chat renderer.
- [x] Add a dedicated JSON-RPC `item/reasoning/delta` notification and stream reasoning start/delta/completed through the live and journal projectors.
- [x] Update JSON-RPC journal read/replay handling so reasoning deltas can rebuild reasoning items before completion.
- [x] Route desktop shared-socket reasoning notifications through the existing model-stream pipeline, with final completed-text reconciliation.
- [x] Regenerate the JSON-RPC schema artifacts and add regression coverage for the live server, journal replay, thread/read projection, and desktop feed mapping paths.

## Stream Reasoning Before First Tool Call Review

- `src/server/jsonrpc/legacyEventProjector.ts` and `src/server/jsonrpc/journalProjector.ts` now emit `item/started`, `item/reasoning/delta`, and `item/completed` for streamed reasoning with a stable reasoning item id, instead of collapsing the whole summary into one late completed item.
- `src/server/jsonrpc/threadReadProjector.ts` now rebuilds reasoning text from journal delta events, and the JSON-RPC schema/docs advertise the new notification method.
- `apps/desktop/src/app/store.helpers/threadEventReducer.ts` now converts JSON-RPC reasoning notifications into synthetic `model_stream_chunk` events so the desktop reuses the same incremental reasoning feed path as native model streaming, while still reconciling against the completed reasoning text.
- Verification passed with `bun test test/jsonrpc.projectors.test.ts test/jsonrpc.thread-read-projector.test.ts test/server.jsonrpc.flow.test.ts`, `bun test --cwd apps/desktop test/protocol-v2-events.test.ts test/chat-reasoning-ui.test.ts`, and `bun run typecheck`.

## Skill Update Missing-Name Regression

- [x] Confirm the current update path falls back to an unrelated valid candidate when the original skill name is absent.
- [x] Change update resolution so updates fail explicitly when the original installation name is missing from the source.
- [x] Align update preflight checks with the new failure mode so the UI does not advertise an invalid update.
- [x] Add regression tests for the missing-name update path.
- [x] Run focused verification for skill update operations.

## Review

- `src/skills/operations.ts` now requires a valid same-name candidate for updates and returns a clear reason when the recorded installation name is missing or invalid in the source.
- `test/skills.operations.test.ts` covers both the preflight update check and the rejected mutation path for missing original names.
- Verification passed with `bun test test/skills.operations.test.ts` and `bun run typecheck`.

## CI Fix: Skill Detail Dialog Ubuntu Flake

- [x] Inspect the failing GitHub Actions `Docs + Tests` job and confirm the only actionable failure is `skill detail dialog > reveals the installation folder for non-workspace skills`.
- [x] Compare the CI environment with the local workspace and confirm the mismatch is `ubuntu-latest` in GitHub Actions versus local macOS arm64.
- [x] Reproduce the focused test and desktop test suite locally to confirm the branch logic is already correct and the failure is test-environment sensitive.
- [x] Harden `apps/desktop/test/skill-detail-dialog.test.ts` so it only exercises the open-folder wiring and does not depend on unrelated desktop/runtime UI modules in the full suite.
- [x] Remove the unnecessary `SkillDetailDialog` module mock from `apps/desktop/test/skills-catalog-page.test.ts` so Ubuntu cannot inherit a null dialog implementation across test files.
- [x] Run CI-shaped verification for the fix and record the results.

## CI Fix Review

- `apps/desktop/test/skill-detail-dialog.test.ts` now keeps the installation selected but sets `selectedSkillContent` to `null`, so the test still validates the `Open folder` click path without invoking markdown rendering or other UI surfaces that are irrelevant to the assertion.
- `apps/desktop/test/skills-catalog-page.test.ts` no longer mocks `SkillDetailDialog`, because the dialog is already closed in those page tests and the file-level mock can leak into the adjacent dialog test on Bun/Linux.
- Focused stress verification passed with `bun test apps/desktop/test/skill-detail-dialog.test.ts --rerun-each 25`.
- Regression guard verification passed with `bun test apps/desktop/test/skill-detail-dialog.test.ts apps/desktop/test/message-links.test.ts apps/desktop/test/updates-page.test.ts`.
- CI-shaped verification passed with `RUN_REMOTE_MCP_TESTS=1 bun test` showing `2763 pass`, `1 skip`, `0 fail`.

## Desktop App Platform-Specific Isolation

- [x] Audit all Electron desktop platform branches across window chrome, updater, menus/dialogs, server startup, and renderer chrome styling.
- [x] Extract platform-specific window and server lifecycle behavior behind explicit helpers/modules so macOS, Windows, and Linux tweaks stay isolated.
- [x] Keep the desktop app’s overall design and behavior intact while making Linux/native-frame behavior intentional instead of implicit.
- [x] Add or update focused desktop tests that lock down platform-specific behavior for each extracted branch.
- [x] Run focused desktop verification plus desktop typecheck/manual validation and capture the results.

## Desktop App Platform-Specific Isolation Review

- `apps/desktop/electron/services/windowChrome/` now owns per-platform BrowserWindow options, post-create tweaks, and runtime chrome syncing so macOS and Windows no longer share those branches in one file.
- `apps/desktop/electron/services/serverPlatform.ts` and `apps/desktop/electron/services/updaterPlatform.ts` isolate Windows-only Bun startup workarounds and macOS-only updater defaults away from the shared service implementations.
- `apps/desktop/electron/services/dialogs.ts` and `apps/desktop/electron/services/menuTemplate.ts` now route through explicit platform-specific builders instead of ad hoc conditional blocks.
- Focused verification passed with `bun test apps/desktop/test/dialogs.test.ts apps/desktop/test/menu.test.ts apps/desktop/test/server-manager.test.ts apps/desktop/test/updater-service.test.ts apps/desktop/test/window-enhancements.test.ts` and `bun run typecheck`.
- Manual Linux smoke validation passed with the running `bun run desktop:dev` session, confirming the desktop window keeps its native frame/menu integration and that the File menu remains interactive.

## Fix Broken Linux UI

- [x] Reproduce the blank Linux desktop UI and collect renderer/main-process evidence.
- [x] Identify the root cause of the Linux renderer failure without regressing macOS/Windows behavior.
- [x] Implement the minimal fix and add/update focused regression coverage.
- [x] Re-run focused desktop verification plus a Linux manual smoke walkthrough with artifacts.

## Fix Broken Linux UI Review

- The blank Linux renderer was caused by dev-only React Grab initialization in Electron on Linux, not by the earlier platform-chrome refactor.
- `apps/desktop/src/lib/reactGrabDevTools.ts` now skips React Grab only for Linux Electron development while leaving other development environments unchanged.
- `apps/desktop/test/react-grab-dev-tools.test.ts` covers the new Linux Electron skip path and the helper predicate directly.
- Verification passed with `bun test apps/desktop/test/react-grab-dev-tools.test.ts`, `bun run typecheck`, and a manual Linux Electron smoke run showing the populated desktop UI plus a responsive composer.

## Fix Live OpenAI Reasoning Handshake

- [x] Suppress commentary-only assistant `text_delta` chunks in the JSON-RPC live projectors.
- [x] Emit completed reasoning items from `reasoning_start` / `reasoning_delta` / `reasoning_end` live chunks so desktop thought bubbles match replay.
- [x] Prevent delayed `thread/read` hydration from overwriting fresher live feed items or the optimistic first user bubble.
- [x] Refresh `controlSocket.ts` lifecycle callbacks to dereference the latest store helpers.
- [x] Add focused regressions and run the desktop JSON-RPC verification slice plus `bun run typecheck`.

## Fix Live OpenAI Reasoning Handshake Review

- `src/server/jsonrpc/legacyEventProjector.ts` and `src/server/jsonrpc/journalProjector.ts` now drop commentary-phase `text_delta` chunks from the live assistant-message path, accumulate `reasoning_*` stream parts into one completed reasoning item, and suppress duplicate legacy reasoning finals when they match the just-emitted streamed summary.
- `apps/desktop/src/app/store.helpers/threadEventReducer.ts` now preserves the current live feed when a delayed `thread/read` snapshot would erase the optimistic first user bubble or when an actively running thread receives a snapshot that is behind the live event sequence; metadata still updates without letting counts/sequences move backward.
- `apps/desktop/src/app/store.helpers/controlSocket.ts` now re-reads the latest store getter and setter inside JSON-RPC lifecycle callbacks, so reconnect bootstrap uses the current workspace state instead of the first captured store instance.
- Focused projector coverage passed with `bun test test/jsonrpc.projectors.test.ts`.
- Desktop JSON-RPC parity and reconnect coverage passed with `bun test --cwd apps/desktop test/store-feed-mapping.test.ts test/protocol-v2-events.test.ts test/chat-reasoning-ui.test.ts test/control-socket.test.ts test/jsonrpc-single-connection.test.ts test/thread-reconnect.test.ts`.
- Typecheck passed with `bun run typecheck`.

## PR Comment Cleanup

- [x] Fix the unresolved workspace-defaults persistence review thread in `apps/desktop/src/app/store.actions/workspaceDefaults.ts`.
- [x] Re-verify the workspace-defaults desktop tests and typecheck after the review fix.
- [x] Resolve the actionable PR thread and close the stale unused-exports thread with evidence instead of code churn.

## PR Comment Cleanup Review

- `apps/desktop/src/app/store.actions/workspaceDefaults.ts` now narrows `buildApplySessionDefaultsMessage()` to the exact `apply_session_defaults` client message shape and removes the redundant runtime discriminator before `requestJsonRpcControlEvent()`, so the control path cannot silently skip persistence if that builder evolves later.
- Verification passed with `bun test --cwd apps/desktop test/workspace-settings-sync.test.ts` and `bun run typecheck`.
- Resolved PR thread `PRRT_kwDORLLhvs518ZN3` with the fix in commit `420c3969`, and closed stale thread `PRRT_kwDORLLhvs518ZN4` after revalidating the current `threadEventReducer.ts` call sites via `rg`.

## Reconnect Review Fixes

- [x] Preserve queued retryable JSON-RPC requests across transient reconnect handshake failures without regressing reconnect exhaustion handling.
- [x] Apply JSON-RPC notification opt-out filters to replayed journal events during `thread/resume`.
- [x] Re-run targeted reconnect/runtime verification and typecheck, then resolve the matching PR threads.

## Reconnect Review Fixes Review

- `src/client/jsonRpcSocket.ts` now keeps retryable queued operations intact across transient `initialize` handshake failures while the socket is still auto-reconnecting, but still rejects them once reconnect attempts are exhausted or the socket is intentionally closed.
- `src/server/startServer.ts` now applies `shouldSendJsonRpcNotification()` during journal replay, so `thread/resume` respects the same notification opt-out contract as live streaming.
- Verification passed with `bun test test/jsonrpcSocket.runtime.test.ts test/server.jsonrpc.flow.test.ts` and `bun run typecheck`.

## Provider Refresh Review Fixes

- [x] Fix the remaining provider refresh generation race in the desktop control socket without widening the protocol surface.
- [x] Add regressions for older `provider_status` events and bootstrap completion racing with a newer manual refresh.
- [x] Re-run the focused desktop provider/control tests plus `bun run typecheck`, then resolve the remaining PR threads.

## Provider Refresh Review Fixes Review

- `apps/desktop/src/app/store.helpers/controlSocket.ts` now puts bootstrap refreshes on the same `providerStatusRefreshGeneration` contract as manual and auth-triggered refreshes, and it no longer lets `provider_status` or generic control error events clear `providerStatusRefreshing` outside that generation-aware completion path.
- `apps/desktop/test/control-socket.test.ts` now covers both races: an older `provider_status` event arriving while a newer manual refresh is still running, and bootstrap completion arriving after a newer manual refresh has already taken ownership of the spinner.
- Verification passed with `bun test --cwd apps/desktop test/control-socket.test.ts test/provider-actions.test.ts` and `bun run typecheck`.

## Turn Request Review Fixes

- [x] Make JSON-RPC `turn/start` wait for real session acceptance or rejection before replying.
- [x] Make JSON-RPC `turn/steer` wait for `steer_accepted` or a session error before replying.
- [x] Add server-flow regressions for accepted `turn/start`, busy `turn/start`, accepted `turn/steer`, and rejected `turn/steer`, then rerun the affected desktop/server slices plus `bun run typecheck`.

## Turn Request Review Fixes Review

- `src/server/startServer.ts` now routes JSON-RPC `turn/start` and `turn/steer` through the existing session-event capture helper so request responses reflect the first real session outcome instead of fire-and-forget guesses. `turn/start` only returns success after `session_busy: true` yields a concrete `turnId`, and `turn/steer` only returns success after `steer_accepted`; session-level rejections now become JSON-RPC errors.
- `test/server.jsonrpc.flow.test.ts` now asserts that accepted `turn/start` responses already carry the concrete `turn.id` with `inProgress` status, and it adds request-level regressions for busy `turn/start`, accepted `turn/steer`, and stale-turn `turn/steer`.
- Verification passed with `bun test test/server.jsonrpc.flow.test.ts`, `bun test --cwd apps/desktop test/jsonrpc-single-connection.test.ts`, and `bun run typecheck`.

## Socket Close Review Fix

- [x] Guard shared JSON-RPC socket lifecycle callbacks so stale sockets cannot clear active workspace control state after a server URL swap.
- [x] Add a regression for a deferred old-socket close arriving after the replacement socket has already opened.
- [x] Re-run the focused desktop socket lifecycle tests plus `bun run typecheck`, then resolve the remaining PR thread.

## Socket Close Review Fix Review

- `apps/desktop/src/app/store.helpers/jsonRpcSocket.ts` now checks that a lifecycle callback belongs to the current `RUNTIME.jsonRpcSockets` entry before syncing workspace open/close state, so a stale socket cannot null out `controlSessionId` or trigger workspace control cleanup after a replacement socket has already taken over.
- `apps/desktop/test/control-socket.test.ts` now simulates a deferred close on the old socket after a `serverUrl` change and asserts that the active replacement socket keeps its control session state.
- Verification passed with `bun test --cwd apps/desktop test/control-socket.test.ts test/thread-reconnect.test.ts` and `bun run typecheck`.

## Final PR Review Sweep

- [x] Revalidate the remaining unresolved JSON-RPC server subprotocol thread on current `HEAD` before changing transport code.
- [x] Re-run the focused server JSON-RPC transport tests, desktop shared-socket tests, and `bun run typecheck` before resolving the last review threads.

## Final PR Review Sweep Review

- `src/server/startServer.ts` already returns the negotiated `Sec-WebSocket-Protocol` value from the WebSocket upgrade path, and current `HEAD` preserves that on the wire for both browser-style and multi-offer `ws` clients.
- Revalidated transport coverage passed with `bun test test/server.jsonrpc.test.ts` and `bun test test/server.jsonrpc.flow.test.ts`.
- Revalidated desktop/socket coverage passed with `bun test --cwd apps/desktop test/control-socket.test.ts test/thread-reconnect.test.ts`.
- Typecheck passed with `bun run typecheck`.

## Harden Workspace JSON-RPC Socket Replacement

- [x] Add monotonic per-workspace JSON-RPC socket generation bookkeeping in desktop runtime state.
- [x] Gate shared workspace socket lifecycle and JSON-RPC routing callbacks on the active workspace generation instead of socket map entry identity.
- [x] Bump socket generation before retiring a workspace control socket for URL swaps and other explicit workspace-socket retirement paths.
- [x] Extend desktop regressions for stale retired-socket close, stale thread disconnect, and stale notification/request routing.
- [x] Run the requested focused desktop verification slice and capture the result.

## Harden Workspace JSON-RPC Socket Replacement Review

- `apps/desktop/src/app/store.helpers/runtimeState.ts` now tracks a monotonic active JSON-RPC socket generation per workspace, alongside helpers that mirror the repo’s existing generation-based stale-result guards.
- `apps/desktop/src/app/store.helpers/jsonRpcSocket.ts` now stamps each shared workspace socket with its generation, gates `onOpen`, `onClose`, `onNotification`, and `onServerRequest` on the active generation, and bumps generation before retiring a URL-swapped socket instead of depending on `RUNTIME.jsonRpcSockets.get(workspaceId) === socket`.
- `apps/desktop/src/app/store.actions/workspace.ts` now also bumps socket generation before restart/remove retirement so a late close from the old active socket cannot disconnect threads or clear control state after explicit workspace socket teardown.
- `apps/desktop/test/control-socket.test.ts`, `apps/desktop/test/thread-reconnect.test.ts`, and `apps/desktop/test/protocol-v2-events.test.ts` now lock down stale retired-socket close, stale disconnect, and stale notification/server-request routing behavior while confirming the replacement socket still handles live events normally.
- Verification passed with `bun test apps/desktop/test/control-socket.test.ts apps/desktop/test/thread-reconnect.test.ts apps/desktop/test/protocol-v2-events.test.ts`.

## JSON-RPC Review Thread Fixes

- [x] Correlate MCP validation and MCP auth responses by server name in both the extracted JSON-RPC route handlers and the legacy `startServer.ts` switch.
- [x] Correlate `cowork/skills/read` results by requested skill name and stop skill enable/disable/delete from reporting success after a rejected mutation.
- [x] Return emitted provider, skill-installation, memory, and workspace-backup error events as JSON-RPC errors instead of waiting for the 5-second capture timeout.
- [x] Add focused extracted-route and live-server regressions for the review-thread cases, then rerun the affected tests plus `bun run typecheck`.

## JSON-RPC Review Thread Fixes Review

- `src/server/jsonrpc/routes/providerAndMcp.ts`, `src/server/jsonrpc/routes/skillsMemoryAndWorkspaceBackup.ts`, and `src/server/startServer.ts` now correlate MCP validation/auth and skill-read captures to the requested server or skill, so concurrent control calls cannot cross-resolve on the first matching event.
- The same handlers now treat emitted `error` events as terminal JSON-RPC outcomes across provider auth, skill mutations, skill-installation update checks, memory controls, and workspace backup controls, instead of waiting for a timeout when the session already reported a concrete failure.
- `test/jsonrpc.routes.review-fixes.test.ts` adds extracted-route regressions for the review fixes, including realistic provider- and backup-sourced error events plus installation-check failures, and `test/server.jsonrpc.control.test.ts` covers the live server behavior for provider auth, skill mutation failures, installation-check failures, memory failures, and workspace backup failures.
- Verification passed with `bun test test/jsonrpc.routes.review-fixes.test.ts`, `bun test test/server.jsonrpc.control.test.ts`, and `bun run typecheck`.

## Full Test Lane Cleanup

- [x] Reproduce the 7 `bun run test` failures in focused server and desktop slices before changing code.
- [x] Port the extracted JSON-RPC pending-prompt replay logic into the live `startServer.ts` thread resume/read path and remove the journal-write bottleneck that kept the >1000-event read test over the timeout budget.
- [x] Restore chronological mixed reasoning/tool activity grouping in the desktop chat summary helpers without regressing adjacent tool merge behavior.
- [x] Re-run the focused failing slices, `bun run typecheck`, and the full `bun run test` lane.

## Full Test Lane Cleanup Review

- `src/server/startServer.ts` now replays pending ask/approval prompts on `thread/resume`, dedupes them against journal replay and disconnected-buffer replay, batches thread-journal SQLite writes with `appendThreadJournalEvents()`, and compacts consecutive assistant snapshot fragments in `thread/read` responses so the heavy reconnect/read flow no longer times out on large journals.
- `src/server/session/AgentSession.ts`, `src/server/session/SessionSnapshotProjector.ts`, and `src/server/jsonrpc/routes/shared.ts` now expose a non-cloning live snapshot read path for JSON-RPC/session summary callers, avoiding redundant deep copies of large live snapshots during server reads.
- `apps/desktop/src/ui/chat/activityGroups.ts` now preserves feed chronology when mixing reasoning and tool entries, while still deduping adjacent identical reasoning notes and merging only truly adjacent compatible tool lifecycle rows.
- Verification passed with `bun test test/server.jsonrpc.flow.test.ts --test-name-pattern "thread/resume replays a pending user input request after reconnect|thread/resume replays a pending approval request after reconnect|thread/read and thread/resume replay journals beyond 1000 events"`, `bun test apps/desktop/test/chat-activity-group-card.test.tsx apps/desktop/test/chat-activity-groups.test.ts`, `bun run typecheck`, and `bun run test`.

## Final Comment Cleanup

- [x] Apply JSON-RPC response-envelope thread state to `applyWorkspaceDefaultsToThread` without routing thread results through the workspace control reducer.
- [x] Return emitted skill-installation read and mutation errors immediately in both the legacy JSON-RPC switch and the extracted route handlers.
- [x] Add focused desktop and server regressions, then re-run typecheck and the full Bun test lane before resolving the remaining review threads.

## Final Comment Cleanup Review

- `apps/desktop/src/app/store.actions/workspaceDefaults.ts` now normalizes JSON-RPC `event`/`events` payloads for thread-scoped defaults application and applies thread runtime `config`, `sessionConfig`, and `enableMcp` state directly from the response envelope, while still preserving the old generic transport-failure notification for socket/request errors.
- `src/server/startServer.ts` and `src/server/jsonrpc/routes/skillsMemoryAndWorkspaceBackup.ts` now treat emitted validation errors from `cowork/skills/installation/read` and `cowork/skills/installation/{enable,disable,delete,update}` as terminal JSON-RPC errors instead of waiting for the capture timeout.
- `apps/desktop/test/workspace-settings-sync.test.ts`, `test/jsonrpc.routes.review-fixes.test.ts`, and `test/server.jsonrpc.control.test.ts` now lock down the thread-response envelope state path plus the skill-installation error returns in both extracted-route and live-server coverage.
- Verification passed with `bun test apps/desktop/test/workspace-settings-sync.test.ts`, `bun test test/jsonrpc.routes.review-fixes.test.ts`, `bun test test/server.jsonrpc.control.test.ts`, `bun run typecheck`, and `bun run test`.

## Skills Detail Loading Regression

- [x] Reproduce the real desktop regression where clicking a skill no longer loads the detail data/background content.
- [x] Fix the skills store action sequencing so detail dialogs enter loading state before the request and retain the JSON-RPC-loaded installation/content after success.
- [x] Add focused regressions for both `selectSkill` and `selectSkillInstallation`.
- [x] Re-run focused desktop tests, repo typecheck, full `bun test`, and manual desktop validation.

## Skills Detail Loading Regression Review

- `apps/desktop/src/app/store.actions/skills.ts` no longer clears `selectedSkillContent` or `selectedSkillInstallation` after the JSON-RPC read succeeds. Instead, `selectSkillInstallation` now sets the selected installation id and loading state before issuing `cowork/skills/installation/read`, so the dialog opens immediately and then preserves the returned installation metadata and markdown content once the control event lands.
- `apps/desktop/test/skills-actions.test.ts` now covers the regression directly: `selectSkill` retains the loaded markdown content after `cowork/skills/read`, and `selectSkillInstallation` enters a loading state before the request and keeps the returned installation + content after success.
- Manual desktop validation passed in the running Electron app: clicking built-in skills opened the detail dialog and loaded the full documentation body again instead of staying stuck on loading.
- Verification passed with `bun test apps/desktop/test/skills-actions.test.ts apps/desktop/test/skills-catalog-page.test.ts apps/desktop/test/skill-detail-dialog.test.ts`, `bun run typecheck`, `bun test`, and a manual Electron desktop walkthrough.

## CI Fix: Desktop Release Validate lane

- [x] Inspect the linked GitHub Actions Desktop Release run and identify the failing test from the `Validate` job logs.
- [x] Reproduce or otherwise confirm the failure path locally against the same `HEAD` commit.
- [x] Remove the leaking desktop test mock that nulls out `SkillDetailDialog` across adjacent Bun/Linux test files.
- [x] Re-run the affected desktop regression slice, repo typecheck, and the full `bun test` lane.

## CI Fix Review

- GitHub Actions run `23473727870` failed in `Desktop Release -> Validate -> Unit tests`, not in packaging. The first actionable failure was `apps/desktop/test/skill-detail-dialog.test.ts`, where the dialog rendered as `null` and the `Open folder` button never appeared.
- The root cause was a file-level `mock.module("../src/ui/skills/SkillDetailDialog", ...)` in `apps/desktop/test/skills-catalog-page.test.ts`. On Bun/Linux CI that mock can leak into the adjacent skill dialog test file, causing `SkillDetailDialog` to stay mocked as `null`.
- `apps/desktop/test/skills-catalog-page.test.ts` no longer mocks `SkillDetailDialog`. Those catalog-page tests only assert loading and empty states while the dialog remains closed, so the extra mock was unnecessary and destabilized CI.
- Verification passed with `bun test apps/desktop/test/skills-catalog-page.test.ts apps/desktop/test/skill-detail-dialog.test.ts --rerun-each 25`, `bun test apps/desktop/test/skill-detail-dialog.test.ts apps/desktop/test/protocol-v2-events.test.ts apps/desktop/test/thread-reconnect.test.ts apps/desktop/test/jsonrpc-single-connection.test.ts apps/desktop/test/bootstrap-cache.test.ts`, `bun run typecheck`, and `bun test`.
