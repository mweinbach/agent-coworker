# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

## 1.2.3 - 2026-07-02

### Added

- **First-message optimistic user bubble** — Queued the first message of a new
  chat with a pre-generated `clientMessageId` and pushed its optimistic user
  bubble plus a pending turn-start state before the workspace socket or thread
  session exists, so the transcript responds at send click instead of after
  multiple round trips. The id travels through the pending-message queue into
  `turn/start` so the server echo dedups against the optimistic bubble.
  Thread-start failures and workspace disconnects now clear the pending
  turn-start so the composer never sticks in Sending.
- **Working shimmer placeholder** — Rendered a shimmering "Working" placeholder
  row in the chat feed from the moment a turn is pending or running until the
  first reasoning, tool, or assistant item lands, so the transcript no longer
  looks frozen between send and first token. Decision logic lives in
  `shouldShowWorkingPlaceholder` with unit coverage for busy, pending, steer,
  log-line, and empty-feed cases.
- **Provider model discovery cache** — Added an on-disk model discovery cache
  so runtime-discovered models (LM Studio, Bedrock, Codex CLI) can be selected
  and validated alongside the static catalog without passthrough eroding
  config-startup resilience or persisted-session migration.
- **Expanded `/cowork/health` diagnostics** — Expanded the liveness endpoint to
  return `version`, `uptimeMs`, `cwd`, `activeSessions`, `db`, `journal`,
  `sendQueue`, and `startup.ready` while keeping it HTTP 200 / `ok: true`.
  Added `SessionDb.ping()`, an in-memory `ThreadJournal.getAggregateHealth()`,
  a `HealthSnapshot` on the runtime, and a `startupReady` flag owned by
  `startAgentServer`.
- **Chaos harness** — Added a deterministic chaos harness covering server
  death after `server_listening`, kill during `turn/start`, slow handshake,
  reconnect during approval, health 503, send-queue overflow, and DB lock
  contention — driven through injectable seams (fake WebSocket, fake child,
  injected fetch, paired coordinators) with no spawned processes.
- **Bun-native migration plan** — Added `docs/bun-native-migration.md` audit
  and phased plan documenting the migration from `node:child_process`,
  `node:http`, and `node:crypto` to Bun-native equivalents.

### Changed

- **First-turn session warm-up** — Fired-and-forgot warm-up of the system
  prompt (skills scan, workspace context, memory), the workspace MCP tool
  cache, and lazily imported turn modules when a thread session is created or
  cold-loaded, so the first user message no longer pays that setup cost before
  streaming. Guarded the system prompt load against clobbering a concurrent
  config refresh and added `agent.turn.first_output` telemetry measuring time
  from turn start to the first visible text/reasoning delta.
- **Bun-native migration (Phases 1–6)** — Migrated scripts, the harness test
  runner, buffered child processes, long-lived streaming subprocesses, the
  Codex app-server, hot-path file reads, the MCP OAuth callback listener, and
  hashing helpers from `node:child_process` / `node:http` / `node:crypto` /
  `node:readline` / `fast-glob` to `Bun.spawn`, `Bun.serve`, `Bun.file`,
  `Bun.Glob`, `Bun.CryptoHasher`, and Web Crypto. Shared Electron/renderer
  modules are guarded against Bun-only APIs so desktop portability is
  preserved.
- **Desktop message send performance** — Stopped blocking message send on task
  summary refresh so sending a message no longer waits for the summary
  round trip.
- **Desktop server startup timeout** — Raised the default source startup
  timeout to 120s to accommodate cold starts.
- **Biome formatting and import sorting** — Applied biome import sorting and
  formatting fixes across the codebase.

### Fixed

- **Model validation guardrails** — Restored strict model validation alongside
  the provider model discovery cache. Sync paths keep discovery passthrough but
  reject ids provably registered to a different provider family. Async
  selection paths are strict (static registry plus on-disk discovery cache).
  Config load falls back to the provider default with a warning for unknown,
  non-discovered models. Persisted sessions migrate unsupported/aliased ids
  for static-catalog providers. `gemini-*` joins the model/provider mismatch
  heuristic with Google guidance. Pinned env in the connection-catalog
  `oauth_pending` test so ambient provider API keys cannot flip providers.
- **Desktop JSON-RPC reconnect hardening** — Hardened reconnect retry safety,
  preserved control bootstrap and pending mutation waiters during transient
  reconnect backoff, retried read-only JSON-RPC get routes, persisted thread
  start retry keys, persisted journal replay failure health, drained journal
  writes on runtime shutdown, ignored shutdown journal events after close,
  forced snapshots for untrusted replay, preserved optimistic messages in
  forced snapshots, stopped journal flush rescheduling after close, and
  retried spreadsheet reads during reconnect.
- **Workspace sidecar restart hardening** — Restarted stale workspace sidecars,
  invalidated workspace starts on sidecar exit, hardened restart counting
  (delayed until startup succeeds), synced healthy workspace server URLs, and
  added `forceRestart` for workspace server restarts.
- **OAuth callback listener port typing** — Guarded the OAuth callback
  listener port typing against incorrect type coercion.
- **Cross-file mock leak in skill/plugin action tests** — Pinned
  `desktopCommands` in the skill/plugin action harness against cross-file mock
  leaks from earlier test files (e.g. `backup-page.test.ts`) that persisted in
  the shared Bun test process and caused `ensureServerRunning` to treat fake
  per-workspace server URLs as stale.

### Removed

- **A2UI experimental feature** — Fully removed and stripped the A2UI
  experimental feature across server, desktop, mobile, docs, config, prompts,
  tools, session, projection, runtime, and tests. All references removed
  (zero matches outside CHANGELOG).

## 1.2.0 - 2026-06-26

### Added

- **Composer reasoning controls** — Added model-aware reasoning effort controls
  beside the composer model selector and persisted the selected effort across
  workspace defaults and active Codex/OpenAI sessions.
- **Unified Cowork runtime** — Added checksum-verified, date-versioned runtime
  installation under `~/.cowork/runtime`, platform asset selection, atomic
  activation, executable verification, and two-version fallback retention.

### Changed

- **OAI productivity stack** — Marketplace-installed workspace skills remain
  the authoritative instructions and helper scripts, while the separately
  downloaded runtime supplies their unified Node, Python, and native-tool
  dependencies.
- **Managed headless LibreOffice** — The unified runtime now includes a
  checksum-pinned LibreOffice conversion engine and exposes only Cowork's
  headless policy launcher, which blocks UI/printing modes and uses isolated
  disposable profiles.

### Removed

- **Split runtime bootstraps** — Removed the legacy artifact runtime, Codex
  primary runtime, managed LibreOffice downloader/shim, and duplicate bundled
  productivity skill copies after the marketplace-skill plus unified-runtime
  path was verified.

### Fixed

