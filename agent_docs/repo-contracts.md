# Repo-Specific Contracts

Invariants that have bitten us before. Load this file when touching the named subsystem. UI-specific patterns live in `desktop-ui.md` / `mobile-ui.md`; review checklists live in `code-review-rules.md`.

Each rule lists its key references — start there before editing.

## Platform & runtime

- **Platform boundary ratchet**: new code and tests must not introduce raw `process.platform`, `os.homedir()`, `os.tmpdir()`, `Bun.which`, or equivalent platform branching outside `src/platform/` and its sanctioned test helpers. Use the helpers in `src/platform/`, run `bun run test -- test/platform-boundary.test.ts`, and only regenerate `test/platform-boundary.baseline.json` when counts shrink; never expand the baseline to admit a new offender.
  - References: `src/platform/` (`paths.ts`, `exec.ts`, `fs.ts`, `host.ts`, `proc.ts`, `shell.ts`), `test/platform-boundary.test.ts`, `test/platform-boundary.baseline.json`
- **Bun channel and macOS test bootstrap**: `.bun-version` tracks Bun's rolling `canary` channel. Run tests through `bun run test` (or `bun run test -- <paths>`) so complete macOS runs execute each test file in a fresh process, isolating module mocks and native-addon lifetimes that Bun canary otherwise retains. Keep Windows and Linux on the direct `bun test` invocation inside the wrapper, and route CI/release lanes through the project command.
  - References: `.bun-version`, `scripts/run_tests.ts`, `.github/workflows/ci.yml`
- **Bun-compiled sidecars**: never read `package.json` via runtime `__dirname` paths — compiled binaries run from `/$bunfs`. Use bundled imports or build-time injection.
  - References: `scripts/build_cowork_server_binary.ts`, `scripts/build_desktop_resources.ts`
- **Windows sandbox setup state is shared between Cowork's two homes only**: the Codex Windows sandbox engine (vendored `cowork-win-sandbox` and the managed `codex-app-server` alike) stores per-home setup state (`<home>/.sandbox/setup_marker.json`, `<home>/.sandbox-secrets/sandbox_users.json`) but drives machine-global `CodexSandboxOffline/Online` accounts whose passwords every full setup resets. Multiple homes provisioning independently clobber each other's stored credentials. `syncCodexWindowsSandboxSetupState()` keeps `~/.cowork` and the app-server's `~/.cowork/auth/codex-cli` converged (newest-wins) so neither Cowork-spawned engine ever triggers a password-resetting full re-setup over the other; the pooled app-server client runs it before spawn, and the managed install ships version-matched `codex-command-runner`/`codex-windows-sandbox-setup` siblings so the app-server never resolves foreign helpers via PATH. The native Codex home (`~/.codex`) is NEVER read or written by this machinery — foreign setup state must not leak into the Cowork-managed runtime (a version- or proxy-skewed marker would trigger the very full setup the sync prevents, and a broken-but-newer state would overwrite a working one). When a native Codex install re-provisions the shared accounts, Cowork's own one-time setup repair is the intended recovery, never importing `~/.codex` state.
  - References: `src/platform/sandbox/windowsSetupSync.ts`, `src/providers/codexAppServerClient.ts`, `src/providers/codexAppServerResolver.ts`, `crates/cowork-win-sandbox/`

## Auth, config & persistence

- **Auth home**: `~/.cowork` is the only auth home. Never derive auth from a workspace `.agent` path. Pin `HOME` in tests that fabricate auth state.
- **Codex auth**: lives only at `~/.cowork/auth/codex-cli/auth.json`. No copies, restores, or fallbacks to other tool stores.
- **Canonical config roots**: `.cowork/` and `~/.cowork/` are the only runtime config/skills/memory/MCP namespaces; support legacy `.agent` only through an explicit one-time migration command, not permanent dual lookups.
  - References: `src/connect.ts` (path resolution), `src/config.ts` (three-tier merge: built-in `config/defaults.json` → user `~/.cowork/config/config.json` → project `.cowork/config.json`, env vars override all)
