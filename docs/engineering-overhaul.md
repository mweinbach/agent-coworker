# Engineering overhaul

Decision and verification record for the September 2026 whole-app review.
The work repairs unreliable behavior without replacing sound foundations.
It is **not an overall code-size or complexity reduction**. Implemented
decisions, measured outcomes and limits are backed by the
[completed verification below](#final-verification).

## Baseline and scope

- Base: `6564e4e5f4d6b11ef7dc19b27fc7bbab9c39cbfa`.
- Branch: `codex/reliability-overhaul`, developed in an isolated worktree rather
  than modifying the user's original `feat/workflows` checkout.
- Baseline: **8,489 tests passed across all 719 files** through the project runner;
  27 platform/live-integration cases were skipped. Root,
  harness, desktop and mobile typechecks, Biome and docs checks were green.
- Coverage includes the harness, provider/runtime adapters, protocol/storage,
  tools/platform, integrations, tasks/workflows, desktop/web/CLI/mobile clients,
  native adapters, build/CI, configuration, prompts, skills, docs and tests.
- The review is at subsystem and authority-boundary level. Vendored native
  internals and copied developer-helper catalogs were structurally mapped, not
  line-by-line security-certified. Passing fixtures do not establish live
  interoperability with every provider, keychain, operating system or device.

The first green suite did not cover the races subsequently reproduced. Fixes
extended existing behavioral tests with controlled interleavings, real temporary
files/databases, fault injection, and native/renderer fixtures. Global percentage
coverage was not measured; additional regression cases are not presented as a
statement-coverage percentage.

## Architecture decisions

**Keep the WebSocket-first architecture.** The harness owns business operations,
permissions, durable state, model execution and typed contracts. Electron, web,
mobile and CLI remain clients. Keep SQLite/WAL, isolated auth homes, opt-in
backups, native sandbox boundaries and distinct provider runtimes. Their
different transports and continuation semantics are real constraints, not
duplicate implementations to erase.

**Rewrite broken lifetime and mutation paths.** Accepted work needs one owner,
bounded waits and an honest result. An old operation cannot cancel, overwrite
or acknowledge its successor. Lock the complete read/modify/write transaction;
preserve prior data if staging, persistence or rollback fails. Incomplete model
output must not execute unfinished tools.

**Delete only proved-dead or misleading machinery.** Removed examples include
the unused parallel journal queue, dormant platform lock/shutdown scaffolding,
test-only client replay shim, unused CLI render helpers, unsupported advertised
handoff tools, guessed presentation caches/workspace-code execution, fabricated
DOCX roles and fake mobile transcript entries. Public compatibility, security
checks and supported features were not removed merely to lower a metric.

## Piece-by-piece decisions

The 80 rows below record implemented dispositions, not a future rewrite list.
**KEEP** means the existing responsibility/foundation was retained;
**REWRITE** refers to the specified path, not wholesale replacement of the module;
**DELETE** names removed behavior or dead code. Links are representative source
and regression entrypoints, not a claim that one test covers an entire subsystem.
The final verification distinguishes deterministic regressions, rendered fixtures
and actual application checks; they establish different kinds of evidence.

### Harness, providers, execution and context

| # | Piece / implementation | Decision and completed outcome | Representative regression |
| --- | --- | --- | --- |
| 01 | [Harness and public entrypoints](../src/agent.ts) | **KEEP** the WebSocket-first harness, typed public surfaces and provider-neutral turn boundary. Business operations remain in the server; clients do not acquire a second execution path. | [Tests](../test/agent.test.ts) |
| 02 | [Configuration, migration and canonical homes](../src/config.ts) | **KEEP** built-in/user/project layering and one auth home; **REWRITE** home override consistency and observability authority. Project files cannot redirect inherited telemetry credentials or expand consent; explicit user/env opt-ins remain supported. | [Tests](../test/config/config.loadConfig.test.ts) |
| 03 | [Provider runtimes](../src/runtime/index.ts) and [static catalog](../src/providers/catalog.ts) | **KEEP** provider-specific runtimes, platform restrictions, aliases, and static defaults. **DELETE** the test-only model façade, factory wrappers, and adapter-only metadata; retain shared credential resolution. No speculative model, price, dependency, or vendor refresh. | [Tests](../test/providers/) |
| 04 | [Discovery, cache and status](../src/providers/connectionCatalog.ts) | **REWRITE** discovery ownership: bounded requests, independent parallel probes, endpoint/auth-scoped caches, one final assembly path, and consistent env-key status. Prompt composition uses an explicitly cache-only, configured/unverified snapshot. | [Tests](../test/providers/connection-catalog.test.ts) |
| 05 | [LM Studio and Bedrock discovery lifetime](../src/providers/lmstudio/client.ts) | **KEEP** local startup and provider mapping; **REWRITE** complete request lifetime. LM list/load bodies are bounded; Bedrock requests abort and release SDK clients; authoritative empty lists and current endpoint identity are honored. | [Tests](../test/providers/lmstudio.test.ts); [related](../test/providers/bedrock-shared.test.ts) |
| 06 | [Codex login, pool and managed installation](../src/providers/codexAppServerAuth.ts) | **KEEP** checksums, overrides, companions and pooling; **REWRITE** login/browser settlement, credential-change invalidation, locked promotion, and abortable model pagination. Cancellation does not destroy a shared client. | [Tests](../test/providers/codex-app-server-auth.test.ts); [related](../test/providers/codex-app-server-resolver.test.ts) |
| 07 | [Provider/tool credential mutation](../src/store/connections.ts) | **KEEP** formats and server-side field validation; **REWRITE** every credential mutation as one locked read/modify/atomic-write operation. Concurrent processes preserve unrelated provider and tool keys. | [Tests](../test/connect.test.ts) |
| 08 | [Model metadata, routing and preferences](../src/models/metadata.ts) | **KEEP** canonical registry/routing and custom-model support; **REWRITE** per-row recovery and reasoning validation against advertised capabilities. **DELETE** two unused descriptors. Do not reject real newer efforts merely because static metadata is older. | [Tests](../test/models.customModelResolution.test.ts) |
| 09 | [Agent startup and MCP resource ownership](../src/agent.ts) | **KEEP** canonical role/tool restrictions and parallel startup; **REWRITE** resource ownership before throwing setup work and bounded abort-aware cleanup. Late failures remain observed. | [Tests](../test/agent.startup-reliability.test.ts) |
| 10 | [PI loop, message bridge and overflow](../src/runtime/pi/runTurn.ts) | **KEEP** the common loop, provider options, scoped NVIDIA patch, retry policy and secure overflow handling; **REWRITE** failed-step text/usage retention and rich audio/video/document replay. | [Tests](../test/runtime.pi-runtime.test.ts); [related](../test/runtime.pi-message-bridge.test.ts) |
| 11 | [Native OpenAI and Google runtimes](../src/runtime/googleInteractionsRuntime.ts) | **KEEP** request/conversion/stream separation; **REWRITE** terminal validation and replay recovery, preserving executed tool results and invalidating failed continuation. **DELETE** unused OpenAI helpers and empty migrated-test shims, retaining real split coverage. | [Tests](../test/runtime.openai-responses-runtime.test.ts); [related](../test/runtime/google-native/runtime.errors.test.ts) |
| 12 | [Codex pooled turn runtime](../src/runtime/codexAppServer/) | **KEEP** protocol-specific runtime; **REWRITE** pre-ack turn correlation and request-owned raw logging, scoped-reader admission, and structured tool failure handling. Another pooled turn cannot complete or contaminate this turn. | [Tests](../test/runtime/codex-app-server/turn.test.ts) |
| 13 | [Antigravity runtime](../src/runtime/antigravityRuntime.ts) | **REWRITE** full-history/media input, instance/startup/stream lifetime, cancellation and late callback ownership. **DELETE** asynchronous global-env mutation and duplicate tool execution; reuse the canonical executor. | [Tests](../test/runtime.antigravity.test.ts) |
| 14 | [Bedrock runtime and reasoning replay](../src/runtime/bedrockProviderModule.ts) | **KEEP** AWS integration; **REWRITE** successful-terminal requirements, client/handler/proxy cleanup, opaque reasoning replay, and conservative unknown-model metadata. No unrelated model rates are borrowed. | [Tests](../test/runtime.bedrock-provider-module.test.ts) |
| 15 | [Prompts, project instructions and task context](../src/prompt.ts) | **KEEP** interpolation, role/profile policy and model-specific templates; **REWRITE** actionable task/review context, bounded instruction reads, containment and actual schema guidance. **DELETE** blanket custom-policy scrubbing and dead hot-cache loading. | [Tests](../test/prompt.test.ts); [related](../test/projectInstructions.test.ts) |
| 16 | [Usage, pricing and lifetime budgets](../src/session/costTracker.ts) | **KEEP** validated totals/budget contracts; **REWRITE** lifetime unknown-cost restoration and per-request tiered pricing. **DELETE** unused terminal formatters/listener helpers. Aggregate-only providers remain honestly unknown where needed. | [Tests](../test/session.costTracker.test.ts) |
| 17 | [Shared client and CLI](../src/client/jsonRpcSocket.ts) | **KEEP** canonical socket/parser/stream formatting and REPL; **REWRITE** socket-generation readiness, reconnect target ownership and prompt cleanup. **DELETE** test-only replay shim and unused CLI render helpers after reference checks. | [Tests](../test/jsonrpcSocket.reliability.test.ts); [related](../test/repl.test.ts) |

### Server, durable state and artifacts

| # | Piece / implementation | Decision and completed outcome | Representative regression |
| --- | --- | --- | --- |
| 18 | [Server composition, startup and shutdown](../src/server/startServer.ts) | **KEEP** process boundary, auth checks, subscription ownership and bounded shutdown; **REWRITE** failed-bind cleanup, joined teardown and recursive live-session settlement before durable deletion. | [Tests](../test/server.test.ts) |
| 19 | [WebSocket backpressure and HTTP request identity](../src/server/runtime/SocketSendQueue.ts) | **REWRITE** accepted-buffer accounting and request/waiter identity; **KEEP** HTTP/SSE compatibility. Bun `send() === -1` means accepted, not a frame to resend. | [Tests](../test/server.backpressure.test.ts) |
| 20 | [Typed JSON-RPC and admission receipts](../src/server/jsonrpc/) | **KEEP** typed validation and idempotent retries; **REWRITE** own-property dispatch, request-specific turn admission and mutation-completion replies. **DELETE** false success inferred from unrelated events. | [Tests](../test/jsonrpc.turn-start-admission.test.ts) |
| 21 | [Session provider/MCP/extension managers](../src/server/session/ProviderAuthManager.ts) | **KEEP** manager responsibilities and lazy imports; **REWRITE** refresh/challenge ownership, active-provider continuation invalidation and aggregate-default publication. Reconciled options persist without intermediate partial snapshots. | [Tests](../test/session/agentSession.provider.test.ts); [related](../test/session/agentSession.model.test.ts) |
| 22 | [Turn execution, interaction and administration](../src/server/session/TurnExecutionManager.ts) | **KEEP** provider-independent turns; **REWRITE** pre-await reservation, cancellation barriers, attachment budgets and exclusive uploads. Private observed completion evidence retains safe pre-cancellation work without accepting late provider payloads. | [Tests](../test/session/agentSession.messaging.test.ts); [related](../test/session/agentSession.errors.test.ts) |
| 23 | [Checkpoint and history boundaries](../src/server/session/PersistenceManager.ts) | **KEEP** full durable history and serialized retries; **REWRITE** per-reason checkpoint revisions, paired synchronous capture and tool-pair-safe runtime history trimming. Same-named updates no longer erase successors. | [Tests](../test/server/persistenceManager.test.ts) |
| 24 | [SQLite ownership, recovery and task summaries](../src/server/sessionDb/) | **KEEP** SQLite/WAL, committed readers, migrations and normalizers; **REWRITE** atomic recursive cleanup, live-writer preservation, nondestructive quarantine and direct task-summary SQL. | [Tests](../test/session-db.test.ts); [related](../test/task-mode.persistence.test.ts) |
| 25 | [File snapshots and hydration compatibility](../src/server/sessionStore/) | **KEEP** private atomic snapshots and V1–V7 compatibility, current auth-home migration and bounded disconnected replay. Do not erase old readable data to simplify adapters. | [Tests](../test/sessionSnapshotBuilder.test.ts) |
| 26 | [Projection identity and journal workers](../src/server/runtime/ThreadJournal.ts) | **KEEP** one canonical engine; **REWRITE** occurrence identity, seed ownership and one draining worker per journal. **DELETE** name-only/prefix dedupe and the unused parallel journal queue. | [Tests](../test/threadJournal.runtime.test.ts); [related](../test/jsonrpc/projectors/resume-seed.test.ts) |
| 27 | [Transcript inbox and reliable batch delivery](../src/server/transcriptInbox.ts) | **KEEP** durable delivery and generation semantics; **REWRITE** torn-tail repair, acceptance-order replay and stale-delete handling. Persisted leases/retries are real recovery machinery, not redundant transport code. | [Tests](../test/transcriptInbox.harden.test.ts) |
| 28 | [H3 pairing, grants and certificates](../src/server/transport/h3/) | **KEEP** authenticated gateway/pinning; **REWRITE** grant reset on changed identity, old-token stream retirement and long-lived listener certificate selection. | [Tests](../test/h3.mobile-server-pairing.test.ts) |
| 29 | [Web desktop, thread hosting and readiness](../src/server/webDesktopService.ts) | **KEEP** thin browser service, thread contracts and typed preflight; **REWRITE** shared child startup/shutdown, correct child-origin tokens, preserved missing-project records and entry-safe filesystem mutations. | [Tests](../test/webDesktopRoutes.test.ts) |
| 30 | [Workspace/session backups and Git worktrees](../src/server/sessionBackup.ts) | **KEEP** opt-in snapshots/tar/deltas and Git-native worktrees; **REWRITE** rollback-preserving restore, canonical containment, framed fingerprints and cross-process session/workspace locking. **DELETE** destructive empty-first restore; expose crash recovery without overwriting newer edits. | [Tests](../test/session-backup-coordination.test.ts); [related](../test/worktreeService.test.ts) |
| 31 | [Commands, titles, connectors and citations](../src/server/commands.ts) | **KEEP** discovery/background title/native connector/mutation signal contracts; **REWRITE** literal one-pass argument expansion, bounded citation admission/body cleanup and explicit connector refresh cache policy. | [Tests](../test/server.commands.test.ts); [related](../test/citationMetadata.test.ts) |
| 32 | [Canvas and Office preview/comparison](../src/server/canvasDocumentPersistence.ts) | **KEEP** staged commit/conflicts, immutable preview inputs and bounded diff; **REWRITE** stable one-pass content/hash reads and attributed XML text. **DELETE** path comparison that recanonicalized away a root swap. | [Tests](../test/canvasDocumentPersistence.test.ts); [related](../test/artifactComparisonService.test.ts) |
| 33 | [Spreadsheet preview and patching](../src/server/spreadsheetColumnWidth.ts) | **KEEP** typed patches and untouched ZIP parts; **REWRITE** grid bounds, CSV dialect, row/style preservation, final source-version checks and deterministic column-width codec. Raw OOXML widths no longer depend on another workbook's SheetJS state. | [Tests](../test/spreadsheetEdit.test.ts); [related](../test/spreadsheetPreview.test.ts) |
| 34 | [Presentation preview](../src/server/presentationPreview.ts) | **REWRITE** exported-deck preview using immutable source bytes and signed native renderers, bounded lifetime and explicit text-only fallback. **DELETE** guessed caches, ambient/inferred workspace code and partial native success. | [Tests](../test/presentationPreview.test.ts) |

### Tools, platform and integrations

| # | Piece / implementation | Decision and completed outcome | Representative regression |
| --- | --- | --- | --- |
| 35 | [Guarded file mutation and tool admission](../src/tools/mutationGuard.ts) | **KEEP** canonical role/approval policy and validators; **REWRITE** locked staged write/edit/append, live path/version/abort checks, mode and encoding preservation. Failed or conflicting publication keeps prior bytes. | [Tests](../test/tools/tools.edit.test.ts); [related](../test/tools/tools.write.test.ts) |
| 36 | [Bounded text/image reads](../src/tools/read.ts) | **REWRITE** abort-driven stream teardown and bounded retained-window parsing. **KEEP** line/column, CR/LF, BOM, UTF-8/UTF-16 and malformed-byte behavior. Stop after the requested window. | [Tests](../test/tools/tools.read.test.ts) |
| 37 | [Glob permissions and workspace context](../src/utils/permissions.ts) | **KEEP** per-candidate canonical scope and credential denials; **REWRITE** authorization discovery once per invocation and cap selected map entries before symlink metadata. Use actual configured memory location. | [Tests](../test/permissions.test.ts); [related](../test/workspace.map.test.ts) |
| 38 | [Grep and ripgrep installation](../src/utils/ripgrep.ts) | **KEEP** argv-safe native search, exclusions and tree-aware runner; **REWRITE** caller-counted cold-install cancellation, unique staging, body cleanup and serialized atomic promotion. Carry one grep deadline across bootstrap/search and preserve policy restrictions. | [Tests](../test/ripgrep.install.test.ts) |
| 39 | [Process, shell and environment primitives](../src/platform/proc.ts) | **KEEP** platform seams and active tree termination; **REWRITE** pre-abort no-spawn, cwd/quoted-PATH correctness and Node-compatible Windows taskkill. **DELETE** unused shutdown scaffolding; reuse smart-quote-aware escaping. | [Tests](../test/platform/proc.test.ts); [related](../test/platform/shellPlan.test.ts) |
| 40 | [Platform sandbox policy and readiness](../src/platform/sandbox/) | **KEEP** enforcement and escalation floors; **REWRITE** credentials-before-marker recovery, honest failed-probe readiness and invocation-local deduplicated metadata scans, including case-insensitive protected names. | [Tests](../test/platform/sandbox.enforcement.integration.test.ts) |
| 41 | [Atomic files, locks and preview identity](../src/utils/filePreviewRead.ts) | **KEEP** canonical active primitives; **REWRITE** precise versions, immutable authorized preview identity, late-reset invalidation and read-only fsync. **DELETE** unused directory lock and move helper; keep now-consumed atomic replace. | [Tests](../test/filePreviewRead.test.ts); [related](../test/fileLock.test.ts) |
| 42 | [Web tools and small session tools](../src/tools/webFetch.ts) | **KEEP** typed adapters, DNS pinning, permissions and untrusted framing; **REWRITE** total body lifetime, decoded size caps and partial-write cleanup. **DELETE** unconditional remote enrichment of usable local HTML. Keep small session-owned tools. | [Tests](../test/tools/tools.webFetch.test.ts); [related](../test/tools/tools.webSearch.test.ts) |
| 43 | [MCP config, OAuth and connection generations](../src/mcp/toolCache.ts) | **KEEP** layered scoped config, PKCE and transport/schema adapters; **REWRITE** locked mutations, retained OAuth registration, challenge CAS, connection-generation ownership and cursor pagination. | [Tests](../test/mcp.cache.test.ts); [related](../test/mcp.auth-store.test.ts) |
| 44 | [Plugins and marketplace persistence](../src/plugins/overrides.ts) | **KEEP** manifest/path validation, local-first catalogs and staged installs; **REWRITE** atomic full-cycle overrides/marketplace mutations and duplicate validation within lock. Preserve source hashes and scoped credential migration. | [Tests](../test/plugins.catalog.test.ts) |
| 45 | [Skill catalog, bootstrap and plural installation](../src/skills/operations.ts) | **KEEP** YAML/catalog precedence, feature gates, body cache and bootstrap ownership; **REWRITE** plural install as prepared, scope-locked activation with full rollback and named retained recovery when rollback fails. | [Tests](../test/skills.operations.test.ts) |
| 46 | [Opt-in skill improvement and restore](../src/skillImprovement/) | **KEEP** opt-in improvement/evidence/history and built-in shadow support; **DELETE** unsupported read-only plugin write paths. **REWRITE** JobStore with canonical lock, staged restores and retained unique recovery snapshots. | [Tests](../test/skillImprovement.backups.test.ts); [related](../test/skillImprovement.jobStore.test.ts) |
| 47 | [Memory creation, migration and generation](../src/advancedMemory/MemoryGenerator.ts) | **KEEP** SQLite/Markdown stores and the constrained generator; **REWRITE** atomic create-only Add, retryable migration, canonical traversal, reserved-index protection and exact generation watermarks. Edit/upsert remains compatible; collisions preserve the draft and original memory. | [Tests](../test/advancedMemory.store.test.ts); [related](../test/session/agentSession.advancedMemory.test.ts) |
| 48 | [Settings sync and durable retry](../src/sync/service.ts) | **KEEP** explicit settings-only opt-in and redaction allowlist; **REWRITE** locked outbox mutation, earliest-due retry scheduling, latest-config checks, bounded HTTP lifetime and preference round-trip. | [Tests](../test/sync.cloud-sync.test.ts) |
| 49 | [Conversation/config imports](../src/import/conversations/persist.ts) | **KEEP** source normalization, deterministic identities and plain-context handoff; **REWRITE** matching selection, message fidelity, older-chat access, atomic session/snapshot/import-ledger transaction, real-directory validation and owned staging cleanup. | [Tests](../test/import-conversations.test.ts); [related](../test/import.test.ts) |
| 50 | [GitHub source materialization/auth](../src/extensions/github.ts) | **KEEP** shared GitHub/local materializer, source fingerprints and connector gate; **REWRITE** positive/missing token TTL, bounded credential processes/full response bodies and four-way recursive transfer with depth/entry/byte/deadline budgets. | [Tests](../test/github-extension-downloader.test.ts); [related](../test/extensions.githubToken.test.ts) |

### Agents, tasks and workflows

| # | Piece / implementation | Decision and completed outcome | Representative regression |
| --- | --- | --- | --- |
| 51 | [Persistent children, profiles and role policy](../src/server/agents/AgentControl.ts) | **KEEP** parent-child authorization, task locks and distinct child sessions; **REWRITE** synchronous admission, shared cap for resumed work, restart state and locked profile persistence. **DELETE** text-based successful-completion inference. | [Tests](../test/agentControl.test.ts); [related](../test/agentProfiles.test.ts) |
| 52 | [Durable task review, restore and retry](../src/server/tasks/TaskCoordinator.ts) | **KEEP** durable revisions/dependencies/authority and content-addressed versions; **REWRITE** validate-before-side-effects, explicit completed reviewer verdict and exact-byte pre-commit rollback. **DELETE** unavailable handoff tools and post-commit compensation. | [Tests](../test/task-questions.test.ts); [related](../test/tools/taskReview.test.ts) |
| 53 | [Workflow worker/runner ownership and ceilings](../src/workflows/WorkflowRunner.ts) | **KEEP** cancellation, replay, deadlines and bounded concurrency; **REWRITE** realm-native error translation, live budget checks, close-promise observation and worker/host admission ceilings. | [Tests](../test/workflows/sandbox.escape.test.ts); [related](../test/workflows/agentTimeout.test.ts) |
| 54 | [Workflow registry, replay and authored DSL](../src/workflows/registry.ts) | **KEEP** bounded metadata execution, explicit import restrictions, precedence, content-addressed large inputs, one repair turn and source-preserving research stages. Keep dev-harness-only DelegateRunner and tiny compatibility re-export. | [Tests](../test/workflows/runner.test.ts) |

### Desktop renderer and Electron

| # | Piece / implementation | Decision and completed outcome | Representative regression |
| --- | --- | --- | --- |
| 55 | [Desktop shell, onboarding and primitives](../apps/desktop/src/App.tsx) | **KEEP** the platform shell, onboarding and semantic component system; **REWRITE** error-boundary reset and demonstrated motion/focus defects. Preserve native variants and keyed remount behavior rather than reskinning working flows. | [Tests](../apps/desktop/test/settings-shell.test.ts) |
| 56 | [New chat and creation readiness](../apps/desktop/src/ui/creation/useCreationReadiness.ts) | **KEEP** controlled drafts and accepted-send behavior; **REWRITE** serial readiness polling and target invalidation. Bound the composer and make short-window setup/actions scroll-reachable; starter suggestions cannot replace a draft. | [Tests](../apps/desktop/test/creation-readiness-refresh.test.tsx) |
| 57 | [Search, sidebar, tasks and quick-chat navigation](../apps/desktop/src/ui/CommandPalette.tsx) | **KEEP** navigation shell; **REWRITE** filter-before-limit search, search visibility independent of collapsed groups and one-shot URL selection. **DELETE** dead-end task presentation caps, retaining bounded displayed results with reachable expansion. | [Tests](../apps/desktop/test/command-palette.test.tsx) |
| 58 | [Feed text, activities, markdown and citations](../apps/desktop/src/ui/chat/feedMessageParsing.ts) | **KEEP** virtualization/scroll ownership and typed attachments; **REWRITE** lossless user text, honest active/error status and stable historical derivation. **DELETE** ambiguous attachment heuristics, remote favicon disclosure and eager hidden formatting. | [Tests](../apps/desktop/test/feed-row-visible-message.test.tsx) |
| 59 | [Renderer state and acknowledged mutations](../apps/desktop/src/app/store.actions/workspaceDefaults.ts) | **KEEP** store composition and frame batching; **REWRITE** receipt-owned mutation, field-owned rollback, serialized intents, stale read/navigation guards and complete removed-workspace cleanup. **DELETE** redundant/quadratic persistence traversals. | [Tests](../apps/desktop/test/workspace-settings-sync.defaults.test.ts) |
| 60 | [Renderer transport and browser persistence](../apps/desktop/src/lib/webTranscriptDelivery.ts) | **KEEP** one workspace socket and durable batch delivery; **REWRITE** runtime lifecycle, canonical snapshot/tool identity and issuer-origin credentials. **DELETE** generic unrelated-error fanout and duplicate stream state/sort code. | [Tests](../apps/desktop/test/web-transcript-delivery.test.ts) |
| 61 | [Settings forms, account recovery and import](../apps/desktop/src/ui/settings/pages/ProvidersPage.tsx) | **KEEP** settings capabilities; **REWRITE** workspace/submission-owned drafts, acknowledged mutations, scoped operation keys and latest import selection. Provider account switching, usage collapse and memory-conflict feedback now reflect the actual result. | [Tests](../apps/desktop/test/providers-page.test.ts) |
| 62 | [Canvas, Office editors and spreadsheet policy](../apps/desktop/src/ui/UniverSpreadsheetCanvas.tsx) | **KEEP** lazy editors/save conflicts; **REWRITE** non-destructive close approval, final owned-write drain, safe rebase/target-bound asks and supported-command enforcement. **DELETE** invented DOCX roles; retain32 MiB preview cap. Reject lossy XLSX value types with explicit notice. | [Tests](../apps/desktop/test/univer-save-state.test.ts); [related](../apps/desktop/test/canvas-persistence-races.test.ts) |
| 63 | [Explorer navigation, previews and file links](../apps/desktop/src/ui/file-explorer/WorkspaceFileExplorer.tsx) | **KEEP** explorer and preview controllers; **REWRITE** accepted-navigation selection, latest intent, visible action failures and safe percent/path decoding. Preserve failed-save drafts and contained link resolution. | [Tests](../apps/desktop/test/workspace-file-explorer-ui.test.tsx) |
| 64 | [Electron/native and renderer close lifecycle](../apps/desktop/electron/main.ts) | **KEEP** secure native windows; **REWRITE** single-flight startup, non-destructive save approval, final pending-draft/geometry drains and veto-safe updater/quit ordering. Cooperative parent-managed shutdown and asynchronous helper verification retain trust checks. | [Tests](../apps/desktop/test/canvas-window-lifecycle.test.tsx); [related](../apps/desktop/test/electron-shutdown.test.ts) |
| 65 | [Privileged IPC, state, media and watchers](../apps/desktop/electron/ipc/files.ts) | **KEEP** sender validation and schema assertions; **REWRITE** full-cycle multiwindow state transactions and entry-safe/descriptor-safe file operations. **DELETE** 38 input-only wrappers and stale load-side global effects. | [Tests](../apps/desktop/test/ipc-file-ops.test.ts); [related](../apps/desktop/test/markdown-media.test.ts) |
| 66 | [Native appearance, updater, relay and diagnostics](../apps/desktop/electron/services/) | **KEEP** small platform adapters and updater/pinning foundations; **REWRITE** popup/relay ownership, install-ready recovery, immediate consent and safe diagnostics ownership. | [Tests](../apps/desktop/test/updater-service.test.ts); [related](../apps/desktop/test/diagnostics-service.test.ts) |

### Mobile

| # | Piece / implementation | Decision and completed outcome | Representative regression |
| --- | --- | --- | --- |
| 67 | [Mobile routing, fonts and native UI foundation](../apps/mobile/src/app/_layout.tsx) | **KEEP** Expo/React Native, native navigation and bounded render/list models; **REWRITE** font-failure recovery. **DELETE** fake scaffold conversation and interruption messages. | [Tests](../test/mobile.root-layout.test.tsx) |
| 68 | [Mobile identity-scoped cache and bootstrap](../apps/mobile/src/features/cowork/offlineCacheStorage.ts) | **REWRITE** one owner-scoped hydration, encrypted per-desktop caches, conservative legacy draft migration, revision-guarded results and 250 ms coalesced persistence. **DELETE** repeated hydration, duplicate feeds and fixed 100 ms readiness delay. | [Tests](../test/mobileOfflineCache.test.ts); [related](../test/mobile.app-provider.test.tsx) |
| 69 | [Mobile pairing and pinned transport lifetime](../apps/mobile/src/features/relay/secureTransportClient.ts) | **KEEP** certificate/SPKI trust, reconnect and permission checks; **REWRITE** generation-owned pairing/POSTs, trust writes, stream teardown and HTTPS/no-redirect resource lifetime. | [Tests](../test/mobile.secure-transport-client.test.ts) |
| 70 | [Mobile acknowledged editors and preferences](../apps/mobile/src/features/cowork/memoryStore.ts) | **KEEP** native controls; **REWRITE** canceled creation, explicit save outcomes, lossless MCP argv/hidden fields, dirty owner drafts, actual usage fields, source prose and permission-recovery/accessibility state. | [Tests](../test/mobile.workspace-editors.test.tsx) |
| 71 | [Native iOS lifecycle and Android integration](../apps/mobile/plugins/with-ios-scene-lifecycle.js) | **KEEP** native Expo hosts; **REWRITE** durable scene integration and stream ownership. Preserve least permissions/linking hooks and remove unrelated generated project churn; no dependency upgrade was needed. | [Tests](../test/mobile.native-transport-lifecycle.test.ts); [related](../test/mobile.native-permissions.test.ts) |

### Delivery, native packaging, docs and tests

| # | Piece / implementation | Decision and completed outcome | Representative regression |
| --- | --- | --- | --- |
| 72 | [Desktop build targets and quality harness](../scripts/build_desktop_resources.ts) | **KEEP** native artifact checks; **REWRITE** complete target propagation, compiler/content cache identity, safe output roots and owned startup cleanup. **DELETE** fake reconnect proof and silent unknown fixture success. | [Tests](../apps/desktop/test/electron-preflight.test.ts) |
| 73 | [Unified runtime trust, install and downloads](../src/coworkRuntime/) | **KEEP** one signed/integrity-checked installer and platform resolver; **REWRITE** trust-cache eligibility, rejected env stripping, post-commit cleanup and bounded downloads with unique partials. Active downloads may progress without a fixed total archive deadline. | [Tests](../test/coworkRuntimeDownload.test.ts) |
| 74 | [Release CI and Windows native bundle](../scripts/windowsSandboxBundle.ts) | **KEEP** pinned engine/provenance/hash/signing checks; **REWRITE** locked mobile prerequisites, standalone helper inclusion and fail-closed Job Object setup/cleanup. Native source changes intentionally invalidate stale prebuilt fingerprints. | [Tests](../test/cowork-server-release.workflow.test.ts); [related](../test/win-sandbox-prebuilt.test.ts) |
| 75 | [Telemetry, model spans and redaction](../src/observability/modelCallSpan.ts) | **KEEP** explicit consent, kill switches, allowlists and SDK boundaries; **REWRITE** generation-owned initialization and metadata-only default errors. **DELETE** raw error/full-config credential leakage; honor trusted payload consent deliberately. | [Tests](../test/observability.otel.test.ts); [related](../test/productAnalytics.test.ts) |
| 76 | [Dev harness, semantic checks and schema generation](../packages/harness/src/) | **KEEP** deterministic scenario harness and canonical contract generator; **REWRITE** false semantic success and trace credential scrubbing. Keep the one-line platform re-export as a useful migration boundary. | [Tests](../test/harness.raw-loop-validation.test.ts) |
| 77 | [Test runner, fixtures and quality ratchets](../scripts/run_tests.ts) | **KEEP** the authoritative fresh-process runner and shrink-only safety gates; add deterministic failures at actual lifecycle/transaction boundaries. **DELETE** tests exclusive to removed dead code, not useful compatibility or security coverage. | [Tests](../test/run-tests.test.ts); [related](../test/platform-boundary.test.ts) |
| 78 | [Development scripts and dependency manifests](../scripts/cloud_session_start.sh) | **KEEP** small wrappers and actual consumer dependencies; **REWRITE** frozen cloud dependency prerequisites and content/toolchain-aware stamps. Preserve private package and build-resource boundaries; no dependency pruning from Knip alone. | [Tests](../test/cloud-session-start.test.ts); [related](../test/package-manifest.test.ts) |
| 79 | [Protocol and contributor documentation](../docs/websocket-protocol.md) | **KEEP** the protocol, harness and contributor sources of truth; update consent, recovery, build and platform statements with their implementation. Generate schemas from source; label historical proposals instead of presenting them as current behavior. | [Tests](../packages/harness/src/check_docs.ts) |
| 80 | [Built-in data, prompts, skills and helper catalogs](../config/) | **KEEP** validated model data and purposeful model/subagent/maintenance prompts, feature-gated task/workflow/memory skills and developer metadata. Correct schema/trust wording; do not delete duplicate-looking distributions without consumer evidence. | [Tests](../test/prompt.test.ts) |

### Configuration and instruction assets

The [110 model definitions](../config/models/) were retained without speculative
price/capability refreshes. [System and subagent prompts](../prompts/), bundled
[skills](../skills/) and [workflows](../workflows/) keep their distinct purposes.
Actual tool-schema/trust drift was corrected; model-specific templates were not
collapsed without behavior parity. Contributor rules in [agent_docs](../agent_docs/)
and developer-helper distributions remain supporting content, not competing
runtime business logic.

## Measured changes

These are matched deterministic workloads or explicit bounded resource policies.
They do not establish a whole-app startup or end-to-end latency percentage.

| Workload / boundary | Before | After | Reproducible evidence |
| --- | --- | --- | --- |
| Glob: 100 candidates, three plugins, maxResults=1 | 101 plugin discoveries, 303 manifest reads, 1,515 canonicalizations | One discovery, three reads, 314 canonicalizations; per-candidate scope checks retained | [Permission tests](../test/permissions.test.ts), [glob](../test/tools/tools.glob.test.ts) |
| First 2,000-character window of an 8 MiB line | 8,388,608 source bytes consumed | 65,536 bytes consumed; encoding/newline behavior retained | [Read regressions](../test/tools/tools.read.test.ts) |
| Overlapping sandbox metadata roots | 11 directory reads in shared fixture; seven per individual backend | Four reads; no persistent permission cache | [Sandbox policy tests](../test/platform/sandbox.test.ts), [parity](../test/platform/sandbox.parity.test.ts) |
| Task summaries for three tasks | 37 SQL calls and full detail hydration | One SQL statement, zero detail reads, exact parity across seven filters | [Task persistence](../test/task-mode.persistence.test.ts), [summary query](../src/server/sessionDb/tasks.ts) |
| Catalog use during prompt composition | Unrelated remote discovery/account/process probes | Cache-only configured snapshot makes zero such probes; selected-model capability lookup remains distinct | [Catalog tests](../test/providers/connection-catalog.test.ts), [prompt tests](../test/prompt.test.ts) |
| Mobile stream/typing persistence | Duplicate histories serialized on separate update ticks, no ordinary-history bound | 250 ms coalescing; one stored feed; 100 ordinary conversations/200 feed items each; authored drafts retained | [Offline cache](../test/mobileOfflineCache.test.ts), [thread store](../test/mobile.thread-store.test.ts) |
| Raw file-preview retention | Unbounded shared byte retention | 32 MiB LRU; oversized entries returned without retention | [Preview resource tests](../apps/desktop/test/file-preview-resource.test.ts) |
| Backpressured accepted frames | Reproducer received [1,1,2] | Exactly [1,2]; accepted buffered frames are not resent | [Backpressure tests](../test/server.backpressure.test.ts) |
| Concurrent credential saves | Provider/tool keys lost in five of five trials; eight MCP saves retained one | Complete locked mutations preserve all intended records, including multi-process cases | [Connection tests](../test/connect.test.ts), [MCP auth](../test/mcp.auth-store.test.ts) |
| Short desktop: 900×480, blocked setup, 12 draft lines, six attachments | Send button bottom at 622.76 px, clipped | Bottom at 445.02 px after normal scrolling; scrollWidth=clientWidth=647 px; draft retained | [Real Electron geometry assertion](../apps/desktop/quality-gates/specs/assertions.pw.ts), [landing](../apps/desktop/src/ui/chat/NewChatLanding.tsx) |
| XLSX column width through real editor→patch→disk→reload | Requested 140 px returned 270 px | 140 px remains 140 px; no relaxed assertion | [Real SDK bridge](../apps/desktop/test/univer-save-state.test.ts), [width codec](../src/server/spreadsheetColumnWidth.ts) |
| Error notice above the Settings backdrop | Title/body contrast 1.46:1 / 1.67:1 | Light 5.19:1 / 15.8:1; dark 4.68:1 / 12.9:1; forced colors 21:1 / 21:1; no Axe violations in the three cases | [Rendered notification regressions](../apps/desktop/quality-gates/specs/adaptive-surfaces.pw.ts) |

Two localized source reductions are real: the preload changed **937→789 lines**
after removing 38 input-only wrappers while retaining output assertions, and the
Antigravity runtime changed **582→481 lines** by reusing canonical tool execution
and owning SDK lifetime explicitly. They do not offset the overall growth below.
See [preload boundary tests](../apps/desktop/test/preload-boundary.test.ts) and
[Antigravity regressions](../test/runtime.antigravity.test.ts).

The signed native presentation path also rendered an actual two-slide deck in
5.070 seconds in a macOS functionality smoke. That is a successful render timing,
not a controlled before/after speed benchmark. Text-only fallback is intentionally
identified in both the result and [visible notice](../apps/desktop/src/ui/PresentationPreviewNotice.tsx).

## Maintainability accounting

The final code/quality snapshot, including the integration fixes and reviewed
screenshots but before this final acceptance prose, reports:

| Measure | Baseline | Final snapshot | Change |
| --- | ---: | ---: | ---: |
| Tracked files | 2,682 | 2,728 | +46 |
| Tracked text lines | 677,546 | 722,800 | +45,254 |
| Biome-scanned JS/TS files | 1,894 | 1,931 | +37 |
| Source functions above cognitive-complexity 15 | 657 | 705 | +48 |
| Test functions above cognitive-complexity 15 | 53 | 71 | +18 |
| Total cognitive hotspots | 710 | 776 | +66 |
| Knip findings | 236 | 235 | −1 |

The [inventory script](../scripts/complexity.ts) counts every tracked path/text
file, including tests, generated/native/vendor and development content. Its
cognitive scores cover Biome's configured JS/TS scope. A hotspot is a function
above the threshold, not an identified bug or a total branch count. Reproduce
using `bun run complexity --json`; use the
[mapped comparison](../scripts/complexityCompare.ts) for changed-function analysis.

The increase is not only test scaffolding: the root `test/` directory grew by
22,718 lines, the desktop tree by 16,731 lines including its tests, and harness
`src/` plus `src/server/` by 3,499 lines. Production hotspots increased too.
The work must therefore be described as **reliability and bounded-work repair
with a larger maintenance surface**, not successful global simplification.

The added state has concrete jobs: distinguish pending/current/retired work;
preserve a newer field during rollback; separate accepted frames from unsent
ones; distinguish completed pre-abort tool pairs from late provider output;
retain recovery copies after failed publication; and validate actual native
stream ownership. The linked regressions exercise those distinctions. The
implementation retains supported workflows and compatibility while adding
checked failure paths. It also leaves more branches to understand and test.
Moving them into helpers solely to evade the threshold would not resolve that
cost. The unchanged high-complexity functions are still maintenance liabilities;
this record does not declare them harmless or promise an unmeasured rewrite.

Before the final painted-label regression, the existing changed-function mapper
identified 583 hotspots with unchanged
or lower scores, 87 increases, and 105 new or conservatively unmatched entries.
Unmatched declarations, moved functions, and newly crossed thresholds can all
appear in the last group; it is not a count of 105 new bugs. The original
complexity scripts, Biome/Knip configuration and dependency lockfile were unchanged.
Later edits to this document change its own line count, not these captured source
measurements.
The last CSS repair added eight lines and its rendering regression added thirty
test lines and one test hotspot; the production-hotspot count did not change.

### Knip: four new candidates, four explicit dispositions

The final issue set retains 231 existing findings, adds four names, and stops
reporting five older telemetry types, yielding 236→235. Knip still exits 1; it
is not clean, and no finding was waived. The five type declarations still exist,
so that arithmetic is not five code deletions. Whole-repo reference checks show
all four new definitions have internal consumers:

| Candidate | Current consumer / disposition |
| --- | --- |
| [OFFLINE_WORKSPACE_CACHE_KEYS](../apps/mobile/src/features/cowork/offlineCacheStorage.ts) | Used by legacy/scoped cache deletion. **KEEP** its implementation; the unused external export is a visibility-only finding accepted in this patch, not dead cache logic. |
| [RAW_REPLAY_PART_TYPES](../src/shared/modelStreamReplay.ts) | Used to suppress only normalized events with real raw-backed equivalents. **KEEP** this set and behavior; external export visibility is unused, but removing the implementation would break replay policy. |
| [resolveWorkspaceMappingInput](../src/import/conversations/workspaceMapping.ts) | Called by the validating wrapper. **KEEP** the resolver behind validation. Import callers deliberately stopped calling it directly; do not restore a validation bypass to remove an analyzer warning. The unused export remains accepted. |
| [CloseInfo](../src/platform/proc.ts) | Types the public StreamingProcess.exited promise and its implementation. **KEEP** the public result type; consumers can use the promise structurally without importing its type name. |

No runtime feature or safety check was deleted on Knip's authority alone. The
first three exports could have narrower visibility, but this change neither
claims to have removed them nor treats them as justification for further runtime
deletion. The final `bun run knip --reporter json` reproduced this issue set.
The existing configuration checks exports/types but disables dependency,
unresolved, binary and duplicate categories; this result is not a complete
dependency audit.

## Compatibility, privacy and platform limits

- **Auth/config:** user auth remains in the canonical Cowork home. Trusted
  user/environment configuration may opt into observability; project files may
  restrict it or add safe labels, not redirect inherited credentials or grant
  consent. See [config](harness/config.md) and [observability](harness/observability.md).
- **Data recovery:** whole malformed credential JSON retains tolerant reads;
  legacy snapshot formats remain readable. Broad legacy model-message acceptance
  was not tightened without supported-provider fixtures. New individual model
  preference entries recover independently instead of discarding valid neighbors.
- **Filesystem scope:** advisory locks coordinate participating writers. Canonical
  identity/version checks are not a kernel-level CAS against every external
  actor. Multi-directory skill rollback handles reported failures, not arbitrary
  power loss. Retained failed-rollback copies and interrupted-backup recovery are
  deliberate; they are not automatically applied over newer user edits.
- **Imports:** session, visible snapshot and import ledger commit atomically;
  the separate desktop workspace catalog is not part of that SQLite transaction.
  An occupied legacy partial-import ID without a ledger fails closed.
- **Spreadsheet fidelity:** unsupported structural edits and lossy XLSX forced-text
  or boolean edits are rejected before mutation with a visible explanation.
  This is not full spreadsheet-editor compatibility. The deterministic width
  codec does not promise identical physical pixels for every Office font/DPI.
- **Presentation/archive handling:** preview accepts exported decks, not inferred
  workspace JavaScript. Text-only fallback omits layout/media/style and says so.
  ZIP metadata limits are useful but are not adversarial decompression certification.
- **Transport:** WebSocket pressure fixes do not bound all HTTP/SSE response streams
  or evict every loopback client ID. Pairing identity remains an asserted string,
  not proof of possession; cert/key publication is not a two-file transaction.
- **Workflow isolation:** demonstrated cross-realm constructor leaks are closed.
  The in-process VM is not a general-purpose OS security sandbox.
- **Native Windows:** portable Rust ownership tests and mocked Windows paths do
  not establish real Win32 containment. The existing execution window before Job
  Object assignment remains. Source fingerprint drift deliberately rejects old
  prebuilts until matching assets are built; trust metadata must not hide it.
- **Native/mobile:** device launch, rendered fixtures, Metro exports and module
  compilation are separate evidence. No Android app launch, actual QR pairing,
  manual VoiceOver/TalkBack or complete warm/cold deep-link interaction is claimed.
- **Accessibility:** the new notification and selected-label cases have zero raw
  Axe violations, but the [existing contrast baseline](../apps/desktop/quality-gates/axe-baseline.json)
  still permits identified navigation, top-bar, activity and sidebar debt.
  That allowance only shrank; passing the matrix is not a claim of zero raw
  violations throughout the app or full WCAG compliance.
- **Tooling:** flags-only test-runner invocations retain an isolation caveat, and
  `fetch_comments.py` retains its limited thread/comment pagination. Follow the
  authoritative root test command, not bare `bun test`.

## Application-level verification

All interactive checks used separate temporary profiles, workspaces and auth
homes. They did not use the user's real credentials or modify personal projects.
The desktop checks launched the actual production main/preload/renderer build,
not only the quality-fixture entrypoint.

### Desktop and browser

- **Remembered facts:** native Add, duplicate rejection, retained draft, Keep
  editing, renamed retry and explicit Edit all worked. The original record and
  the new record were checked in SQLite. Conflict feedback was visible in the
  dialog footer without scrolling. A normal restart with Memory selected no
  longer produced false pre-handshake connection errors.
- **Markdown:** edited an actual workspace file in Canvas source mode, closed
  the dirty Canvas, reopened it, and verified the exact saved text on disk. This
  proves close-time flushing; it is not a claim of periodic autosave.
- **Spreadsheet:** changed CSV cell B2 from 100 to 125 in the actual editor,
  saved, closed and reopened it. The displayed value and file bytes agreed;
  adjacent values 150 and 175 were preserved.
- **Unsent draft:** entered a draft and immediately quit normally. The process
  exited successfully, persistence contained the draft, and the next launch
  restored the exact text without sending a model request.
- **Built web client:** Add, duplicate rejection, renamed retry, Edit and page
  reload used the real local web service and persisted the expected SQLite
  records. These were DOM/state checks, not a complete visual browser pass:
  T3 preview screenshots were unavailable, its hidden preview did not advance
  animation frames, and dialog exit animation could not be certified there.
- **Selected Settings labels:** actual Linux screenshots caught unreadable text
  that computed-color Axe checks missed. Two localized, reviewed pixel goldens
  cover initial rendering, Models→Profile & Memory→Models navigation and an
  already-open light window switching to forced colors. The old build failed
  both affected cases by 524 pixels each; the rebuilt app passed all three mode
  cases, with zero violations in the five captured Axe results.

The selected-label fix retains the system highlight palette and disables
automatic text backplates only for that label, using the control defined by the
[CSS Color Adjustment specification](https://www.w3.org/TR/css-color-adjust-1/#forced-color-adjust-prop).
It does not disable forced colors for the application or replace the user's
palette with fixed colors.

### Mobile and native transport

The final shared usage fix was followed by fresh iOS and Android Metro exports.
The iOS Release app was rebuilt with a fresh embedded bundle, installed and
launched on the dedicated iOS 27 simulator. All 293 actual source/native/config
inputs remained unchanged during the build; the installed executable, bundle
and Info.plist hashes matched the built artifact. The unpaired Remote Access
screen was visually inspected without the previous scene-launch failure.

The embedded iOS bundle SHA-256 was
`1fbae0d29e69cd8425b37374ad5495421f41fbd46da1ff4f8d80f89a07962ffe`.
This establishes build/install/launch provenance, not successful QR pairing or
screen-reader navigation. Android evidence consists of the fresh Metro export,
the actual pinned-transport module compilation, and host-side native lifecycle
execution. With the existing Kotlin/Java toolchain on PATH, all ten Kotlin and
five Swift transport lifecycle cases ran without skips.

## Final verification

The frozen acceptance snapshot is
`a034e9d0da713ebf6cc9318528ef2496111b7acf`. Its code, tests, build inputs and
reviewed images match implementation commit
`30983b6d7ef83543de34827c9acbbee8b55c94d9`; only this decision record differs.
All 2,728 isolated Linux source paths were checked against their Git blobs after
the run with zero mismatches. The completed record passed separate static and
documentation checks after the immutable-source gates; no production code,
test, build input or reviewed image changed after acceptance.

| Gate / surface | Evidence | Result |
| --- | --- | --- |
| Full isolated project tests | Final acceptance run: 9,913 pass, zero failures, 27 platform/live-integration skips across all 736 files. The native Swift and Kotlin lifecycle cases executed rather than being skipped. | **PASS** |
| Root/harness/desktop and mobile TypeScript | All four strict targets passed against the acceptance snapshot. | **PASS** |
| Biome check/lint | Both commands passed against the acceptance snapshot. | **PASS** |
| Protocol/docs schemas | Source/schema checks and this completed decision record passed the documentation check. | **PASS** |
| Linux/Electron quality matrix | Final run: 72 pass, zero failures or flaky cases, four opt-in negative-proof skips, 14.7 minutes. The separate product-screenshot consistency check also passed. | **PASS** |
| Desktop performance | All three 1,000-delta transport paths, the 1,000-message transcript and 1,000-entry file tree passed the existing publication, render, responsiveness and filesystem budgets. | **PASS** |
| Selected-label regression | Actual old build: two expected pixel failures, dark case passes. Actual rebuilt app: all three cases pass, including live media changes and navigation. | **PASS** |
| Negative quality-gate proofs | All four opt-in cases ran separately after the final matrix. Intentional renderer, visual, mention-geometry and Axe failures were rejected and their required diagnostic artifacts verified; verifier exit 0. | **PASS** |
| Native desktop | Actual production build, Memory startup/recovery, Markdown and CSV save/reopen, exact draft recovery and normal quit verified with an isolated profile. Latest CSS build relaunched and quit successfully. | **PASS** |
| iOS | Fresh export, forced Release bundle/build, installation, launch and screenshot; installed executable/bundle/plist match the built artifact and all 293 source inputs were stable. | **PASS — stated scope** |
| Android | Fresh export, actual pinned-module compilation and all ten host-side Kotlin lifecycle cases; no Android application launch claimed. | **PASS — stated scope** |
| Static inventory | Acceptance snapshot: 2,728 tracked files, 722,800 text lines and 776 cognitive hotspots. Later prose changes only this document's line count. | **COMPLETE — growth disclosed above** |
| Knip | 235 export/type findings, including four newly reported candidates with the dispositions above. | **REMAINING DEBT — exit 1** |

No production release, real-provider generation or universal platform/security
certification is implied by these local gates.

The final matrix retained 46 raw Axe documents: 39 had zero violations; six
ordinary captures contained only the pre-existing top-bar subtitle contrast
issue; one negative-control capture contained deliberately injected bad contrast
that the gate correctly rejected. No unexpected serious or critical violation
was accepted. The five notification/media-change/navigation captures all had
zero raw violations. The retained baseline remains debt, not proof of compliance.

The three streaming paths used 157–158 content publications (budget 280),
173–175 store publications and 199–207 React commits (both budgets 320), with
zero background-feed or background-sidebar renders. These are controlled
workloads on Linux x64 under arm64 emulation, not a native before/after latency
benchmark. No performance budget or screenshot tolerance was raised.

Verified commands were `bun run test`, `bun run typecheck`,
`bun run app:mobile:typecheck`, `bun run check`, `bun run lint` and
`bun run docs:check`, followed by the actual desktop/mobile gates above.
Linux used `bun run desktop:quality` and `bun run desktop:quality:proof` under
Xvfb in the pinned CI image, with no screenshot-update flag or retries.
The [project runner](../scripts/run_tests.ts) and
[quality harness](../apps/desktop/quality-gates/README.md) remain authoritative.

Local logs, source manifests, raw accessibility captures, performance receipts,
failure traces and artifact hashes were retained under
`/tmp/cowork-reliability-overhaul/`. The full test log SHA-256 is
`35270dce63a3d5162464f043f30bed276a56d2bdcc0b188312c7ffbc2a24f402`;
the Linux source-manifest SHA-256 is
`52f30a25c9250c96b30c554a70a3a471230fd4650dc741392192155517756973`.

No release publication is asserted by this record.