- **Codex clarification routing** — Preserved Codex app-server's native base
  policy and routed Default-mode clarification prompts through Cowork's
  `AskUserQuestion` tool instead of unavailable `request_user_input` calls.

## 1.1.19 - 2026-06-08

### Changed

- Bumped the desktop build version for the next tagged release.

## 1.1.18 - 2026-06-07

### Added

- **OS-backed command sandboxing** — Added a cross-platform sandbox layer for
  shell tool execution, replacing parse-only filtering with native policy
  generation for macOS Seatbelt, Linux bubblewrap, and a Windows restricted
  token/Job Object helper.
- **Windows sandbox helper** — Added the `cowork-win-sandbox` Rust sidecar,
  packaging support, documentation, and CI coverage so Windows shell commands
  run under the same workspace-scoped enforcement model as macOS and Linux.
- **Sandbox approval UX** — Added inline sandbox-aware approval cards and
  surfaced approval context in desktop chat so users can review why a command
  wants to step outside its current scope.
- **Scoped advanced memory management** — Added scoped memory-management
  support with a dedicated built-in tool, OpenAI skill guidance, and tests for
  memory storage behavior.

### Changed

- **Workspace-first sandbox policy** — Tightened command execution around
  canonical workspace roots, target paths, read-only floors, protected metadata,
  upload/output directories, and escalation reason codes so child agents and
  delegated Codex turns inherit the same effective boundaries.
- **Global plugin and skill reads** — Expanded allowed read coverage for
  installed global skills and plugins while preserving the sandbox floor for
  workspace writes.
- **Desktop attachment handling** — Large local attachments are copied into
  controlled upload storage before use, oversized audio uploads now provide a
  clearer hint, and attachment authorization is bound to the sending thread.
- **App-server replay** — Replayed app-server web search output more reliably
  through the model stream normalization path.
- **Workflow pinning** — Updated GitHub workflow setup steps to pin the shared
  Bun install action and added Windows sandbox helper enforcement in CI.

### Fixed

- **Sandbox escape prevention** — Rejected symlink-escaping target paths,
  writable roots inside protected metadata, child target paths outside the
  workspace, and fallback paths that would silently widen command access.
- **Sandbox backend correctness** — Hardened bubblewrap probing, macOS `/tmp`
  alias handling, Seatbelt writable-root canonicalization, Windows restricted
  token handle cleanup, and unenforceable-policy behavior.
- **Approval routing** — Kept sandbox approvals reachable across thread
  transitions, dismissed stale off-thread approvals, and handled
  no-project-write review feedback without widening access.
- **Runtime archive safety** — Hardened artifact and Codex primary runtime
  archive extraction, dereferenced safe symlinks during migration, rejected
  unsafe paths, and preserved the artifact runtime cache inside the sandbox.
- **Research and upload safety** — Preserved upload authorization through
  validation, bound desktop uploads to the active thread, and tightened
  research-file path handling.
- **H3 control subscribers** — Gated H3 control-event subscribers so pairing
  and mobile JSON-RPC traffic stay scoped to active listeners.
- **Workspace control state** — Preserved the Codex workspace control pool
  during workspace-control updates.

### Security

- **Path and archive hardening** — Added shared safe-zip extraction coverage,
  session-backup path traversal tests, runtime-download checks, and workspace
  MCP validation safeguards.
- **Sandbox regression coverage** — Added broad platform sandbox tests,
  command-policy tests, desktop approval-card coverage, IPC file tests, and
  mobile H3 JSON-RPC tests to lock in the new access boundaries.

## 1.1.17 - 2026-06-04

### Added

- **MiniMax provider** — Added a new MiniMax provider with the
  `MiniMax-M3` model, including runtime reasoning normalization, think-tag
  scrubbing on streamed titles, and unified `<think>` stripping across
  surfaced assistant messages and reasoning deltas.

### Fixed

- **Chat model persistence** — Preserved the user's selected chat model
  across restarts so the picker no longer snaps back to the previous default.
- **Codex activity trace** — Collapsed codex commentary into the activity
  trace and covered the normalized replay path with regression tests.
- **Selector popovers** — Made selector popovers opaque so the model and
  workspace pickers no longer bleed through the surrounding surface.
- **Chat title prompts** — Improved the chat title prompt to keep newly
  generated titles short and on-topic.

## 1.1.13 - 2026-06-03

### Added

- **Advanced agent memory** — Added the core advanced memory system with
  agent-driven generation, recall, read-past-conversation support,
  periodic consolidation, manual backfill controls, WebSocket protocol
  coverage, and dedicated desktop controls for enabling advanced memory,
  choosing a memory generation model, and reviewing/editing saved memories.
- **Subagent profiles** — Added built-in and specialized subagent profiles
  with desktop settings for profile defaults, prompt edits, workspace/global
  scope, disabled/copied profiles, skill refreshes, and JSON-RPC-backed
  profile management.
- **Project sidebar chat affordance** — Added a sidebar new-chat action for
  project workspaces so new chats open with the clicked project preselected.

### Changed

- **Global memory defaults** — Moved advanced memory mode and memory
  generation model defaults into shared profile/global settings while keeping
  workspace and live-session application paths synchronized.
- **Codex app-server runtime selection** — Pinned managed Codex app-server
  runtime versions and tightened resolver/client behavior for steering,
  model lookup, and active-turn request routing.
- **Cross-platform harness commands** — Centralized platform-aware command
  snippets for raw harness loops so shell guidance is less POSIX-specific.

### Fixed

- **Memory setting boundaries** — Hardened advanced memory scope isolation,
  default inheritance, live config sync, checkpointing, model preservation,
  connected-provider filtering, memory editor dialog sizing, and rollback
  behavior when desktop saves fail.
- **Subagent settings reliability** — Fixed stale catalog refreshes, hidden
  profile defaults, workspace targeting, model catalog scoping, profile edit
  save failures, and settings target grouping for one-off chat workspaces.
- **Built-in tool contracts** — Refined tool prompt guidance and coverage for
  provider-backed web search, read/write/edit/glob/grep/bash tool behavior,
  package import closure, and readonly command policy handling.

## 1.1.12 - 2026-06-01

### Changed

- **macOS release packaging** — Reduced notarization upload size and stapled
  the notarization ticket after approval so packaged macOS releases ship with a
  complete notarized app bundle.

### Fixed

- **Telemetry trace status** — Aligned Privacy & Telemetry trace status with
  the effective settings state and added coverage for packaged telemetry
  configuration.

## 1.1.11 - 2026-06-01

### Fixed

- **Privacy & Telemetry status sync** — Resolved the desktop telemetry status
  against the live privacy settings on the renderer side instead of stale
  persisted state, so the status indicator in the Privacy & Telemetry
  settings page updates immediately when the telemetry or crash reporting
  switches are toggled.

## 1.1.10 - 2026-06-01

### Added