- **Workspace settings**: any new field must round-trip through `PersistenceService.sanitizeWorkspaces()` — partial sanitizer updates silently drop fields on save/load. Audit every new field, not just the headline one.
  - References: `apps/desktop/electron/services/persistence.ts`
- **Workspace settings target**: settings controls must render and mutate the same workspace class; hidden `oneOffChat` records should not back project default controls.
- **Chat target pickers**: settings and memory target pickers should collapse all non-project `oneOffChat` records into one `Chats` target, while project workspaces still appear individually.
- **Chat target labels**: apply the same `Chats` grouping to every settings/metadata workspace picker or label that represents hidden one-off chat workspaces; do not fix only the currently visible page.
- **Checkpoints/backups**: keep backups and checkpoints opt-in; prefer git-native worktrees/stash/diffs for git workspaces and manual snapshots for non-git workspaces over auto-wired core backup flows.
- **Three-tier inherit semantics**: never overload `undefined` for both "no-op" and "inherit"; add a dedicated clear/inherit path end-to-end so reset-to-default deletes persisted overrides instead of pinning the current built-in.
- **OAuth**: never share one constant between listener bind host and advertised redirect host. Bind both `::1` and `127.0.0.1` when using `localhost`. Pin the production redirect URI to the provider-accepted host and cover the advertised URL in tests.
  - References: `src/mcp/` (OAuth provider + auth store), `src/auth/`

## JSON-RPC protocol & projection

- **JSON-RPC projector**: item IDs must be occurrence-stable within a turn. Always forward `itemId` on `item/agentMessage/delta`. Close the current assistant item before reasoning/tool phases. Don't key assistant items only by `turnId`.
  - References: `src/server/jsonrpc/notificationProjector.ts`, `src/server/jsonrpc/projectorShared.ts`, `src/server/runtime/ThreadJournal.ts`, tests under `test/jsonrpc/projectors/`
- **Optimistic chat sends**: preserve `clientMessageId` through `turn/start`/`turn/steer` and the projected `item/userMessage` notifications, or duplicate user bubbles render.
  - References: `src/server/jsonrpc/routes/turn.ts`, `test/jsonrpc/projectors/`
- **Thread reasoning state**: reasoning-effort changes in an existing chat are thread-owned preferences. Persist them on the thread, preserve them across navigation/reconciliation/restart, and clear them only when the thread's model changes to a potentially incompatible reasoning contract.
  - References: `src/models/threadReasoningOptions.ts`

## Tools, providers & models

- **Thread-tool and H3 permissions**: enforce H3 permissions before dispatch and keep the permission table plus `test/h3.mobile-http-jsonrpc.test.ts` aligned. Thread-management tools are root-session capabilities by default; do not expose them to worker, scoped-path, child-agent, or task sessions. Preserve the required `conversations` and `turns` gates and cover eligibility changes in `test/tools/tools.createTools.test.ts`.
  - References: `test/h3.mobile-http-jsonrpc.test.ts`, `test/tools/tools.createTools.test.ts`, `src/tools/index.ts`
- **Tool prompt guidance**: use actual callable tool IDs (`bash`, `glob`, `grep`); generic names like `shell`/`search` route the model into nonexistent calls.
  - References: `src/tools/index.ts` (`createTools` tool map keys), `prompts/`
- **New provider**: audit every provider-gated tool factory in `src/tools/` and add a `createTools(...)` regression — missing branches crash PI tool mapping before the turn starts.
  - References: `src/tools/index.ts`, `src/providers/`, `test/tools/tools.createTools.test.ts`
- **MCP tool schemas**: normalize tuple-style JSON Schema arrays (`items: [{...}, {...}]`) to provider-safe object/boolean nodes before registration; OpenAI-compatible runtimes reject otherwise.
  - References: `src/mcp/`
- **Model tool defaults**: normalize provider-emitted `null` for optional/defaulted tool fields before validation; a recoverable tool-input mismatch must not cascade into an unrecoverable provider continuation.
- **Tool output overflow**: spill-to-workspace truncation is the default; the `skill` tool and every `read` result are exempt so complete `SKILL.md` instructions, references, and script source stay inline.
  - References: `src/tools/`
