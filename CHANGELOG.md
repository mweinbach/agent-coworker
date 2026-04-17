# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

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

- Added a dedicated `cowork-server` release track with Bun-built macOS and Windows binaries plus a GitHub Actions workflow that publishes them from `cowork-server-v*` tags.
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