- **Privacy & Telemetry Settings** — Introduced comprehensive privacy and telemetry controls to the desktop UI and server runtime, enabling users to opt-in or opt-out of data tracing and anonymous telemetry collection.
- **Product Analytics & Crash Reporting** — Integrated optional Sentry crash reporting across desktop and server runtimes, along with a unified product analytics wrapper utilizing PostHog for anonymous usage analytics.
- **Diagnostics Bundles** — Added a local diagnostics bundling utility to simplify collecting environment logs and system status for troubleshooting.
- **Cloud Sync Foundation** — Implemented a disabled-by-default cloud sync engine with provider abstractions, data redaction/sanitization, a durable retry queue, and a fire-and-forget desktop persistence hook.

### Fixed

- **Opt-in Telemetry Tracing** — Changed Langfuse payload tracing to be strictly opt-in rather than enabled by default.
- **Telemetry Consent Synchronization** — Ensured desktop client telemetry consent state is correctly wired and respected by local and remote servers.
- **Diagnostics Redaction** — Implemented automatic redaction of legacy diagnostic log bodies to protect sensitive user information.

## 1.1.9 - 2026-06-01

### Added

- **Canvas-backed spreadsheet editing** — Replaced the spreadsheet preview
  surface with an Excel-like canvas (Univer) that supports direct cell
  editing, a formula/value bar, click-to-select, inline editing, and
  arrow/Tab/Enter navigation with viewport auto-paging, alongside an
  in-app Maximize/Restore full-bleed layout.
- **Lossless CSV and XLSX round-trips** — CSV edits preserve BOM, line
  terminators, and trailing-newline state through a quote-aware round trip.
  XLSX edits apply a surgical zip patch (jszip + fast-xml-parser) that only
  rewrites the target worksheet XML and keeps each cell's style index, so
  fonts, number formats, charts, and other sheets stay byte-identical.
- **Atomic spreadsheet batch patches** — `spreadsheetEditBatch` now runs
  against a shared in-memory editing core with a per-file write lock, so
  bulk pastes apply as one read-modify-write and concurrent batches against
  the same file are serialized without lost edits. Empty batches no-op
  before touching disk, and operation errors are attributed to the failing
  op's index.
- **Artifact runtime support** — Added an `artifactRuntime` module that
  discovers, prepares, and migrates the LibreOffice/soffice runtime used
  for spreadsheet and presentation previews, and is wired into the server
  preview path.
- **Unified canvas request envelope** — Documents, text, slides, and
  spreadsheets now emit a single structured XML envelope for canvas
  requests, parsed by a shared `parseCanvasRequest` + `CanvasRequestBody`
  helper, with a compact file/sheet/region header rendered in chat and a
  legacy markdown fallback for historical transcripts.
- **Marketplace extension update detection** — The plugin marketplace
  surfaces extension updates so installed plugins can be refreshed without
  a full reinstall.
- **Markdown model prompts** — Migrated model-specific system prompts from
  JSON to Markdown, with refreshed metadata across the registry.
- **GPT-5.4 Pro and Nano** — Added OpenAI registry entries for GPT-5.4 Pro
  and Nano.

### Changed

- **Clarifying question tool** — Renamed the model-facing `ask` tool to
  `AskUserQuestion` across registration, prompts, and docs, and dropped
  the redundant `AskUserQuestion` alias.
- **Built-in toolbelt** — Removed the unused `notebookEdit` tool
  end-to-end and the model-visible `usage` tool. Harness eval scenarios,
  permissions, codex boundary, and prompts were updated to match.

### Fixed

- **Canvas hooks-stability** — Canvas preview no longer crashes when a
  file flips between markdown/text and CSV/XLSX/PPTX (moved spreadsheet
  and PPTX returns below all hooks and guarded editor-only effects).
- **Lossy markdown editing** — Numbered lists no longer silently become
  bullets (`<ol>` serializes as `N.`), list markers now require
  whitespace, and link hrefs are hardened against `javascript:` and
  `data:` schemes.
- **Steer reference context** — Queued steer messages retain the
  reference context supplied with the steer that queued them.
- **Forced skill injection** — Capped by per-skill and total byte limits
  so large skill sets can't blow up model context.
- **Oversized file reads** — Desktop `readFile` is capped so large files
  no longer crash the renderer; canvas previews show a truncation banner
  with guidance and keep the file read-only.
- **Windows markdown links** — Preserved on desktop so `file://` links
  round-trip cleanly on Windows builds.
- **Univer spreadsheet polish** — Fixed formula-bar styling specificity,
  save-state icon, maximize control wiring, canvas editor lifecycle,
  save ownership conflicts, maximized-canvas clipping, and unload save
  failure reporting.
- **Spreadsheet save guards** — Failed saves leave the workbook
  untouched, column resets persist, and date/style metadata is preserved
  through the XLSX patch.
- **Marketplace refresh** — Workspace tools and skills refresh on
  detected updates, and stale skill/extension metadata is reconciled.
- **Model prompt review findings** — Sharpened agent invocation patterns
  surfaced by prompt review.

## 1.1.8 - 2026-05-29

### Fixed

- **macOS release notarization retries** — Retries transient Apple notarization
  network failures, including `NSURLErrorDomain Code=-1009`, so release builds
  can recover from temporary App Store Connect or runner connectivity drops.

## 1.1.7 - 2026-05-29

### Added

- **Plugin and skill imports** — Added a desktop import flow for bringing local
  Claude Code and Codex plugins/skills into Cowork, including source discovery,
  installed-state diagnostics, Claude plugin manifest conversion, and
  JSON-RPC-backed import actions that refresh the plugin and skill catalogs.
- **Turn-scoped plugin and skill references** — Added composer `@mention`
  plumbing for skills and plugins so referenced skills are injected before model
  execution and referenced plugins are rendered into turn context across new
  turns, steering, reconnects, queued sends, and workspace-default paths.
- **Marketplace skills** — The plugin marketplace can now surface standalone
  skills alongside plugins, with available skill snapshots, install actions, and
  desktop catalog rendering.

### Changed

- **Import and mention UI polish** — Added a contained import dialog with
  Claude/Codex/folder sources, native folder picking, installed indicators,
  diagnostics, spinners, and searchable composer mention menus.
- **Usage accounting** — Expanded cost tracking so renderer-safe legacy usage
  derivation and subagent usage accounting are surfaced consistently.

### Fixed

- **Desktop robustness** — Hardened desktop IPC boundaries, preserved turn
  reference context through canvas previews, capped canvas preview reads, and
  kept local title generation resilient when Apple title generation fails.
- **Marketplace refresh behavior** — Ensured marketplace skills reappear after
  uninstall and catalog reads deliver available skills in the same emit the
  desktop client consumes.
- **Import discovery** — Hardened local import discovery and raw GitHub
  marketplace fallback paths.

## 1.1.6 - 2026-05-28

### Added