- **Generic plumbing, host-specific adapters**: when building plumbing for a model, provider, tool, capability, or service integration, abstract it generically so every host can reuse it — never hand-roll a one-off path tied to a single host that we then have to recreate for the next one. Keep a host-agnostic core that each host pipes into, and isolate only the genuinely host-specific bits (auth shape, wire format, transport) behind a thin adapter. If the next host needs a copy-paste of the whole pipeline, the abstraction is wrong. Example: model caching for reasoning tiers on Codex CLI should be a generic `ModelCache` service that the app server reads once for all hosts, with each host contributing a small cache-key/serialization adapter — not a Codex-CLI-only cache we then have to re-implement for OpenAI, Anthropic, Bedrock, etc. Same rule applies to tool registration, token counting, image-input handling, provider options, rate-limiting, retries, and prompt-template resolution: build the generic pipeline once, plug each host in behind an interface.
- **Exec-wrapped tool metadata**: treat `exec` as a generic nested-tool envelope. Preserve and normalize citation/source metadata from every nested tool and supported output wrapper; never special-case one nested tool such as `web.run` when the payload contract is shared.

## Skills & the unified runtime

- **Runtime and skill ownership**: marketplace-installed project/user skills are the authoritative skill content. The unified runtime is a separately downloaded executable/library layer and must never be registered as a plugin or skill discovery root; the application updates both layers independently.
- **Productivity skill parity**: retiring bundled productivity skills requires migrating the complete documents, PDF, presentations, and spreadsheets set into the authoritative marketplace plugin; never drop PDF as an incidental part of a runtime cutover.
- **Unified runtime completeness**: before deleting a legacy runtime manager, inventory and migrate every executable it owns—especially LibreOffice/`soffice` and companion files—and prove the installed unified runtime can execute the real workflow. Do not silently leave a second lazy-download cache behind.
- **Managed soffice boundary**: ship LibreOffice inside the unified runtime, keep its private program directory off `PATH`, and expose only Cowork's headless policy launcher. The launcher must reject UI/printing modes, disable printer detection, use disposable profiles, and pass a real conversion test; never fall back to host `soffice`.
  - References: `scripts/setup_cowork_runtime.ts`, `skills/`
- **Skill refreshes**: avoid background polling for skill metadata; refresh on explicit UI/server actions, `fs.watch` notifications, or before turns when skill directory mtimes changed.
  - References: `src/skills/`

## Task mode

- **Chat plans vs Task mode**: never present a standard-chat `todoWrite` checklist as durable task state or expand it into a second task system. Label it as a plan/checklist; keep durable IDs, transitions, ownership, blockers, artifacts, and user editing in `TaskCoordinator` and Task mode.
- **Chat-to-task promotion**: task mode is a one-shot harness tool and `/task` skill handoff from ordinary chat. Require a complete brief and dependency-aware initial plan before creation, lock the source chat while the task is active, and keep lifecycle/state enforcement in the coordinator rather than the desktop UI.
- **Task review rounds**: treat `reviewRounds` as the required minimum, never as a hard stop. Let the task agent request additional fresh independent rounds when risk or uncertainty warrants them, subject only to the explicit safety cap.
  - References: `src/server/tasks/TaskCoordinator.ts`, `src/server/jsonrpc/routes/tasks.ts`, `skills/task/`

## Accessibility & theming

- **Contrast consumer paths**: when adding accessible foreground/background tokens, trace them through each platform theme adapter into rendered controls and test that consumer path; token-pair contrast tests alone are insufficient. Use explicit arbitrary Tailwind values for nonstandard ring widths, and map high-contrast selected/focus states to the system `Highlight`/`HighlightText` pair.
  - References: `apps/desktop/src/styles.css`

## Misc UI-adjacent

- **Settings toggles**: shared `Switch` for binary on/off; reserve `Checkbox` for checklist selection.
- **Codex app-server verification**: app-server supports multiple simultaneous instances; parallelize independent app-server checks instead of serializing model/status/title probes by default.