- **Claude Opus 4.8 support** — Added Anthropic registry metadata, pricing, prompt overlay, and default provider options for Claude Opus 4.8. Routed adaptive thinking through PI and overrode stale bundled PI catalog metadata so Opus 4.8 exposes verified 1M context and 128K output limits.

### Fixed

- **Desktop Codex App-Server startup** — Stopped packaging a bundled Codex app-server with desktop resources, cleaning up legacy codex-app-server binaries during resource builds. Prefer explicit overrides, then existing/downloaded managed installs, falling back to a system codex binary only after verification. Clarified managed-first resolution order in protocol and desktop documentation.

## 1.1.5 - 2026-05-28

### Fixed

- **Windows ARM64 desktop release smoke** — Stabilized the packaged sidecar bundle for Windows ARM64 by keeping bundled-runtime sidecar chunks unminified and avoiding generated multiline template separators in SQL helpers.
- **Packaged desktop startup** — Deferred source workspace launcher construction inside the web desktop service so packaged sidecars no longer try to resolve a repository checkout from `resources/binaries/server` during startup.

## 1.1.4 - 2026-05-28

### Added

- **Remote marketplace for curated plugins** — Default skills/plugins bootstrap now pulls from the remote `mweinbach/cowork-skills-plugins` marketplace on first run instead of a static built-in set. The plugins catalog surfaces remote entries with install/update/delete actions, sticky removal tombstones, and graceful fallback to cached details when the remote is transiently unavailable. Updated JSON-RPC protocol docs and shared materialization logic for GitHub/local plugin sources (`.cowork-plugin` / legacy `.codex-plugin` manifests).

### Changed

- **Desktop component and dependency footprint** — Comprehensive dead-code sweep removed ~7.4k lines (44 files, 35+ unused shadcn UI components, ~150 symbols, 20 npm packages). Added `bun run knip` guardrail (dead-code focused) to prevent regressions. Desktop now only ships the exact primitives and helpers it uses at runtime.

### Tests & Coverage

- Added targeted coverage for H3 mobile RPC permission gates, Codex app-server image steer/resume flows, and related image input handling.

### Internal

- CI speedups for Bun setup, various optimization passes, and maintenance merges.

## 1.1.3 - 2026-05-26

### Added

- **Continued development of experimental mobile app** — Expanded the Expo mobile
  app from pairing/setup work into a more complete companion experience,
  including native thread home screens, collapsible workspace/thread sections,
  load-more behavior, iOS-styled grouped rows, provider defaults, settings
  routes, workspace tabs, and app loading improvements.
- **Mobile remote workspace support** — Mobile can now bootstrap remote
  workspaces through the JSON-RPC control surface, hydrate thread lists, cache
  thread data for offline reads, and reconnect more reliably when the transport
  or app lifecycle changes.
- **Mobile pairing and remote access flow** — Desktop and mobile now expose a
  more complete remote-access pairing path with refreshed pairing state, QR/manual
  pairing screens, simulator pairing fallback hints, device-bound tickets,
  atomically consumed pairing nonces, and desktop-managed mobile device
  permissions.
- **Mobile thread reading polish** — Mobile thread screens now render richer feed
  items, activity groups, source carousels, inline markdown, horizontal rules,
  and improved tool/source formatting so remote sessions are easier to follow on
  a phone.

### Changed

- **Mobile onboarding and visual system** — Pairing and unconnected states were
  redesigned with native iOS-style grouped lists, glass action buttons, Expo
  glass header controls, theme/token fixes, and updated native iOS/Android
  project assets and permissions.
- **Remote access settings** — Desktop remote-access controls now persist the
  enabled state, surface current pairing/server status more consistently, and
  keep the desktop UI responsible only for exposing the harness/server controls.
- **Project setup documentation** — README setup instructions now use the actual
  repository clone URL, and mobile remote-access/pairing docs were updated to
  match the hardened pairing model.
- **Desktop settings layout** — macOS settings headers and back-button rows now
  align more consistently with the platform chrome and tokenized colors.

### Fixed

- **Chat feed scrolling** — The desktop chat view no longer forces the feed back
  to the bottom while a user is intentionally scrolling upward through history.
- **Archived thread preservation** — Workspace refreshes now preserve archived
  thread records instead of dropping them from the desktop thread list state.
- **Mobile transport resilience** — Mobile JSON-RPC and secure transport handling
  now survive Hermes error-object differences, reconnects, stale active-session
  restores, and pairing bootstrap races more reliably.
- **Mobile header and button behavior** — Fixed nested button markup in the
  mobile header glass menu and stabilized mobile header controls across thread,
  settings, workspace, and pairing screens.
- **Mobile app runtime compatibility** — Aligned Expo/React runtime versions,
  hardened LogBox setup, pruned generated native permissions, and fixed startup
  paths that could leave the mobile app stuck loading.

## 1.1.1 - 2026-05-22

### Fixed

- **Packaged workspace server startup** — Restores packaged desktop startup by
  loading the managed LibreOffice helper from real app resources, skipping
  read-only bundled skill mutation in packaged builds, and making release
  resource builds tolerate stale runtime-cache symlinks.

## 1.1.0 - 2026-05-22

### Added

- **Codex app-server runtime** — Codex CLI sessions now route through a bundled
  and managed `codex app-server` instead of hand-rolled token parsing and local
  credential plumbing. Desktop ships the app-server binary in sidecar resources,
  resolves system vs Cowork-managed installs at runtime, and delegates model
  catalog, auth, reasoning, titles, sandbox policy, and OpenAI native connector
  discovery/enablement to the app-server MCP surface.
- **Hybrid Codex tool boundary** — Keeps native app-server tool ownership while
  Cowork still supplies workspace-local tools where appropriate.
- **Antigravity provider** — New provider and runtime path for Gemini 3.5 Flash
  and Gemini 3.1 Pro, with provider-status setup and Google key fallback when
  Antigravity credentials are unavailable.
- **Managed LibreOffice (`soffice`) shim** — Cowork-managed headless LibreOffice
  for document, presentation, and spreadsheet workflows, with runtime env
  propagation across Antigravity, Codex app-server, and local tool execution.
- **Workspace canvas previews** — Presentation slide preview in the workspace
  canvas, plus JSON-RPC spreadsheet workbook snapshots and the desktop Univer
  spreadsheet canvas for CSV/XLSX editing without client-side file parsing.
- **Universal new chat landing** — Dedicated new-chat surface with model selector,
  one-off chat workspaces under `~/.cowork/chats/*`, sidebar section reordering,
  and project-scoped “new chat in project” flows on the existing JSON-RPC thread
  contract.
- **Multimodal attachment UX** — Upload progress in chat, attachment cards in the
  feed, and tighter Gemini media handling so binary tool results and transcripts
  stay out of the visible stream.
- **Direct H3 mobile pairing foundation** (#98) — Secure mobile-to-server pairing
  over H3 with auth coverage for remote admin flows.
- **MCP server enable toggles** — Per-server enable/disable controls in settings
  without removing saved MCP configuration.
- **Apple Foundation Models titles (macOS)** — On-device title generation via
  Apple Foundation Models when available, with varied prompts to reduce duplicate
  thread titles.
- **Fire Pass / Kimi K2.6** — Kimi K2.6 routing through the shared Fireworks
  inference stack (`firepass` provider).
- **Model registry additions** — Gemini 3.5 Flash (replacing the legacy ajax
  model), Claude Opus 4.6/4.7, and related catalog/pricing metadata updates.
- **CLI REPL quality-of-life** — Multi-line paste/input without data loss,
  auto-reconnect, and custom server port options.
- **Desktop platform chrome contract** — Native top-bar/caption behavior exposed to
  the renderer through IPC and CSS variables, with cross-platform tests for macOS,
  Windows, and Linux window chrome.
- **Sidebar persistence** — Remembers expanded/collapsed workspace sections in
  localStorage and caps visible recent chats to five with a scrollable expand
  affordance.

### Changed

- **Desktop UI migrated to shadcn/ui** (#100) — Replaced HeroUI with shadcn/ui as
  the desktop component system; updated AGENTS/CLAUDE guidance, tokens, and
  composition patterns accordingly.
- **Mobile design tokens** — Aligned Expo mobile palette, splash/adaptive icon
  background, and bundled IBM Plex fonts with the desktop shell.
- **Major harness refactors** — Split large runtime/server/desktop modules
  (`AgentSession`, `conversationProjection`, `codexPrimaryRuntime`,
  `managedSofficeRuntime`, `threadEventReducer`, Google interactions runtime,
  and related test suites) for clearer boundaries and faster maintenance.
- **Desktop startup/shutdown** — Parallelizes spawned workspace server shutdown
  during app exit.
- **Usage/pricing estimates** — Long-context and cache-write pricing estimates
  for supported providers; cumulative Codex app-server token accounting.
- **Dependency updates** — TypeScript, Expo/mobile deps, and compatible major
  runtime dependency bumps with CI/lint alignment.

### Fixed

- **Codex app-server reliability** — Auth expiry handling, pool reset after auth
  changes, model catalog reconciliation, settings forwarding, reasoning/title
  surfacing, and pinned `~/.cowork` auth home.
- **Gemini / Google Interactions** — Interaction ID preservation, stale
  continuation recovery, native code-execution handling, media re-read prevention,
  and runtime env refresh on provider changes.
- **Managed soffice** — Cross-platform LibreOffice startup, shell-command ordering,
  and runtime checks before control-session hydration.
- **Desktop UI** — Win32 platform chrome parity for chat and settings, canvas
  slide preview reload resilience, JSON-RPC reconnect handling, composer overlay
  spacing, sidebar title overflow, improved contrast/empty states, and Linux
  window background painting.
- **Workspace/settings correctness** — Project workspace settings no longer drop
  when stored on project records; hidden paths filtered from workspace maps to
  prevent Antigravity local-harness crashes.
- **Security & audit remediation** — Broad fixes from a 20-domain audit: hardened
  provider failure handling, tightened JSON-RPC session contracts, untrusted
  browser origin blocking, mobile release audit follow-ups, and related desktop
  shell lint/security cleanup.
- **Streaming/chat correctness** — Deduplicated assistant messages when streamed
  segments lack paragraph separators; completed tool activity stays terminal;
  reasoning timeline order preserved; recovered internal tool failures hidden from
  the feed.
- **CI and test stability** — Restored lint/tests/Android build lanes, hermetic
  Codex app-server resolver tests, isolated mobile Metro config dependencies,
  and expanded regression coverage for Bedrock, managed soffice, quick chat
  shortcuts, skill refresh bus, and H3 pairing auth.

## 0.1.48 - 2026-04-25

### Added

- **Experimental OpenAI native connectors** — Workspace-scoped ChatGPT apps
for Codex: discovery and enablement flow, synthetic `codex_apps` MCP
injection when enabled, JSON-RPC connector controls
(`cowork/connectors/*`), provider/MCP wiring for the OpenAI Responses
path, and an optional desktop settings page (behind
`COWORK_EXPERIMENTAL_OPENAI_NATIVE_CONNECTORS`, with `codex-cli` OAuth
required). Protocol and generated schema updates in
`docs/websocket-protocol.md`.
- **Desktop Deep Research workflow and exports** (#88) — Deep Research
flow in the desktop app with export handling and related IPC wiring.
- **GPT-5.5 model support** (#89) — Registry and runtime support for GPT-5.5.
- **Menu bar quick chat** (#87, Jason Cantor) — macOS menu bar and system tray
entry to Quick Chat, with the tray “utility” window split from the Quick Chat
popout so each surface keeps its own behavior. Global shortcut for Quick Chat
is registered only when the menu bar / tray feature is enabled; shortcut and
related controls live in Desktop feature settings. Popups use transparent
macOS window chrome so the rounded in-app card owns the corners (no dark frame
bleed), with narrowed popup sizing and follow-up fixes for popup lifecycle,
workspace persistence, tray shutdown, and “new chat” from the menu bar.
Shared shortcut resolution lives in `src/shared/quickChatShortcut.ts` with
cross-platform tests.

### Changed

- **Canonical JSON-RPC WebSocket** (#92) — JSON-RPC-lite on
`cowork.jsonrpc.v1` is the only supported live protocol; removed
`?protocol=` and server-side protocol default override so negotiation
matches a single wire contract.
- **Server/runtime structure** (#91) — Split large server runtime modules for
clearer boundaries and maintenance.
- **Developer harness package** (#93) — Split developer-oriented harness
code into `packages/harness`.
- **Cowork config namespace** — Normalized config namespace usage and related
documentation (companion to harness split).
- **Feature flags UX** — Feature flags are managed from Desktop settings
with updated tests; replaces the older standalone feature-flags page flow.
- **Task bar / Quick Chat icon** — Workspace-driven icon loading for the
task bar and quick chat chrome.
- **Backups opt-in** — Checkpoints/backups are opt-in rather than wired as a
default core behavior.
- **A2UI experiment gate** — A2UI is gated behind the experiment flag instead
of always on.
- **Skills refresh** — Refreshes skill metadata without background polling
(explicit actions, filesystem signals, or pre-turn checks).
- **Efficiency** — Miscellaneous performance and allocation improvements.

### Fixed

- **Desktop release publishing** — Tag-based desktop releases publish
correctly in the release workflow.

## 0.1.47 - 2026-04-21

### Fixed

- **Version bump** — Incremented package versions to 0.1.47.

## 0.1.46 - 2026-04-21

### Fixed

- **Windows ARM64 desktop release gating** — Stopped using a silent
installer execution on x64 GitHub runners as the release blocker for
ARM64 sidecar validation. The release workflow now verifies the
unpacked ARM64 desktop bundle directly and still requires the native
`windows-11-arm` smoke run before publish, avoiding false negatives
while keeping ARM64 packaged-sidecar coverage in the release lane.

## 0.1.45 - 2026-04-20

### Added

- **A2UI (Agent-to-UI) generative UI** — End-to-end support for
[Google's A2UI v0.9 protocol](https://a2ui.org/specification/v0.9-a2ui/).
Agents render rich, stateful UI surfaces directly in the main chat view
(forms, cards, tables, progress, etc.) instead of settling for plain
markdown.
  - New `a2ui` tool lets the agent emit v0.9 envelopes
  (`createSurface`, `updateComponents`, `updateDataModel`, `deleteSurface`).
  - Per-session `A2uiSurfaceManager` folds envelopes into a resolved
  surface and broadcasts a new `a2ui_surface` `SessionEvent` plus a
  `uiSurface` `ProjectedItem` through the existing conversation
  projection. Desktop + mobile render the surface inline in the feed.
  - Client → server action channel: the new
  `cowork/session/a2ui/action` JSON-RPC method routes button clicks,
  text-field submits, and checkbox toggles back to the agent as a
  structured steer (or fresh turn) so the model can update the surface.
  - Desktop renderer covers the v0.9 basic catalog — Text, Heading,
  Paragraph, Column, Row, Stack, Divider, Spacer, Card, List, Button,
  TextField, TextArea, Checkbox, Select, Link, ProgressBar, Badge,
  Table, Image — and supports the core client-side Functions subset
  (`if`, `not`, `eq`, `neq`, `and`, `or`, `concat`, `length`, `join`,
  `map`, `coalesce`).
  - Expand button pops a surface into a larger modal without leaving
  the feed.
  - Mobile (Expo) gains a read-only React Native renderer that keeps
  parity with the desktop basic catalog.
  - Enabled by default for all model providers that receive the standard
  built-in toolbelt. You can still disable it per config layer with
  `enableA2ui: false` or via `AGENT_ENABLE_A2UI=false`.
  - Bundled `skills/a2ui/SKILL.md` documents the envelope shape,
  supported components, Functions subset, and interaction contract for
  the agent. Full protocol reference in `docs/websocket-protocol.md`
  and architecture notes in `docs/a2ui.md`.
- **Desktop file preview modal** — In-app preview for workspace files
accessible from chat markdown links. Supports code files with syntax
highlighting and Word documents (DOCX) rendered with native page
chrome, inline (no nested iframe scrollbars), and full opacity on all
platforms. HTML is sanitized, in-flight reads can be aborted, and
Office lockfiles are hidden.
- **Persistent settings shell** — Desktop settings now use a persistent
shell with shared chrome context, platform-appropriate caption reserves,
native sidebar resize interaction, and full-width edge-to-edge
navigation buttons.
- **Full desktop browser mode** — Expose a complete desktop browser
surface with collapsible shell controls anchored to the topbar.
- **Workspace reordering** — Drag-and-drop and keyboard-driven workspace
reordering in the desktop sidebar.
- **Design skill docs** — Bundled `skills/design-taste-frontend/SKILL.md`
and `skills/high-end-visual-design/SKILL.md` for premium UI/UX
guidance.

### Changed

- **Desktop palette** — Retuned to warm olive tones with improved
settings navigation contrast, visible switch off-state thumbs, and
proper checkbox checked/unchecked distinction.
- **Typography** — Bundled IBM Plex Sans and Mono fonts for consistent
cross-platform rendering.
- **Fireworks tool schemas** — Relaxed JSON Schema constraints for
Fireworks tool calling compatibility, with fallback budgeting for
provider-safe schema variants.

### Fixed

- **Memory leaks & backpressure** — Fixed critical memory leaks and
WebSocket backpressure issues; added consolidation endpoints for
long-running sessions.
- **Desktop chat stalls** — Prevented silent chat stalls before runs
start and eliminated false-success exits in web desktop mode.
- **A2UI review follow-ups** — Preserved surfaces across rejected
overflow envelopes, enforced envelope byte caps, aligned Google A2UI
sessions with bounded surface state, and hardened web desktop preview
server pipes.

### Docs

- `docs/a2ui.md` — Phase 2/3 architecture, component table, Functions
subset, and roadmap follow-ups.

## 0.1.44 - 2026-04-15

### Added

- **Amazon Bedrock** (#74) — First-class Bedrock provider on the existing PI runtime path: structured auth methods (AWS default profile, named profile, explicit keys, API key), saved credentials without mutating process-wide AWS env, dynamic catalog/discovery with streaming-capable models only, desktop settings forms, and cache-first status polling so passive refreshes avoid repeated live discovery. Bedrock stays out of first-run onboarding until onboarding can handle structured auth; LM Studio and other provider refreshes no longer trigger unrelated Bedrock discovery.
- **Configurable search providers** — Choose Exa or Parallel for local `webSearch` and for HTML enrichment in `webFetch` (provider options), with `PARALLEL_API_KEY` / `EXA_API_KEY` resolution.
- **Parallel extract-backed `webFetch`** — Optional Parallel-based extract path for web fetch enrichment alongside Exa.
- **Bounded Workspace Map** (#76) — Depth- and size-limited directory name tree (no file contents) injected into system and subagent prompts after project instructions; skips noisy dirs (e.g. `node_modules`), sanitizes labels for markdown safety, and hardens syscalls (readdir + typed roots, no symlink directory escape).
- **Hierarchical `AGENTS.md`** (#77) — Walk from git root toward workspace root, prefer `AGENTS.override.md` per directory, cap rendered section at 32 KiB UTF-8, load into system and sub-agent prompts with fixes for nested loading and truncation order.
- **Active workspace context** — Workspace context included in turn prompts, with follow-up fixes for paths, git root detection, tool names, and macOS handling.

### Changed

- **Desktop tooling** — Upgraded the Electron app to Vite 8 and current Electron-related dev dependencies.
- **Prompt cleanup** (#78) — Reduced static prompt overhead by trimming cowork/workspace internals and deferring exact path details to runtime workspace context; aligned upload guidance with runtime behavior.
- **License** — Expanded `LICENSE` and wired `package.json` to `SEE LICENSE IN LICENSE`; README license section updated accordingly.

### Fixed

- **Gemini search / citations** — Preserved citation context across blocks, fixed search defaults, backfilled citation task metadata, and preserved overflow citation mappings across assistant message chunks.
- **Bedrock follow-ups** (#74) — Narrowed live discovery to Bedrock-specific flows, aligned ChatView provider display names with shared helpers, fixed derived catalog entries when backing models are non-streaming, and added regression coverage for profile wiring in discovery config.

### Docs

- README, `docs/architecture.md`, `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `GEMINI.md`, and `docs/custom-tools.md` — Aligned with current providers, JSON-RPC protocol, CLI commands, web search (Exa/Parallel), repository layout, and development commands.

## 0.1.43 - 2026-04-14

### Changed

- **Release / packaging** — Desktop release workflow updates and package manifest test adjustments for the 0.1.43 line.

## 0.1.42 - 2026-04-13

### Added

- **Plugin System** (#67) — Full plugin install management flow with desktop UI:
  - Plugin runtime foundation with MCP transport and scoped auth
  - Desktop plugin management UI with install, preview, enable/disable, and uninstall
  - Plugin-bundled skills and MCP server configs with scoped discovery
  - JSON-RPC control-plane events for real-time plugin state updates
  - Support for GitHub, local, and URL plugin sources
  - Hardened install validation, rollback, and symlinked bundle discovery
- **Child Agent Inspection** (#69) — `inspectAgent` tool for real-time child agent state inspection during orchestration
- **Explicit Child Agent Context Modes** (#70) — Configurable context modes for spawned child agents with dynamic role defaults from available subagent definitions
- **Parent Orchestration Guidance** (#73) — Strengthened parent child-agent orchestration with explicit coordinator rules, plan-mode explorer/worker/reviewer roles, and dynamic subagent role defaults

### Changed

- **Child-Agent Report Parsing** (#71) — Made child-agent reports parseable with explicit tagged footers, server-owned parsing module, and backward-compatible fallback for legacy plain/fenced JSON reports
- **Read-Only Shell Policy** (#72) — Comprehensive read-only shell enforcement:
  - Syntax-aware command tokenizer covering bash, fish, zsh, and sh
  - Detection of write operations through redirections, pipes, subshells, env/prefix commands, and package managers
  - Quote-aware redirect scanning to block quoted write targets without regressing benign inspection commands
  - Centralized shared parser as the single enforcement boundary
- **Child-Agent Wait Semantics** — StatusBus wait results now support explicit any/all semantics and always return the latest known status snapshot for every requested child. Default omitted mode is `any` with `readyAgentIds` for terminal subset consumers
- Removed legacy GPT-5 model entries and aliased persisted sessions to `gpt-5.4`
- Removed legacy external Codex auth import so Cowork now relies only on its own `~/.cowork/auth/codex-cli/auth.json` credentials

### Fixed

- **Child-Agent Snapshot Replay** — Multiple fixes for child-agent state replay during reruns:
  - Equal-timestamp follow-up status events now replace (not reject) existing snapshots during reruns
  - Newer child-agent states preserved during wait replay
  - Cached session snapshots preserved without task metadata
  - Predictable child-agent waits across timeout boundaries
- **Desktop** — Windows compatibility tweaks and ChatView update
- Fixed raw-loop child todo seeding for delegated agents
- Clarified provider mismatch errors for custom model IDs with better OpenAI-vs-Anthropic guidance

## 0.1.41 - 2026-03-30

### Fixed

- fixed mcp oauth

## 0.1.40 - 2026-03-30

### Fixed

- **Packaged Desktop Startup** — Fixed broken first-turn startup in the packaged desktop app (#66, @jasoncantor)
  - Replaced compile-unsafe packaged sidecar lazy loads in AgentSession with import-safe loaders
  - Removed remaining sync local manager requires that broke the first packaged turn path
  - Extended the desktop ARM64 release smoke to load the prompt and complete a real packaged first turn
  - This regression was caused by the startup performance optimization in 0.1.39 — credit to @jasoncantor for catching and fixing it

## 0.1.39 - 2026-03-30

### Changed

- **Startup Performance** — Major optimization to server startup and control bootstrap (#64):
  - Control bootstrap score improved 42.9% (3987 → 2278)
  - Packed bundle reduced from 3635 KB to 2195 KB
  - Server ready time reduced from 338ms to 68ms
  - Control bootstrap time reduced from 343ms to 71ms
- **Prompt Templates** — Converted system model prompts from markdown to JSON format for faster loading and deduplication
- **Runtime Schema Split** — Extracted `schema.sessionRuntime.ts` from session schemas for lazy loading
- **Session Bootstrap** — Fast-path for control session startup with lazy initialization of non-critical subsystems
- Fixed prompt readiness tracking so empty skill catalogs don't trigger reloads on every turn
- Fixed child session skill preservation across session boundaries
- **Desktop Composer** — Fixed busy composer hint overlapping footer controls (#65, @jasoncantor)
  - Dedicated status row for steering/streaming hints above the textarea
  - Composer footer now wraps properly on narrow layouts
  - Restored submit button color tokens (primary, warning, destructive)

## 0.1.37 - 2026-03-29

### Added

- **Mobile Remote Access** — Complete mobile companion app with secure relay transport (#63). **Developer-only feature** — available only in development builds, not in production releases. Features include:
  - X25519 encryption with secure envelope encoding for end-to-end encrypted relay
  - iOS/Android app built with Expo SDK 54 and React Native
  - Pairing flow with QR code and encrypted proof-of-pairing
  - Full workspace routing, thread management, and chat UI
  - Skills, memory, backup, and provider settings management
  - File upload and multimodal image support on mobile
  - Trusted device reconnect with persistent replay counters
- **Multimodal File Attachments** — Full support for file uploads and image attachments across desktop and mobile:
  - Native multimodal input format for OpenAI Responses runtime
  - File picker with drag-and-drop support
  - Attachment queuing and deduplication during steers
  - Symlink escape protection and upload validation
  - Per-message attachment queues preserved during reconnects
- **Fireworks AI Provider** — New provider with support for GLM-5, Kimi K2.5, Kimi K2.5 Turbo router, and MiniMax M2.5 models
- **HeroUI v3 Migration** — Complete desktop settings UI overhaul:
  - Reorganized settings into clearer Models & Tools groups
  - Tabulated workspace settings with improved MCP servers page
  - Inline accordion layout for better navigation
  - Save/success/error feedback patterns
  - Stronger auto-approve warnings
- **JSON-RPC WebSocket Transport** — New desktop control-plane architecture (#56):
  - Shared desktop control path for better state consistency
  - Improved replay ordering and reasoning stream handling
  - Deduplication of stale and late-streamed content
  - Proper segmenting of live and follow-up assistant output

### Changed

- Refactored desktop UI chrome and streamlined chat, skills, and sidebar flows (#59)
- Optimized harness and removed legacy WebSocket/TUI surfaces (#58)
- Default workspace JSON-RPC now uses current working directory (#61)
- Improved mobile relay recovery flows with better error handling
- Mobile app redesigned to match desktop theme with native iOS patterns
- Settings shell navigation polished with better pane divider layout

### Fixed

- Fixed JSON-RPC replay ordering and activity sequencing issues
- Fixed reasoning stream positioning to ensure it precedes tool calls
- Fixed desktop skill detail loading after state hydration
- Fixed Select popover width constraints and item row layout
- Fixed chat model selector to properly handle colon-separated model IDs
- Fixed mobile relay state after forget/reconnect cycles
- Fixed uploaded attachment handling with MIME type guards
- Fixed workspace root updates before relay cache invalidation
- Fixed desktop titlebar drag handling on Windows
- Stabilized electron mocks in full test suite
- Fixed keyboard send path for attachment-only steers

## 0.1.26 - 2026-03-18

### Added

- Added GPT-5.4 Mini model support in both OpenAI and Codex CLI model registries

### Fixed

- Fixed steering reconnect/cancel edge cases with improved continuation replay ordering
- Fixed protocol state drift on reconnect by preserving pending steer intent
- Fixed desktop thread-state regression paths during steering/onboarding work

## 0.1.25 - 2026-03-17

### Added

- Added full agent-control websocket and desktop messaging plumbing, including a new control-plane layer for steering and follow-up coordination across runtime and desktop flows.
- Added web search source visibility in the protocol and desktop state so tool results now retain richer provenance metadata (`source` events and related context).
- Added GPT-5.4 Mini model support in both OpenAI and Codex CLI model registries, including provider metadata and pricing updates.
- Added desktop-first onboarding flow so first-run desktop setup guidance appears automatically for new workspaces.

### Changed

- Enabled steering from the desktop chat composer while an active turn is in progress, with pending-steer state surfaced in the UI.
- Improved reconnect behavior so pending steers and active search prompts are preserved and replayed consistently after reconnect events.
- Updated runtime/session usage tracking so turn usage is preserved during steered continuation errors.

### Fixed

- Fixed steering reconnect/cancel edge cases, including continuation replay ordering and composer state cleanup after accept/clear operations.
- Fixed protocol state drift on reconnect by preserving pending steer intent and search prompt context in thread event reduction.
- Fixed desktop thread-state regression paths introduced during steering/onboarding work by tightening state updates and websocket reducer mapping.

## 0.1.23 - 2026-03-15

### Added

- **NVIDIA provider** — Added NVIDIA as a new provider with Nemotron 3 Super model support. Reasoning is forced on for NVIDIA requests with explicit token/reasoning budget fields stripped.
- **Together AI provider** — Added Together AI as a new provider with GLM-5, Kimi-K2.5, and Qwen3.5-397B model support, including image-input capability flags and pricing metadata.
- **SQLite-backed memory store** — Rewrote the memory system to use a SQLite database with full CRUD operations exposed in the desktop UI. Memory can be enabled/disabled globally, individual items have configurable scope, and system prompts auto-refresh when memory is modified via WebSocket.
- **User profile prompt context** — Users can now set profile information (name, role, organization, preferences) that gets conditionally injected into the system prompt. Editable from the TUI sidebar or desktop workspace settings.
- **Registry-backed model metadata and validation** — Centralized model registry (`src/models/registry.ts`) providing a single source of truth for model capabilities, pricing, and validation across all providers and UIs.
- **PR autosync workflow** — Added a GitHub Actions workflow that automatically syncs PR branches when main is pushed.

### Changed

- **Codex auth migrated to OpenAI Responses** — Moved Codex authentication and runtime handling onto the OpenAI Responses infrastructure. OAuth callbacks are now properly gated and deduplicated to prevent spurious auth errors from simultaneous authentication challenges.
- **Desktop settings UI overhaul** — Reorganized settings into clearer Models & Tools groups with tabulated workspace settings, improved MCP servers page with inline list and accordion layout, added save/success/error feedback patterns, stronger auto-approve warnings, and in-page thread selector on the Usage page.
- **Initial control session gating** — Desktop app now waits for the initial control session to be established before allowing operations, preventing race conditions on settings and memory operations at startup.

### Fixed

- **Missing model pricing metadata** — The runtime now gracefully handles models without local pricing metadata, preventing crashes when cost tracking is enabled. Zero-cost placeholder usage is stripped from persisted results.
- Removed obsolete agent browser skill from the desktop build.
- Fixed concurrent memory access issues with INSERT OR IGNORE for legacy imports and normalized `memoryRequireApproval` defaults throughout.
- Fixed profile validation to allow clearing fields by entering empty strings.

## 0.1.21 - 2026-03-12

### Fixed

- Fixed the macOS desktop auto-update path from `0.1.19` to `0.1.20` by disabling differential updater downloads on packaged macOS builds, forcing ShipIt to install from the full signed zip instead of a cached patched bundle that could fail code-sign validation.

## 0.1.20 - 2026-03-12

### Added

- Added a dedicated `cowork-server` release track with Bun-built macOS and Windows binaries plus a GitHub Actions workflow that publishes them from `cowork-server-v`* tags.
- Added OpenCode provider support for the harness, including the new OpenCode Zen path, shared provider metadata, and saved-key aware auth handling for compatible provider flows.
- Added file-spill handling for oversized tool output so long tool responses can be written to disk with consistent preview text across the runtime, desktop UI, and docs.

### Changed

- Reworked `webFetch` to route downloadable content into the workspace `Downloads` folder, use Exa-backed extraction for non-download content, and prefer saved Exa credentials when available.
- Updated provider and pricing metadata so usage-based OpenCode variants, model adapter wiring, and provider defaults are exposed consistently across the harness and desktop settings surfaces.
- Expanded desktop developer/provider settings and websocket protocol coverage to expose the new tool/provider behaviors more clearly.

### Fixed

- Fixed download path reservation so fetched files claim their destination safely instead of risking collisions or default-reset regressions.
- Fixed OpenCode routing, markdown-download handling, persistence edge cases, and overflow defaults that were causing inconsistent tool/provider behavior across desktop and runtime flows.
- Fixed the observability health schema TypeScript regression and isolated the TUI socket lifecycle test double so the websocket/REPL suite no longer flakes during release validation.

## 0.1.19 - 2026-03-11

### Added

- Added a recovery-focused backup workflow across the harness and desktop app. Workspaces can now browse backup history, inspect checkpoint file deltas, restore originals or checkpoints, delete whole backup entries, and reveal backup folders from the Backup settings page.
- Added workspace/session backup controls for disabled backups, whole-entry deletion, and seeded initial checkpoints so new sessions start with a recoverable baseline instead of waiting for the first manual checkpoint.

### Changed

- Reworked the desktop sidebar into a denser workspace-first layout with explicit expand controls, drag-and-drop workspace reordering, and a default cap of the 10 most recent threads per workspace with an overflow affordance.
- Refined the desktop composer so send and stop have distinct visual treatments, and the stop action remains available while a run is active.
- Made developer-mode diagnostics consistent between live sessions and transcript replay for observability, harness-context, and backup-status system notices.

### Fixed

- Fixed Codex auth persistence so desktop restarts no longer make recoverable Cowork-owned auth look lost after refresh failures or cross-process token races.
- Fixed Cowork auth recovery so valid Codex credentials persisted in the Cowork auth store are preserved instead of leaving users unexpectedly signed out.
- Fixed the desktop Backup settings page freeze-on-open loop by stabilizing its initial refresh path.
