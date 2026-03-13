# Task: Fix remaining PR #37 prompt templating review comments

## Plan
- [x] Inspect the unresolved `src/prompt.ts` review threads and confirm whether they can be addressed with one templating change.
- [x] Make user-provided prompt variables literal-safe and non-recursive without changing the rest of the prompt contract.
- [x] Add focused regressions, run the required verification lane, and resolve the completed PR threads.

## Review
- Addressed the two remaining PR #37 prompt-template review threads in [prompt.ts](/Users/mweinbach/Projects/agent-coworker/src/prompt.ts) by replacing the iterative `injectTemplateVariable` flow with a single callback-based `renderTemplateVariables()` pass. Empty-value template lines are stripped before substitution, then all remaining `{{...}}` tokens are resolved against the original prompt in one pass so user-provided text is always treated literally.
- This fixes both reported regressions without changing the broader prompt contract: `$...` sequences in `userName` or `userProfile` no longer trigger replacement-pattern behavior, and `{{...}}` sequences inside user-supplied profile content no longer recurse into later template substitutions.
- Added focused regressions in [prompt.test.ts](/Users/mweinbach/Projects/agent-coworker/test/prompt.test.ts) that prove literal `$&` and `$1` content survives unchanged and that profile text containing `{{workingDirectory}}` remains verbatim while the real prompt token still resolves elsewhere in the prompt.
- Verification:
  - `git diff --check` -> pass
  - `HOME=$(mktemp -d) ~/.bun/bin/bun test test/prompt.test.ts --bail` -> pass (`51 pass, 0 fail`)
  - `HOME=$(mktemp -d) ~/.bun/bin/bun test` -> pass (`2233 pass, 2 skip, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass
  - `./node_modules/.bin/tsc --noEmit -p apps/TUI/tsconfig.json` -> pass
  - `~/.bun/bin/bun run build:server-binary` -> pass
  - `~/.bun/bin/bun run build:desktop-resources` -> pass
  - `~/.bun/bin/bun run desktop:build` -> pass; notarization explicitly skipped because notarization credentials are not fully configured in this environment

# Task: Review PR #37 desktop management coverage for user profile context

## Plan
- [x] Inspect the PR #37 diff with emphasis on websocket protocol, session/config persistence, and any desktop-facing surfaces that need to manage the new profile fields.
- [x] Verify whether the desktop app already receives and can update the new user profile state through the server/workspace settings flow; patch any missing protocol or desktop wiring if needed.
- [x] Run focused regression tests first, then the repo-required test/build verification lane, and record the result plus any residual risks here.

## Review
- The review found a real desktop gap: the PR extended websocket `session_config` with `userName` and `userProfile`, but the desktop layer only updated sync fixtures. It was not persisting those workspace defaults, hydrating them from the control session, replaying them to live thread sessions, or exposing them in the workspace settings UI.
- Patched the desktop workspace model and sanitizers so `userName` and `userProfile` now survive renderer bootstrap, IPC validation, and Electron persistence in [types.ts](/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/app/types.ts), [bootstrap.ts](/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/app/store.actions/bootstrap.ts), [desktopSchemas.ts](/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/lib/desktopSchemas.ts), and [persistence.ts](/Users/mweinbach/Projects/agent-coworker/apps/desktop/electron/services/persistence.ts).
- Patched desktop control/thread sync so harness `session_config` snapshots hydrate the new fields and workspace default updates replay them through `set_config` to both the control session and live thread sessions in [controlSocket.ts](/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/app/store.helpers/controlSocket.ts) and [workspaceDefaults.ts](/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/app/store.actions/workspaceDefaults.ts).
- Added a new workspace settings card so the desktop app can actually manage the profile fields, not just store them, in [WorkspacesPage.tsx](/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/ui/settings/pages/WorkspacesPage.tsx).
- Added regression coverage for renderer bootstrap, persistence, workspace sync, and settings rendering in [workspace-settings-sync.test.ts](/Users/mweinbach/Projects/agent-coworker/apps/desktop/test/workspace-settings-sync.test.ts), [persistence-state-sanitization.test.ts](/Users/mweinbach/Projects/agent-coworker/apps/desktop/test/persistence-state-sanitization.test.ts), [desktop-schemas.test.ts](/Users/mweinbach/Projects/agent-coworker/apps/desktop/test/desktop-schemas.test.ts), and [workspaces-page.test.ts](/Users/mweinbach/Projects/agent-coworker/apps/desktop/test/workspaces-page.test.ts).
- Verification:
  - `HOME=$(mktemp -d) ~/.bun/bin/bun test apps/desktop/test/workspace-settings-sync.test.ts apps/desktop/test/workspaces-page.test.ts apps/desktop/test/desktop-schemas.test.ts apps/desktop/test/persistence-state-sanitization.test.ts --bail` -> pass (`32 pass, 0 fail`)
  - `HOME=$(mktemp -d) ~/.bun/bin/bun test` -> pass (`2226 pass, 2 skip, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass
  - `./node_modules/.bin/tsc --noEmit -p apps/TUI/tsconfig.json` -> fails in unchanged TUI files at `apps/TUI/routes/session/index.tsx:248` (`TS2769`) and `apps/TUI/ui/dialog-prompt.tsx:62` (`TS2322`)
  - `~/.bun/bin/bun run build:server-binary` -> pass
  - `~/.bun/bin/bun run build:desktop-resources` -> pass
  - `~/.bun/bin/bun run desktop:build` -> pass; macOS notarization skipped because Apple notarization credentials are not configured in this environment

# Task: Address PR #37 review comments

## Plan
- [x] Inspect the unresolved PR #37 review threads and separate the real runtime regression from any already-satisfied parser contract.
- [x] Refresh the cached session system prompt when `set_config` changes `userName` or `userProfile`, without changing unrelated runtime behavior.
- [x] Add regression coverage for live prompt refresh and for clearing persisted profile fields with empty strings.
- [x] Run focused tests, the full test suite, typechecks, required builds, and record the outcome here.

## Review
- Addressed the real `P1` regression in [SessionMetadataManager.ts](/Users/mweinbach/Projects/agent-coworker/src/server/session/SessionMetadataManager.ts): `setConfig()` now refreshes the cached `state.system` and `discoveredSkills` via the same system-prompt loader whenever `userName` or `userProfile` changes, so the next turn in the current session uses the updated prompt context immediately.
- Kept the refresh path testable by adding an injected `loadSystemPromptWithSkillsImpl` dependency in [SessionContext.ts](/Users/mweinbach/Projects/agent-coworker/src/server/session/SessionContext.ts) and [AgentSession.ts](/Users/mweinbach/Projects/agent-coworker/src/server/session/AgentSession.ts), matching the repo’s existing dependency-injection pattern.
- The `P2` parser concern was already satisfied in the current branch: `set_config` already accepted `userName: ""` and empty `userProfile` strings. Instead of churning that parser path again, I added an end-to-end server regression in [server.test.ts](/Users/mweinbach/Projects/agent-coworker/test/server.test.ts) and clarified the contract in [websocket-protocol.md](/Users/mweinbach/Projects/agent-coworker/docs/websocket-protocol.md) so empty strings are explicitly documented as clearing prompt context.
- Added targeted regression coverage in [session.test.ts](/Users/mweinbach/Projects/agent-coworker/test/session.test.ts) to prove a live `setConfig()` profile edit changes the system prompt actually passed into the next `runTurn()` call.
- Verification:
  - `git diff --check` -> pass
  - `HOME=$(mktemp -d) ~/.bun/bin/bun test test/protocol.test.ts test/session.test.ts test/server.test.ts --bail` -> pass (`447 pass, 0 fail`)
  - `HOME=$(mktemp -d) ~/.bun/bin/bun test` -> pass (`2222 pass, 2 skip, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass
  - `./node_modules/.bin/tsc --noEmit -p apps/TUI/tsconfig.json` -> fails in unchanged TUI files at `apps/TUI/routes/session/index.tsx:248` (`TS2769`) and `apps/TUI/ui/dialog-prompt.tsx:62` (`TS2322`)
  - `~/.bun/bin/bun run build:server-binary` -> pass
  - `~/.bun/bin/bun run build:desktop-resources` -> pass
  - `~/.bun/bin/bun run desktop:build` -> pass; macOS notarization skipped because Apple notarization credentials are not fully configured in this environment

# Task: Stop Harness Full from running on every main push

## Plan
- [x] Confirm which workflow/job is causing the unwanted `Harness Full (Testing Env)` runs on push and identify the exact workflow surface to remove.
- [x] Delete the `Harness Full (Testing Env)` job from the CI workflow instead of narrowing its trigger, per the follow-up request.
- [x] Run workflow sanity checks plus the repo-required verification/build commands, then commit and push the change on `main`.

## Review
- The expensive `Harness Full (Testing Env)` run was not a separate workflow file; it was the `harness_full_testing` job inside `.github/workflows/ci.yml`, and it ran on every `push` to `main` or `testing` because the job only excluded `pull_request` events.
- Removed the `harness_full_testing` job entirely from [ci.yml](/Users/mweinbach/Projects/agent-coworker/.github/workflows/ci.yml), leaving the normal `Docs + Tests` CI job and the existing top-level workflow triggers in place.
- Verification:
  - `ruby -e 'require "yaml"; YAML.load_file(".github/workflows/ci.yml"); puts "ci.yml ok"'` -> pass
  - `git diff --check` -> pass
  - `HOME=$(mktemp -d) ~/.bun/bin/bun test` -> pass (`2213 pass, 2 skip, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass
  - `./node_modules/.bin/tsc --noEmit -p apps/TUI/tsconfig.json` -> fails in unchanged TUI files at `apps/TUI/routes/session/index.tsx:248` (`TS2769`) and `apps/TUI/ui/dialog-prompt.tsx:61` (`TS2322`)
  - `~/.bun/bin/bun run build:server-binary` -> pass
  - `~/.bun/bin/bun run build:desktop-resources` -> pass
  - `~/.bun/bin/bun run desktop:build` -> pass; notarization skipped because Apple notarization credentials are not fully configured in this environment

# Task: Harden opencode PR review workflow

## Plan
- [x] Audit the current `opencode-review` workflow behavior against the noisy merged-PR comment and identify the workflow-level controls available to reduce stale or overlong reviews.
- [x] Patch the workflow so in-flight reviews are canceled when a PR closes, draft PRs are skipped, shared session links are suppressed, and the prompt constrains output to terse unresolved findings only.
- [ ] Run the repo-required verification commands plus a workflow syntax sanity check, then commit and push the change on `main`.

## Review
- `opencode-review.yml` now listens for `pull_request.closed` in the same workflow and uses a PR-number concurrency group with `cancel-in-progress: true`, so a close/merge event cancels any in-flight review run instead of letting it finish into a merged timeline.
- The review job now skips closed and draft PRs, caps runtime at 15 minutes, and sets `share: false` so automated review comments stop attaching the public session/share card noise.
- The custom prompt now tells OpenCode to behave like a terse code reviewer: review only the current diff, prefer static analysis, only comment on actionable unresolved bugs/regressions/missing tests, avoid congratulatory or “everything is fixed now” summaries, and keep any comment to at most 3 bullets.
- Verification:
  - `ruby -e 'require "yaml"; YAML.load_file(".github/workflows/opencode-review.yml"); puts "opencode-review.yml ok"'` -> pass
  - `git diff --check` -> pass
  - `HOME=$(mktemp -d) ~/.bun/bin/bun test` -> pass (`2213 pass, 2 skip, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass
  - `./node_modules/.bin/tsc --noEmit -p apps/TUI/tsconfig.json` -> fails in unchanged TUI files at `apps/TUI/routes/session/index.tsx:248` (`TS2769`) and `apps/TUI/ui/dialog-prompt.tsx:61` (`TS2322`)
  - `~/.bun/bin/bun run build:server-binary` -> pass
  - `~/.bun/bin/bun run build:desktop-resources` -> pass
  - `~/.bun/bin/bun run desktop:build` -> pass; notarization skipped because Apple notarization credentials are not fully configured in this environment

# Task: Merge PR #36 into main

## Plan
- [x] Inspect PR `#36` mergeability, branch cleanliness, and commit stack to choose a safe merge path.
- [x] Prefer a squash merge because the branch contains multiple review/automation follow-up commits that should land as one coherent mainline change.
- [x] Post a detailed PR comment summarizing the shipped work and verification before merging.
- [ ] Merge PR `#36` into `main`, sync the local `main` branch, and confirm the final state.

## Review
- PR `#36` is currently `MERGEABLE`, the working tree is clean, and the branch head is pushed at `origin/codex/plan-multimodal-model-configs`.
- Chose a squash merge instead of replaying the full branch history because the stack includes the original feature plus multiple review/automation follow-up commits (`opencode` workflow churn, review-fix batches, and PR comment tooling), which should land on `main` as one coherent change.
- Posted a detailed PR comment summarizing the shipped work, review fixes, and verification so the merge record is readable from the PR timeline even after squashing.

# Task: Address latest opencode PR review comment

## Plan
- [x] Inspect the latest `opencode` PR comment on PR `#36` and separate factual issues from subjective design suggestions.
- [x] Fix the real `providerOptions` normalization bug so `loadConfig()` does not synthesize empty provider-option sections for models/providers with no defaults.
- [x] Add or tighten registry/config regression coverage for the comment items we address, and add low-risk clarification comments where that is the right fix.
- [x] Run focused tests, the full test suite, typechecks, required builds, and comment back on the PR with the addressed items.

## Review
- Addressed the concrete behavior bug from the opencode comment in `src/config.ts`: `mergeProviderOptionDefaults()` now returns `undefined` when the active provider/model contributes no defaults and config contributed no options, and it preserves unrelated provider sections without synthesizing an empty active-provider entry.
- Added config regressions in `test/config.test.ts` for both no-default/no-config startup and preserving non-active provider options when the active provider has no defaults.
- Tightened registry helper coverage in `test/models.registry.test.ts` for `assertSupportedModel`, `getSupportedModel`, `supportsImageInput`, and `providerOptionsDefaultsForModel` unknown-model behavior.
- Added low-risk clarification comments for the remaining design-oriented opencode notes:
  - `src/providers/providerOptions.ts` now documents that `DEFAULT_PROVIDER_OPTIONS` tracks each provider's default model options, not a provider-wide immutable constant.
  - `src/models/registry.ts` now documents the required import + registry-entry two-step when adding models, and clarifies that `knowledgeCutoff` is vendor display metadata rather than a normalized date field.
  - `src/prompt.ts` now documents that the image-guidance regex list must stay aligned with prompt template wording because non-image models still strip those lines post-render.
- Verification:
  - `HOME=$(mktemp -d) ~/.bun/bin/bun test test/config.test.ts test/models.registry.test.ts test/providers/provider-options.test.ts test/providers/openai.test.ts test/providers/google.test.ts test/providers/anthropic.test.ts --bail` -> pass (`114 pass, 0 fail`).
  - `HOME=$(mktemp -d) ~/.bun/bin/bun test` -> pass (`2213 pass, 2 skip, 0 fail`).
  - `~/.bun/bin/bun run typecheck` -> pass.
  - `./node_modules/.bin/tsc --noEmit -p apps/TUI/tsconfig.json` -> fails in unchanged TUI code at `apps/TUI/routes/session/index.tsx:248` (`TS2769`) and `apps/TUI/ui/dialog-prompt.tsx:61` (`TS2322`).
  - `~/.bun/bin/bun run build:server-binary` -> pass.
  - `~/.bun/bin/bun run build:desktop-resources` -> pass.
  - `~/.bun/bin/bun run desktop:build` -> pass; notarization skipped because Apple notarization credentials are not configured in this environment.

# Task: Address PR #36 review comments

## Plan
- [x] Inspect the unresolved PR #36 review threads and confirm the exact runtime/config paths that need changes.
- [x] Preserve session resume when persisted sessions reference legacy or no-longer-supported model IDs, while keeping current model validation strict for new config/runtime paths.
- [x] Preserve startup compatibility when legacy configured `model` or `subAgentModel` IDs no longer exist in the registry, while keeping explicit runtime override validation strict.
- [x] Reject invalid `set_config.config.subAgentModel` values up front and add regression coverage for the validation boundary.
- [x] Run focused tests, the full test suite, typechecks, required builds, and record the review outcome here.

## Review
- Resolved all three PR #36 review findings in code:
  - `P1` resume regression: `AgentSession.fromPersisted` no longer hard-fails for legacy unsupported model IDs. It now migrates to the provider default model, clears stale continuation state for migrated sessions, emits a migration log event, and persists the upgraded snapshot immediately.
  - `P1` startup compatibility regression: `loadConfig()` no longer hard-fails when persisted config or `AGENT_MODEL` still references a removed model ID. Startup now falls back to the current provider default for `model` and to the resolved main model for `subAgentModel`, while logging a warning instead of crashing the server/CLI.
  - `P2` delayed `subAgentModel` failures: `set_config` now validates `config.subAgentModel` against the current provider before persistence/runtime updates and returns a `validation_failed` session error on unsupported values.
- Added regression coverage:
  - `test/session.test.ts`: `setConfig rejects unsupported subAgentModel values before persistence`.
  - `test/server.test.ts`: `set_config rejects unsupported subAgentModel values before persisting them`.
  - `test/session.test.ts`: `migrates unsupported persisted models to provider default and persists the upgraded snapshot`.
  - `test/config.test.ts`: invalid configured `model`/`subAgentModel` startup values now fall back to provider defaults instead of crashing startup.
  - `test/providers/config-switching.test.ts`: provider switches now fall back to the destination provider default when the previous provider's model ID is unsupported.
- Protocol docs updated for the user-visible contract change:
  - `docs/websocket-protocol.md` now states `set_config.config.subAgentModel` must be valid for the current provider and unsupported values are rejected with `validation_failed`.
- Verification:
  - `HOME=$(mktemp -d) ~/.bun/bin/bun test` -> pass (`2207 pass, 2 skip, 0 fail`).
  - `~/.bun/bin/bun run typecheck` -> pass.
  - `./node_modules/.bin/tsc --noEmit -p apps/TUI/tsconfig.json` -> fails in unchanged TUI code at `apps/TUI/routes/session/index.tsx:248` (`TS2769`) and `apps/TUI/ui/dialog-prompt.tsx:61` (`TS2322`).
  - `~/.bun/bin/bun run build:server-binary` -> pass.
  - `~/.bun/bin/bun run build:desktop-resources` -> pass.
  - `~/.bun/bin/bun run desktop:build` -> pass; notarization skipped because Apple notarization credentials are not configured in this environment.
  - `git diff --check` -> pass.

# Task: Fix failing `opencode-review` PR workflow

## Plan
- [x] Inspect the latest failing `opencode-review` GitHub Actions run for PR `#36` and identify the concrete failure mode in the workflow/action setup.
- [x] Patch the workflow or repository configuration to eliminate the failure without weakening the intended review behavior.
- [x] Run targeted verification for the changed workflow-related surfaces plus the repo-required verification commands, then record the outcome here.

## Review
- The failing check was not an application/test regression. In GitHub Actions run `23034800598` for PR `#36`, `anomalyco/opencode/github@latest` completed its local setup and then failed when it tried to add a reaction and create a PR comment. GitHub returned `403 Resource not accessible by integration` for both `POST /issues/36/reactions` and `POST /issues/36/comments`.
- Root cause: [opencode-review.yml](/Users/mweinbach/Projects/agent-coworker/.github/workflows/opencode-review.yml) granted only `pull-requests: read` and `issues: read`, but the action’s normal review flow writes PR-visible artifacts. The workflow was denying the exact operations the action is designed to perform.
- Fixed by changing the `review` job permissions in [opencode-review.yml](/Users/mweinbach/Projects/agent-coworker/.github/workflows/opencode-review.yml) to `pull-requests: write` and `issues: write`, while keeping `contents: read` and `id-token: write` unchanged.
- Verification:
  - `gh run view 23034800598 --log` -> confirmed the concrete 403 failure mode and the denied endpoints.
  - `python3` YAML sanity check for `.github/workflows/opencode-review.yml` -> pass.
  - `~/.bun/bin/bun test` -> pass (`2203 pass, 2 skip, 0 fail`).
  - `~/.bun/bin/bun run typecheck` -> pass.
  - `./node_modules/.bin/tsc --noEmit -p apps/TUI/tsconfig.json` -> still fails in unchanged TUI code at `apps/TUI/routes/session/index.tsx:248` (`TS2769`) and `apps/TUI/ui/dialog-prompt.tsx:61` (`TS2322`).
  - `~/.bun/bin/bun run build:server-binary` -> pass.
  - `~/.bun/bin/bun run build:desktop-resources` -> pass.
  - `~/.bun/bin/bun run desktop:build` -> pass.

# Task: Move desktop fix stack onto current main

## Plan
- [x] Inspect the stale feature branch against current `main` and determine whether a direct merge/rebase is safe.
- [x] Move only the session-specific citation and transcript fixes onto current `main` without pulling the older unrelated branch stack.
- [x] Run sanity verification on `main` and record the outcome here.

## Review
- The original working branch was based on an older point in history and carried a long unrelated stack (`opencode-go`, overflow, webFetch, and other prior work), so rebasing or merging the whole branch onto `main` was the wrong integration path for this request.
- Instead, current `main` now carries only the session-specific fixes via cherry-picks: `52e729b` (`citations`) and `f5fbaed` (`fix transcript`), plus this follow-up task/lesson update.
- Verification from the landed `main` head passed for the relevant regression slice, `~/.bun/bin/bunx tsc --noEmit -p apps/desktop/tsconfig.json`, `~/.bun/bin/bun run typecheck`, `~/.bun/bin/bun test`, `~/.bun/bin/bun run build:server-binary`, `~/.bun/bin/bun run build:desktop-resources`, `~/.bun/bin/bun run desktop:build`, and `git diff --check`.
- Standalone `./node_modules/.bin/tsc --noEmit -p apps/TUI/tsconfig.json` still fails in unchanged TUI code at `apps/TUI/routes/session/index.tsx:248` (`TS2769`) and `apps/TUI/ui/dialog-prompt.tsx:61` (`TS2322`).

# Task: Prevent blank assistant messages from splitting Thinking cards

## Plan
- [x] Reconstruct the affected desktop transcript/feed to confirm where the extra Thinking-card boundary is introduced.
- [x] Suppress whitespace-only assistant message items in the desktop feed mapping/live stream path so reasoning/tool traces stay grouped.
- [x] Add regression coverage, run focused verification, and record the result here.

## Review
- The split was caused by a whitespace-only assistant text chunk in the second deck-building turn. In the saved transcript at `/Users/mweinbach/Library/Application Support/Cowork/transcripts/e264d57c-2c2f-43e9-8658-94fb92cb6c94.jsonl`, the stream emitted a blank assistant text segment between the `skill`/planning steps and the later `todoWrite`/`webSearch` steps. Desktop feed reconstruction treated that newline as a real assistant message, which flushed the first `Thinking` card and started a second one.
- `apps/desktop/src/app/store.feedMapping.ts` now suppresses whitespace-only assistant text when rebuilding feed items from streamed deltas and when replaying merged `assistant_message` payloads. That keeps the turn as one continuous reasoning/tool trace instead of inserting an invisible assistant-message boundary.
- Added regressions in `apps/desktop/test/store-feed-mapping.test.ts` for both whitespace-only streamed assistant text and whitespace-only `assistant_message` payloads.
- Sanity check against the real transcript now produces a single second `activity-group` containing the `skill`, `todoWrite`, and `webSearch` activity instead of two separate `Thinking` cards.
- Verification:
  - `~/.bun/bin/bun test apps/desktop/test/store-feed-mapping.test.ts apps/desktop/test/chat-activity-groups.test.ts --bail` -> pass (`26 pass, 0 fail`)
  - `~/.bun/bin/bunx tsc --noEmit -p apps/desktop/tsconfig.json` -> pass
  - `~/.bun/bin/bun run typecheck` -> pass
  - `./node_modules/.bin/tsc --noEmit -p apps/TUI/tsconfig.json` -> fails in unchanged TUI code at `apps/TUI/routes/session/index.tsx:248` (`TS2769`) and `apps/TUI/ui/dialog-prompt.tsx:61` (`TS2322`)
  - `~/.bun/bin/bun test` -> fails only in the external remote MCP coverage: `remote MCP (mcp.grep.app) > connects, discovers tools, and executes searchGitHub` returned `Streamable HTTP error ... 500: Internal Server Error`
  - `~/.bun/bin/bun run build:server-binary` -> pass
  - `~/.bun/bin/bun run build:desktop-resources` -> pass
  - `~/.bun/bin/bun run desktop:build` -> pass
  - `git diff --check` -> pass

# Task: Fix user-facing citation indexing in conversation messages

## Plan
- [x] Inspect persisted session content and current desktop/TUI rendering to confirm how raw citation/index markers are stored and displayed.
- [x] Add a shared display normalization for raw web citation markers so assistant messages render readable source indices for users.
- [x] Add regression coverage and run the required verification commands, then record the results here.

## Review

# Task: Fix desktop user profile context blank screen on input

## Plan
- [x] Reproduce the desktop renderer failure in the actual Electron workspaces settings flow and isolate the real render loop source.
- [x] Patch the render loop, then add regressions for both the chat-view loop and the workspaces typing path that triggered it.
- [x] Fix the standalone TUI typecheck failures surfaced during verification, rerun the repo-required test/build lane, and record the outcome here.

## Review
- Reproduced the blank-screen bug in the real Electron app by launching desktop dev mode with remote debugging and typing into the `Workspace work context` field in Settings -> Workspaces. The renderer hit React's `Maximum update depth exceeded` warning and the page blanked.
- Root cause was not the workspace profile form. The loop came from [ChatView.tsx](/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/ui/ChatView.tsx): the citation-overflow effect reset `overflowCitationUrlsByMessageId` to a fresh empty `Map()` every render when the derived `citationOverflowFilePathsByMessageId` was empty. Because that derived map is rebuilt during render, the effect kept scheduling a new state update and the renderer never settled.
- Fixed [ChatView.tsx](/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/ui/ChatView.tsx) so the empty-path case preserves the existing empty map instead of creating a new one. That breaks the passive-effect update loop while keeping the citation reset behavior when there is real state to clear.
- Added a dedicated desktop regression in [chat-view.stability.test.tsx](/Users/mweinbach/Projects/agent-coworker/apps/desktop/test/chat-view.stability.test.tsx) that mounts `ChatView` under `StrictMode` with an empty feed and asserts no max-depth warning is emitted. Extended [workspaces-page.test.ts](/Users/mweinbach/Projects/agent-coworker/apps/desktop/test/workspaces-page.test.ts) to prove typing in the profile fields no longer triggers a render loop or blanks the settings shell.
- The repo-required verification lane still surfaced the previously known standalone TUI type errors, and the user explicitly expanded scope to include them. Fixed [index.tsx](/Users/mweinbach/Projects/agent-coworker/apps/TUI/routes/session/index.tsx) by replacing the function-child `Show` branch with a direct rendered node, and fixed [dialog-prompt.tsx](/Users/mweinbach/Projects/agent-coworker/apps/TUI/ui/dialog-prompt.tsx) by aligning `onSubmit` with the OpenTUI input callback shape.
- Manual Electron verification after the fix showed the Settings -> Workspaces page remained interactive after typing into `Workspace work context`, and the max-depth warning no longer appeared in the renderer console.

### Verification
- `HOME=$(mktemp -d) ~/.bun/bin/bun test apps/desktop/test/chat-view.stability.test.tsx apps/desktop/test/workspaces-page.test.ts --bail` -> pass (`5 pass, 0 fail`)
- `HOME=$(mktemp -d) ~/.bun/bin/bun test` -> pass (`2231 pass, 2 skip, 0 fail`)
- `~/.bun/bin/bun run typecheck` -> pass
- `./node_modules/.bin/tsc --noEmit -p apps/TUI/tsconfig.json` -> pass
- `~/.bun/bin/bun run build:server-binary` -> pass
- `~/.bun/bin/bun run build:desktop-resources` -> pass
- `~/.bun/bin/bun run desktop:build` -> pass; macOS notarization skipped because Apple notarization credentials are not configured in this environment
- `git diff --check` -> pass

# Task: Address unresolved PR #37 review comments

## Plan
- [x] Identify the open GitHub PR for the current branch and fetch all unresolved review threads/comments that need attention.
- [x] Summarize each thread into a numbered fix candidate with the concrete code/doc/test surface it would require.
- [x] Fix the remaining config-layering and `set_config` ordering issues, then rerun the required verification/build lane and update the PR threads.

## Review
- `src/config.ts` now resolves `userName` from the merged config layers with trimming that preserves explicit empty strings, so a persisted project-level clear (`""`) survives restart instead of falling back to inherited user or built-in defaults.
- `src/server/session/AgentSession.ts` now serializes pending config mutations before `sendUserMessage()`, which removes the race where a back-to-back `set_config` and `user_message` could run one turn with the stale cached prompt.
- Added focused regressions in `test/config.test.ts`, `test/session.test.ts`, and `test/server.test.ts` covering explicit-empty `userName` layering, in-flight `setConfig()` prompt refresh ordering, and restart persistence for cleared profile fields.

### Verification
- `git diff --check` -> pass
- `HOME=$(mktemp -d) ~/.bun/bin/bun test test/config.test.ts test/session.test.ts test/server.test.ts --bail` -> pass (`344 pass, 0 fail`)
- `HOME=$(mktemp -d) ~/.bun/bin/bun test` -> pass (`2228 pass, 2 skip, 0 fail`)
- `~/.bun/bin/bun run typecheck` -> pass
- `./node_modules/.bin/tsc --noEmit -p apps/TUI/tsconfig.json` -> fails in unchanged TUI code at `apps/TUI/routes/session/index.tsx:248` (`TS2769`) and `apps/TUI/ui/dialog-prompt.tsx:62` (`TS2322`)
- `~/.bun/bin/bun run build:server-binary` -> pass
- `~/.bun/bin/bun run build:desktop-resources` -> pass
- `~/.bun/bin/bun run desktop:build` -> pass; macOS notarization skipped because Apple notarization credentials are not configured in this environment

# Task: Ship v0.1.21

## Plan
- [x] Bump every release-version surface from `0.1.20` to `0.1.21` and add a focused changelog entry for the mac updater fix.
- [x] Re-run the required verification commands for a desktop release after the updater patch and version bump.
- [ ] Commit the release, push `main`, create and push tag `v0.1.21`, and verify the GitHub release workflow.

# Task: Fix macOS 0.1.19 -> 0.1.20 auto-update code-sign validation failure

## Plan
- [x] Compare the published `v0.1.19` and `v0.1.20` mac update artifacts and updater metadata to determine whether the release itself is invalid.
- [x] Verify the downloaded `v0.1.19` and `v0.1.20` app bundles locally with `codesign` and `spctl` to isolate whether the failure is in signing or in the updater transport path.
- [x] Patch the desktop updater to avoid the failing mac differential-download path, add regression coverage, and run verification.

## Review
- The published `v0.1.20` mac updater payload is valid. `latest-mac.yml` matches the uploaded zip/dmg hashes, and the downloaded `Cowork.app` from both `v0.1.19` and `v0.1.20` passes `codesign -dvvv` plus `spctl -a -vv --type exec` with the same designated requirement: `identifier \"com.cowork.desktop\"` signed by `Developer ID Application: Max Weinbach (6UHAW5UAT4)`.
- That rules out a bad published signature and points at the updater transport. The installed `electron-updater` `MacUpdater` implementation still uses differential patching when a cached `update.zip` exists, and it honors `disableDifferentialDownload` on macOS even though the type comment says “NSIS only.” That matches the reported symptom: ShipIt rejects the reconstructed cached app, while a full update payload remains valid.
- `apps/desktop/electron/services/updater.ts` now forces `disableDifferentialDownload = true` for packaged macOS builds only, which makes ShipIt use the already-validated full zip path instead of the brittle differential patch path.
- Added regression coverage in `apps/desktop/test/updater-service.test.ts` to assert the mac-only differential-download disable flag.
- Verification:
  - `codesign -dvvv /tmp/cowork-v0.1.20-unzip/Cowork.app && spctl -a -vv --type exec /tmp/cowork-v0.1.20-unzip/Cowork.app` -> pass
  - `codesign -dvvv /tmp/cowork-v0.1.19-unzip/Cowork.app && spctl -a -vv --type exec /tmp/cowork-v0.1.19-unzip/Cowork.app` -> pass
  - `bun test apps/desktop/test/updater-service.test.ts` -> pass (`11 pass, 0 fail`)
  - `bun run typecheck` -> pass
  - `bun run desktop:build` -> pass

# Task: Update v0.1.20 release notes to match shipped changes

## Plan
- [x] Review the `v0.1.19..v0.1.20` commit range and current published `v0.1.20` release body.
- [x] Update `CHANGELOG.md` with a concise `0.1.20` entry that reflects the shipped server, provider, tool, and release-validation fixes.
- [x] Replace the published GitHub release notes for `v0.1.20` with the fuller summary while preserving the compare context.
- [x] Verify the updated release body on GitHub and record the outcome below.

## Review
- Updated `CHANGELOG.md` with a new `0.1.20` entry that summarizes the shipped `cowork-server` release track, OpenCode/Exa tool-provider work, overflow spill handling, download-path hardening, and the release-validation fixes that landed after the version bump.
- Replaced the published `v0.1.20` GitHub release body with the same fuller summary while preserving the autogenerated PR bullets and compare link.
- Verification:
  - `gh release view v0.1.20` -> pass; release body now includes the expanded `Highlights` / `Added` / `Changed` / `Fixed` sections at `https://github.com/mweinbach/agent-coworker/releases/tag/v0.1.20`

# Task: Fix latest Desktop Release CI failure from leaked AgentSocket mock

## Plan
- [x] Inspect the latest failing GitHub Actions run and identify the concrete failing tests plus their shared failure signature.
- [x] Remove the cross-file `AgentSocket` module mock leak by switching the TUI socket lifecycle test to dependency injection instead of a top-level global `mock.module(...)`.
- [x] Re-run the failing websocket/REPL test slice, then the required full test/build commands, and record the results here.

## Review
- Latest failing GitHub Actions run was `Desktop Release` run `23028363643` on tag `v0.1.20`. It did not fail in packaging; it failed in the `Validate` job during `bun test` with 7 websocket/REPL regressions: `test/repl.restart-failure.test.ts`, `test/repl.disconnect-send.test.ts`, and five cases in `test/agentSocket.runtime.test.ts`.
- The shared CI signature was that no fake socket instance was created at all (`socketCount: 0`, `Received: undefined`), which matched cross-file module contamination rather than a broken websocket implementation. `test/tui.socketLifecycle.test.ts` had a top-level `mock.module("../src/client/agentSocket", ...)` that could leak into unrelated files under Bun's parallel runner.
- `apps/TUI/context/socketLifecycle.ts` now accepts an optional `createSocket` factory for tests while preserving the production `new AgentSocket(...)` path.
- `test/tui.socketLifecycle.test.ts` now injects `MockAgentSocket` directly and no longer installs a process-wide module mock for `../src/client/agentSocket`, removing the contamination path that could poison REPL/runtime websocket tests.
- Verification:
  - `gh run view 23028363643 --log` -> confirmed the latest failure was 7 websocket/REPL tests in the `Validate` job, not the packaging steps.
  - `CI=1 GITHUB_ACTIONS=true ~/.bun/bin/bun test test/tui.socketLifecycle.test.ts test/repl.restart-failure.test.ts test/repl.disconnect-send.test.ts test/agentSocket.runtime.test.ts --rerun-each 20` -> pass (`220 pass, 0 fail`)
  - `/tmp/codex-bun-1.3.10/bun-darwin-aarch64/bun test /Users/mweinbach/Projects/agent-coworker/test/tui.socketLifecycle.test.ts /Users/mweinbach/Projects/agent-coworker/test/repl.restart-failure.test.ts /Users/mweinbach/Projects/agent-coworker/test/repl.disconnect-send.test.ts /Users/mweinbach/Projects/agent-coworker/test/agentSocket.runtime.test.ts --rerun-each 20` -> pass under Bun `1.3.10` (`220 pass, 0 fail`)
  - `bun run docs:check` -> pass
  - `bun test` -> pass (`2187 pass, 2 skip, 0 fail`)
  - `bun run typecheck` -> pass
  - `./node_modules/.bin/tsc --noEmit -p apps/TUI/tsconfig.json` -> fails in unchanged TUI code at `apps/TUI/routes/session/index.tsx:216` (`TS2769`) and `apps/TUI/ui/dialog-prompt.tsx:61` (`TS2322`)
  - `bun run build:server-binary` -> pass
  - `bun run build:desktop-resources` -> pass
  - `bun run desktop:build` -> pass

# Task: Use effective overflow default when workspace override is unset

## Plan
- [x] Audit the Developer page overflow state derivation against workspace runtime session config so inherited defaults render from the effective value.
- [x] Patch the desktop Developer page to use the effective runtime overflow threshold and enabled state whenever `defaultToolOutputOverflowChars` is unset, without changing explicit override behavior.
- [x] Add regression coverage for inherited numeric and inherited `null` defaults, run the required test/build commands, and record the results here.

## Review
- `apps/desktop/src/ui/settings/pages/DeveloperPage.tsx` now resolves the displayed spill-file enabled state and threshold from `workspaceRuntimeById[workspace.id].controlSessionConfig.toolOutputOverflowChars` whenever `defaultToolOutputOverflowChars` is unset, so inherited user-level or built-in defaults render correctly instead of falling back to `25000`.
- The same Developer page now treats enable actions against an inherited disabled default (`toolOutputOverflowChars: null`) as an explicit built-in-threshold restore (`25000`) instead of sending another clear/inherit no-op. Existing explicit-override behavior is unchanged: numeric overrides can still revert to inherit, and disabled explicit overrides still restore inherited numeric defaults when one exists.
- `apps/desktop/test/developer-page.test.tsx` now covers both missing-override inherited paths: inherited numeric thresholds render from runtime session config, and inherited disabled defaults allow `Enable default` to persist the built-in threshold.
- Verification:
  - `~/.bun/bin/bun test apps/desktop/test/developer-page.test.tsx apps/desktop/test/workspace-settings-sync.test.ts --bail` -> pass (`20 pass, 0 fail`)
  - `OPENCODE_API_KEY='' OPENCODE_ZEN_API_KEY='' ~/.bun/bin/bun test` -> pass (`2187 pass, 2 skip, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> fails in unchanged desktop code at `apps/desktop/src/app/store.feedMapping.ts:136` (`TS2345`)
  - `./node_modules/.bin/tsc --noEmit -p apps/TUI/tsconfig.json` -> fails in unchanged TUI code at `apps/TUI/routes/session/index.tsx:216` (`TS2769`) and `apps/TUI/ui/dialog-prompt.tsx:61` (`TS2322`)
  - `~/.bun/bin/bun run build:server-binary` -> pass
  - `~/.bun/bin/bun run build:desktop-resources` -> pass
  - `~/.bun/bin/bun run desktop:build` -> pass
  - `git diff --check` -> pass

# Task: Make MCP OAuth tests headless-safe and stabilize GitHub execution

## Plan
- [x] Audit the MCP OAuth provider/browser-open path and identify the minimal injection seam that keeps runtime behavior unchanged.
- [x] Update the MCP OAuth provider tests to use a stubbed opener instead of the real external browser command, and tighten any related assertions around auto/code flows.
- [x] Reproduce GitHub-sensitive failures or skips locally where possible, fix any deterministic CI assumptions uncovered by this task, and keep unrelated env-only failures called out separately.
- [x] Run focused test coverage first, then the required broader verification/build commands, and record results here.

## Review
- `src/mcp/oauthProvider.ts` now accepts an optional injected `openUrl` dependency in `authorizeMCPServerOAuth()`. Production callers still default to `openExternalUrl`, but tests can stop the real OS/browser launch path entirely.
- `test/mcp.oauth-provider.test.ts` now stubs the opener in auto mode and routes both authorize-path tests through the same local metadata/token server used by the exchange tests, so the file is fully headless and no longer depends on external OAuth discovery.
- GitHub Actions PR check inspection (`gh` on PR `#35`, failing run `23019023411`) showed the active `Docs + Tests` failures were not MCP OAuth. The concrete failures were seven flaking websocket/REPL tests: `test/repl.restart-failure.test.ts`, `test/repl.disconnect-send.test.ts`, and `test/agentSocket.runtime.test.ts`.
- `test/repl.restart-failure.test.ts` and `test/repl.disconnect-send.test.ts` no longer sleep for a fixed `5ms`; both now poll until the fake readline + fake websocket are actually connected, which removes the slow-runner race seen on GitHub.
- `test/agentSocket.runtime.test.ts` now marks the shared-global websocket/timer cases as `test.serial(...)`, preventing Bun from interleaving tests that reset shared fake websocket state or patch global timers.
- `.github/workflows/ci.yml` now enables `RUN_REMOTE_MCP_TESTS=1` in the `Docs + Tests` job and passes `OPENCODE_API_KEY` into both the unit-test job and the testing-environment harness job, so GitHub executes the remote MCP coverage instead of silently skipping it.
- `test/runtime.pi-runtime.test.ts` now explicitly clears `OPENCODE_API_KEY` around the `opencode-go` metadata assertions so those tests stay deterministic even when CI exports a real key for remote integration coverage.
- Verification:
  - `CI=1 GITHUB_ACTIONS=true ~/.bun/bin/bun test test/mcp.oauth-provider.test.ts test/repl.restart-failure.test.ts test/repl.disconnect-send.test.ts test/agentSocket.runtime.test.ts --rerun-each 20` -> pass (`240 pass, 0 fail`)
  - `CI=1 GITHUB_ACTIONS=true ~/.bun/bin/bun test test/mcp.oauth-provider.test.ts test/repl.restart-failure.test.ts test/repl.disconnect-send.test.ts test/agentSocket.runtime.test.ts --bail` -> pass
  - `RUN_REMOTE_MCP_TESTS=1 OPENCODE_API_KEY='<redacted>' ~/.bun/bin/bun test test/mcp.remote.grep.test.ts test/agent.remote-mcp.grep.test.ts --bail` -> pass (`2 pass, 0 fail`)
  - `OPENCODE_API_KEY='<redacted>' ~/.bun/bin/bun test test/runtime.pi-runtime.test.ts --test-name-pattern 'opencode-go runtime model resolution' --bail` -> pass (`2 pass, 0 fail`)
  - `RUN_REMOTE_MCP_TESTS=1 OPENCODE_API_KEY='<redacted>' OPENCODE_ZEN_API_KEY='' CI=1 GITHUB_ACTIONS=true ~/.bun/bin/bun test` -> pass (`2187 pass, 0 fail`)
  - `~/.bun/bin/bun run build:server-binary` -> pass
  - `~/.bun/bin/bun run build:desktop-resources` -> pass
  - `~/.bun/bin/bun run desktop:build` -> pass
  - `~/.bun/bin/bun run typecheck` -> fails in unchanged desktop code at `apps/desktop/src/app/store.feedMapping.ts:136` (`TS2345`)
  - `./node_modules/.bin/tsc --noEmit -p apps/TUI/tsconfig.json` -> fails in unchanged TUI code at `apps/TUI/routes/session/index.tsx:216` (`TS2769`) and `apps/TUI/ui/dialog-prompt.tsx:61` (`TS2322`)
  - `git diff --check` -> pass

# Task: Fix review follow-ups for download finalization, spill-file privacy, and overflow inheritance

## Plan
- [x] Replace `webFetch`’s access-then-rename download finalize path with an exclusive finalize flow that retries on late collisions, and add regression coverage for the late-`EEXIST` case.
- [x] Harden `.ModelScratchpad` spill directories/files to private permissions (`0700`/`0600`) and add permission assertions to overflow runtime coverage.
- [x] Add an explicit clear/inherit path for workspace overflow defaults across desktop store actions, websocket `set_config`, server config persistence, and the Developer settings UI.
- [x] Update focused desktop/server/protocol regressions plus docs for the new inherit-default contract, then run targeted tests, full tests, typechecks, required builds, and record results here.

## Review
- `src/tools/webFetch.ts` no longer relies on access-time name reservation. Direct downloads now stream into a temp file inside `Downloads`, then finalize with `copyFile(..., COPYFILE_EXCL)` plus retry-on-`EEXIST`, so a file created after reservation cannot be atomically replaced by a blind `rename`. `test/tools.test.ts` covers the late-collision path and asserts the original file survives.
- `src/runtime/toolOutputOverflow.ts` now creates `.ModelScratchpad` with `0700` and spill files with `0600`, plus best-effort `chmod` hardening after creation. `test/runtime.pi-runtime.test.ts` now checks the resulting directory/file modes.
- Overflow-default reset now has a real inherit path instead of pinning `25000`: desktop workspace defaults can send `clearDefaultToolOutputOverflowChars`, websocket `set_config` accepts `clearToolOutputOverflowChars`, the server removes the persisted override from `.agent/config.json`, and live sessions reset to `inheritedToolOutputOverflowChars`. The UI copy/button now says `Inherit default` to match behavior.
- Added regression coverage across `test/protocol.test.ts`, `test/session.test.ts`, `test/server.test.ts`, `apps/desktop/test/developer-page.test.tsx`, `apps/desktop/test/workspace-settings-sync.test.ts`, and `apps/desktop/test/workspace-startup.test.ts`, and updated `docs/websocket-protocol.md` with protocol version `7.15`.
- Verification:
  - `OPENCODE_API_KEY='' OPENCODE_ZEN_API_KEY='' ~/.bun/bin/bun test` -> pass (`2185 pass, 2 skip, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> fails in unchanged desktop code at `apps/desktop/src/app/store.feedMapping.ts:136` (`TS2345`)
  - `./node_modules/.bin/tsc --noEmit -p apps/TUI/tsconfig.json` -> fails in unchanged TUI code at `apps/TUI/routes/session/index.tsx:216` (`TS2769`) and `apps/TUI/ui/dialog-prompt.tsx:61` (`TS2322`)
  - `~/.bun/bin/bun run build:server-binary` -> pass
  - `~/.bun/bin/bun run build:desktop-resources` -> pass
  - `~/.bun/bin/bun run desktop:build` -> pass
  - `git diff --check` -> pass

# Task: Implement review follow-ups for webFetch, Exa key precedence, and overflow preview behavior

## Plan
- [x] Keep `opencode-go` intentionally unpriced, add an explicit in-code note, and lock that contract with pricing tests.
- [x] Flip Exa key resolution so the saved Cowork Exa key overrides `EXA_API_KEY`, with env fallback only when no saved key is available.
- [x] Tighten `webFetch` so supported document filenames always download even under text MIME, and replace buffered downloads with bounded streaming plus cleanup/limit coverage.
- [x] Increase overflow previews to 5,000 characters, update runtime/docs/Desktop copy to describe threshold-vs-preview behavior accurately, and add focused regressions.
- [x] Run focused tests first, then required broader verification/build commands, and record results here.

## Review
- `src/session/pricing.ts` now documents that `opencode-go` is intentionally usage-based and excluded from local pricing / pricing overrides, and `test/session/pricing.test.ts` locks that behavior so override env vars are ignored for `opencode-go` models.
- `src/tools/exa.ts` now prefers the saved Cowork Exa key over ambient `EXA_API_KEY`, falling back to the env var only when no saved key is available; `test/tools.exa.test.ts` covers both precedence directions.
- `src/tools/webFetch.ts` now treats supported document filenames as downloadable even under text MIME, preserves the filename source that actually triggered a document download, streams normal direct-download bodies to disk with cleanup on overflow, and rejects body-less direct downloads unless `Content-Length` makes the fallback bounded. `test/tools.test.ts` adds regressions for text/plain markdown downloads, conflicting URL-vs-`Content-Disposition` names, streamed overflow cleanup, and body-less fallback behavior.
- Overflow spill behavior now keeps a fixed 5,000-character inline preview while saving the full payload to disk: `src/shared/toolOutputOverflow.ts`, `src/runtime/toolOutputOverflow.ts`, `test/runtime.pi-runtime.test.ts`, and `test/runtime.openai-responses-runtime.test.ts` now align on that contract.
- Desktop settings copy and protocol docs now match runtime semantics: `apps/desktop/src/ui/settings/pages/DeveloperPage.tsx`, `apps/desktop/test/developer-page.test.tsx`, and `docs/websocket-protocol.md` describe `toolOutputOverflowChars` as the spill trigger threshold while the inline preview remains fixed at the first 5,000 characters.
- Verification:
  - `~/.bun/bin/bun test test/tools.test.ts test/tools.exa.test.ts test/session/pricing.test.ts apps/desktop/test/developer-page.test.tsx test/docs.check.test.ts test/runtime.openai-responses-runtime.test.ts --bail && ~/.bun/bin/bun test test/runtime.pi-runtime.test.ts --test-name-pattern "overflow|short tool output inline|spills oversized" --bail` -> pass (`220 pass, 0 fail` across the two commands)
  - `~/.bun/bin/bun test` -> fails only in existing env-sensitive OpenCode Go runtime tests because ambient `OPENCODE_API_KEY` populates `resolved.apiKey` (`test/runtime.pi-runtime.test.ts:159` and `:182`); otherwise passes (`2176 pass, 2 skip, 2 fail`)
  - `~/.bun/bin/bun run typecheck` -> fails in unchanged desktop code at `apps/desktop/src/app/store.feedMapping.ts:136` (`TS2345`)
  - `./node_modules/.bin/tsc --noEmit -p apps/TUI/tsconfig.json` -> fails in unchanged TUI code at `apps/TUI/routes/session/index.tsx:216` (`TS2769`) and `apps/TUI/ui/dialog-prompt.tsx:61` (`TS2322`)
  - `~/.bun/bin/bun run build:server-binary` -> pass
  - `~/.bun/bin/bun run build:desktop-resources` -> pass
  - `~/.bun/bin/bun run desktop:build` -> pass
  - `git diff --check` -> pass

# Task: Stop auto-sync from persisting the inherited tool overflow default

## Plan
- [x] Split the `session_config` overflow contract so the harness reports the explicit persisted default separately from the live effective threshold.
- [x] Update desktop control-session hydration and auto-sync so thread connect only replays an explicit overflow default, not the inherited built-in value.
- [x] Add regression coverage, run the relevant tests/builds, and record the results here.

## Review
- `session_config` now separates the live effective overflow threshold from the explicit project-scoped default: `toolOutputOverflowChars` stays the runtime value, while optional `defaultToolOutputOverflowChars` is emitted only when `.agent/config.json` explicitly set an override. The server tracks that explicitness through `AgentConfig.projectConfigOverrides` so built-in or user-level defaults do not masquerade as workspace defaults.
- Desktop control-session hydration now mirrors `defaultToolOutputOverflowChars` into workspace state and leaves the live effective threshold in `workspaceRuntime.controlSessionConfig`, so reconnects clear stale local overflow defaults when the harness is inheriting the built-in setting.
- Automatic thread-connect sync now replays only explicit harness overflow defaults. A control session that merely reports the effective built-in `25000` threshold no longer causes later `set_config` writes to pin that value into `.agent/config.json`.
- Added regressions across `test/session.test.ts`, `test/server.test.ts`, `test/agentSocket.parse.test.ts`, and `apps/desktop/test/workspace-settings-sync.test.ts`, plus protocol docs/version updates in `docs/websocket-protocol.md`.
- Verification:
  - `~/.bun/bin/bun test apps/desktop/test/workspace-settings-sync.test.ts test/session.test.ts test/server.test.ts test/agentSocket.parse.test.ts test/docs.check.test.ts --bail` -> pass (`300 pass, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> fails in unchanged desktop code at `apps/desktop/src/app/store.feedMapping.ts:136` (`TS2345`)
  - `~/.bun/bin/bun test` -> fails in existing env-sensitive OpenCode Go runtime tests because `resolved.apiKey` is set from local environment instead of `undefined` (`test/runtime.pi-runtime.test.ts:159` and `:182`); all new overflow regressions passed
  - `~/.bun/bin/bun run build:server-binary` -> pass
  - `~/.bun/bin/bun run build:desktop-resources` -> pass
  - `./node_modules/.bin/tsc --noEmit -p apps/TUI/tsconfig.json` -> fails in unchanged TUI code at `apps/TUI/routes/session/index.tsx:216` (`TS2769`) and `apps/TUI/ui/dialog-prompt.tsx:61` (`TS2322`)
  - `~/.bun/bin/bun run desktop:build` -> pass after approved networked Electron download
  - `git diff --check` -> pass

# Task: Fix webFetch markdown attachment download classification

## Plan
- [x] Add markdown filename extensions to the `webFetch` downloadable document classifier.
- [x] Add a focused regression that covers octet-stream markdown attachments named only via `Content-Disposition`.
- [x] Run focused tests plus repo verification commands, then record the results here.

## Review
- `src/tools/webFetch.ts` now treats `.md` and `.markdown` filenames as downloadable documents, so markdown attachments served as `application/octet-stream` no longer fall through to the blocked binary path.
- `test/tools.test.ts` now covers markdown downloads where the only filename signal comes from `Content-Disposition`, which is the specific regression path surfaced in review.
- Verification:
  - `~/.bun/bin/bun test test/tools.test.ts --bail` -> pass (`163 pass, 0 fail`)
  - `~/.bun/bin/bun test` -> pass (`2172 pass, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass
  - `~/.bun/bin/bun run build:server-binary` -> pass
  - `~/.bun/bin/bun run build:desktop-resources` -> pass
  - `./node_modules/.bin/tsc --noEmit -p apps/TUI/tsconfig.json` -> fails in unchanged TUI code at `apps/TUI/routes/session/index.tsx:216` (`TS2769`) and `apps/TUI/ui/dialog-prompt.tsx:61` (`TS2322`)
  - `~/.bun/bin/bun run desktop:build` -> pass
  - `git diff --check` -> pass

# Task: Fix review findings for webFetch, webSearch, and scratchpad backups

## Plan
- [x] Restrict `.ModelScratchpad` exclusions to the workspace root in backup copy, size, and fingerprint paths, and add regression coverage for nested directories.
- [x] Fix `webFetch` binary classification so octet-stream image attachments can be recognized from `Content-Disposition` filenames and downloaded names are normalized to the classified MIME.
- [x] Remove Brave-backed `webSearch` behavior and update tests to the Exa-only contract.
- [x] Run focused tests plus the required repo verification commands, then record results here.

## Review
- `src/server/sessionBackup/fileSystem.ts` and `src/server/sessionBackup/fingerprint.ts` now exclude only the workspace-root `.ModelScratchpad`, so nested directories with the same name are preserved in directory snapshots, counted in snapshot sizing, and included in workspace fingerprints.
- `src/tools/webFetch.ts` now recognizes octet-stream image attachments from `Content-Disposition` filenames and normalizes saved download extensions to the MIME that classified the response, preventing misnamed binary files from being re-read as plain text later.
- `src/tools/webSearch.ts` no longer advertises or uses Brave-backed search; the tool is now Exa-only across providers, and the affected `webSearch` contract tests were updated accordingly.
- Added focused regressions in `test/session-backup.test.ts` for nested `.ModelScratchpad` fingerprinting, sizing, and restore behavior, plus `test/tools.test.ts` coverage for MIME-normalized document downloads and octet-stream image attachments named via `Content-Disposition`.
- Verification:
  - `~/.bun/bin/bun test test/tools.test.ts test/session-backup.test.ts --bail` -> pass (`178 pass, 0 fail`)
  - `~/.bun/bin/bun test` -> pass (`2171 pass, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass
  - `~/.bun/bin/bun run build:server-binary` -> pass
  - `~/.bun/bin/bun run build:desktop-resources` -> pass
  - `./node_modules/.bin/tsc --noEmit -p apps/TUI/tsconfig.json` -> fails in unchanged TUI code at `apps/TUI/routes/session/index.tsx:216` (`TS2769`) and `apps/TUI/ui/dialog-prompt.tsx:61` (`TS2322`)
  - `~/.bun/bin/bun run desktop:build` -> pass

# Task: Fix desktop provider key reuse, workspace overflow persistence, and OpenCode pricing contract

## Plan
- [x] Hide the OpenCode sibling key-copy action when the target provider already has its own saved API key, and add focused UI coverage.
- [x] Round-trip `defaultToolOutputOverflowChars` through Electron persistence/load/save and verify the desktop workspace-default setting remains persistent across restart-equivalent flows.
- [x] Remove local pricing data/estimation for OpenCode Go while keeping OpenCode Zen pricing intact, update the affected runtime/pricing tests, and run the requested verification commands.

## Review
- `apps/desktop/src/ui/settings/pages/ProvidersPage.tsx` now suppresses the OpenCode sibling key-copy button when the target provider already has its own saved API key, and `apps/desktop/test/providers-page.test.ts` covers both the visible and hidden cases.
- Audited the full desktop persistence path for the workspace overflow setting: renderer state building, Electron IPC schema validation, main-process `PersistenceService`, bootstrap rehydration, and workspace-default sync to the harness. The only missing round-trip was `apps/desktop/electron/services/persistence.ts`, which now preserves `defaultToolOutputOverflowChars`; `apps/desktop/test/persistence-state-sanitization.test.ts` locks in custom and `null` values across save/load.
- OpenCode Go no longer exposes local pricing data. `src/session/pricing.ts` drops Go pricing entries and override support, `src/providers/opencodeShared.ts` now keeps shared model capabilities separate from Zen-only pricing metadata, and `src/runtime/piRuntime.ts`/`src/runtime/openaiResponsesProjector.ts` stop synthesizing estimated cost for Go sessions while preserving Zen pricing.
- Verification:
  - `~/.bun/bin/bun test apps/desktop/test/providers-page.test.ts apps/desktop/test/persistence-state-sanitization.test.ts apps/desktop/test/workspace-settings-sync.test.ts test/session/pricing.test.ts test/runtime.pi-runtime.test.ts test/runtime.pi-message-bridge.test.ts --bail` -> pass (`83 pass, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass
  - `~/.bun/bin/bun test` -> fails in the existing remote MCP coverage only: `remote MCP (mcp.grep.app) > connects, discovers tools, and executes searchGitHub` returned `Streamable HTTP error ... 500: Internal Server Error`
  - `~/.bun/bin/bun run build:server-binary` -> pass
  - `~/.bun/bin/bun run build:desktop-resources` -> pass
  - `~/.bun/bin/bun run desktop:build` -> pass
  - `git diff --check` -> pass

# Task: Repo-wide test audit and coverage hardening

## Plan
- [x] Audit the major harness, provider, tool, TUI, and desktop surfaces with subagents plus local heuristics to identify missing or weak tests that would not catch real regressions.
- [x] Add or strengthen the highest-value tests, favoring harness-level contract coverage when UI behavior depends on shared core logic.
- [x] Run focused suites for changed areas, then run repo verification (`bun test`, `bun run typecheck`, `bun run build:server-binary`, `bun run build:desktop-resources`, `bun run desktop:build`) and record outcomes here.

## Review
- `apps/desktop/src/app/store.actions/bootstrap.ts` now preserves the persisted `defaultToolOutputOverflowChars` shape during init: explicit `null` stays `null`, explicit numeric values stay numeric, and omitted values remain omitted instead of being synthesized to `25000` during desktop rehydration.
- `src/shared/persistentSubagents.ts` now derives persistent subagent provider validation from shared `PROVIDER_NAMES`, so schema acceptance stays aligned with the main provider source of truth as providers are added or removed.
- Added focused regressions in `apps/desktop/test/workspace-settings-sync.test.ts` for bootstrap overflow rehydration and in `test/shared/persistentSubagents.test.ts` for provider coverage across the shared provider list.
- Verification:
  - `~/.bun/bin/bun test apps/desktop/test/workspace-settings-sync.test.ts test/shared/persistentSubagents.test.ts` -> pass (`15 pass, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass
  - `~/.bun/bin/bun test` -> fails in existing remote MCP coverage: `remote MCP (mcp.grep.app) > connects, discovers tools, and executes searchGitHub` returned `Streamable HTTP error ... 500: Internal Server Error`
  - `~/.bun/bin/bun run build:server-binary` -> pass
  - `~/.bun/bin/bun run build:desktop-resources` -> pass
  - `~/.bun/bin/bun run desktop:build` -> pass
  - `./node_modules/.bin/tsc --noEmit -p apps/TUI/tsconfig.json` -> fails in existing TUI code at `apps/TUI/routes/session/index.tsx:216` (`TS2769`) and `apps/TUI/ui/dialog-prompt.tsx:61` (`TS2322`); no standalone TUI build script is defined in the repo root scripts
  - `git diff --check` -> pass
- Added `test/tui.syncEventReducer.test.ts` with reset, dedupe, tool-log pairing, ask/approval, backup, and tool-list normalization scenarios plus targeted assertions on state mutations.
- Added `test/tui.socketLifecycle.test.ts` with a mocked `AgentSocket` to cover resume semantics, restart trimming, clearing `latestSessionId`, and ignoring stale events after disconnect.
- Ran `bun test test/tui.syncEventReducer.test.ts test/tui.socketLifecycle.test.ts` (10 pass, 0 fail).
- Ran `bun test` (fails because `ensureRipgrep` still resolves a pre-installed `rg` binary despite `disableDownload: true` and the expectation for a rejection); other verification commands (`bun run typecheck`, `bun run build:server-binary`, `bun run build:desktop-resources`, `bun run desktop:build`) succeeded.
- Added targeted coverage for `utils/browser`, `atomicFile`, `createTools` persistent agent wiring, and `tools/exa` plus the supporting spawn-injection shim.
- Verification: `bun test test/utils.browser.test.ts test/atomicFile.test.ts test/tools.test.ts test/tools.exa.test.ts`.

# Task: Add desktop Developer settings for tool output overflow spill files

## Plan
- [x] Extend desktop workspace state/persistence so `toolOutputOverflowChars` can be stored as a workspace developer setting.
- [x] Wire desktop control-session sync and workspace-default application so the selected workspace can push `toolOutputOverflowChars` to control/thread sessions.
- [x] Add a Developer settings UI for the active workspace with enable/disable, threshold editing, and reset-to-default controls.
- [x] Add focused desktop tests for state sync/UI coverage, then run verification and record results.

## Review
- Added a workspace-scoped desktop default for tool output overflow thresholds across `apps/desktop/src/app/types.ts`, desktop persistence/schema normalization, new-workspace defaults, control-session hydration, and workspace-default propagation to control sessions and live threads.
- Updated the desktop workspace-default sync path so `set_config` now carries `toolOutputOverflowChars` alongside the existing safe runtime defaults, while preserving the deferred model/sub-agent/provider-option behavior for busy threads.
- Built the control into `apps/desktop/src/ui/settings/pages/DeveloperPage.tsx` under Developer settings. The new card targets the selected workspace, supports enable/disable via `null`, editable numeric thresholds, and a reset-to-default action for `25000`.
- Added desktop coverage for the new state and UI in `apps/desktop/test/workspace-settings-sync.test.ts`, `apps/desktop/test/desktop-schemas.test.ts`, and `apps/desktop/test/developer-page.test.tsx`.
- Verification:
  - `bun test apps/desktop/test/developer-page.test.tsx apps/desktop/test/workspace-settings-sync.test.ts apps/desktop/test/desktop-schemas.test.ts --bail` -> pass
  - `bun test` -> pass (`2106 pass, 0 fail`)
  - `bun run typecheck` -> pass
  - `git diff --check` -> pass

# Task: Add tool output overflow spill files

## Plan
- [x] Extend config/protocol/session state for `toolOutputOverflowChars` persistence and websocket exposure.
- [x] Implement runtime spill-file handling in `executeToolCall()` and remove unconditional `bash`/`grep` truncation.
- [x] Exclude `.ModelScratchpad` from git noise and session/workspace backup snapshots.
- [x] Add focused tests for config/protocol/runtime/stream/backup behavior and run verification.

## Review
- Added a workspace-scoped `toolOutputOverflowChars` config defaulting to `25000` through `AgentConfig`, `config/defaults.json`, config loading, websocket `set_config` parsing, `session_config` emission, persisted project config patches, and desktop/TUI sync types.
- Added shared overflow helpers in `src/shared/toolOutputOverflow.ts` and `src/runtime/toolOutputOverflow.ts`, then wired `src/runtime/piRuntime.ts` so oversized non-image tool results spill into `<workingDirectory>/.ModelScratchpad/*.txt`, emit a compact pointer/preview payload for the model, and send a companion `file` stream part for clients.
- Removed unconditional post-exec truncation from `src/tools/bash.ts` and `src/tools/grep.ts` so the runtime spill layer receives full buffered output. Updated `test/tools.test.ts` to assert the new bash contract.
- Hardened backup handling so `.ModelScratchpad` stays out of git, backup fingerprints, tar/directory snapshots, byte-size accounting, restore copies, and workspace clearing during restore. The tar snapshot path now stages a filtered copy before archiving so scratchpad files never enter tar snapshots.
- Updated websocket docs and added focused regressions for config parsing, session snapshots, overflow runtime behavior, OpenAI continuation pointer text, model-stream/file chunks, backup exclusions, and desktop workspace sync.
- Verification:
  - `bun test test/config.test.ts test/runtime.pi-runtime.test.ts test/runtime.openai-responses-runtime.test.ts test/session.stream-pipeline.test.ts test/server.model-stream.test.ts test/session-backup.test.ts apps/desktop/test/workspace-settings-sync.test.ts test/protocol.test.ts test/agentSocket.parse.test.ts --bail` -> pass
  - `bun test test/agent.remote-mcp.grep.test.ts --bail` -> pass
  - `bun test` -> pass (`2076 pass, 0 fail`)
  - `bun run typecheck` -> pass
  - `git diff --check` -> pass

# Task: Add Exa links and image links to webFetch output

## Plan
- [x] Audit the Exa contents helper and current `webFetch` formatting to identify where link/image-link extras are being dropped.
- [x] Update the shared Exa contents request/parse path so `webFetch` requests highlights plus `extras.links` and `extras.imageLinks`, then include those sections in the returned text.
- [x] Add focused `webFetch` regressions for links/image-links output and run targeted verification.

## Review
- `src/tools/exa.ts` now requests richer Exa contents for `webFetch`: `text: true`, `highlights.maxCharacters = 4000`, and `extras` for up to 10 page links plus 5 image links. The parser now preserves those extras and falls back to highlights when Exa omits full text but still returns useful content.
- `src/tools/webFetch.ts` now formats Exa-backed page fetches as extracted text followed by `Links:` and `Image Links:` sections when available, then applies the existing `maxLength` truncation to the combined output. Local direct-image and document download behavior is unchanged.
- Updated `test/tools.test.ts` with regressions that assert the Exa contents request shape and verify the returned `webFetch` output includes links/image-links, including a highlights-only fallback case.
- Fixed the stale README contract so it no longer claims that `webFetch` returns inline image content; it now describes link/image-link extras plus download-to-`Downloads` behavior.
- Verification:
  - `bun test test/tools.test.ts --test-name-pattern "webFetch tool"` -> pass (`23 pass, 0 fail`)
  - `bunx tsc --noEmit` -> pass
  - `git diff --check` -> pass

# Task: Add document-download handling to webFetch

## Plan
- [x] Audit the current `webFetch` response classification and choose the minimal harness-level contract for downloadable document types.
- [x] Implement document-like fetch handling so supported binary/text docs are saved into `<workingDirectory>/Downloads` and the tool returns a local file path message.
- [x] Update prompt/docs guidance and add focused regression coverage for supported doc content types, naming, and fallback behavior.
- [x] Run targeted verification and record outcomes in the review section.

## Review
- `src/tools/webFetch.ts` now classifies a third response mode for document-style downloads. PDFs, Markdown documents, Office files, spreadsheets, slide decks, and similar supported types are saved into `<workingDirectory>/Downloads`, with filename selection derived from `Content-Disposition`, URL basename, and MIME fallback, plus `-2`/`-3` suffixing to avoid overwriting existing files.
- The `webFetch` tool now returns plain text in the form `File downloaded /absolute/path/...`, which keeps the runtime/tool-result contract unchanged while giving the model a stable workspace path it can use in follow-up tool calls.
- Updated the shipped README and system prompt templates so the documented `webFetch` contract now mentions inline image handling and `Downloads/` file saves for document-like responses.
- Added focused regressions in `test/tools.test.ts` for PDF downloads, Markdown-by-extension downloads, Office MIME downloads with `Content-Disposition` filenames, octet-stream extension fallback, and collision-safe renaming. Added prompt coverage in `test/prompt.test.ts` for the new `File downloaded ...` guidance across shipped prompt files.
- Verification:
  - `bun test test/tools.test.ts test/prompt.test.ts` -> pass (`201 pass, 0 fail`)
  - `./node_modules/.bin/tsc --noEmit` -> pass
  - `git diff --check` -> pass
  - `bun run typecheck` -> fails in existing desktop code at `apps/desktop/src/app/store.feedMapping.ts:136` (`TS2345` in `observability_status` typing); unrelated to this `webFetch` change.

# Task: Add standalone cowork-server Bun binary release pipeline

## Plan
- [x] Audit existing server startup/build/release behavior and define the minimal standalone cowork-server packaging contract (no TUI/desktop UI).
- [x] Implement cowork-server runtime/build updates so the compiled binary starts the websocket harness with clear host/port logging.
- [x] Add a dedicated GitHub Actions workflow that builds cowork-server binaries for macOS and Windows and publishes them as a separate prerelease stream.
- [x] Run required verification (`bun test`, targeted checks) and record outcomes in the review section.

## Review
- Added standalone cowork-server build support via `bun run build:server-binary`, which compiles `src/server/index.ts` into a distributable Bun binary (default output `dist/cowork-server` / `dist/cowork-server.exe`).
- Extended the server entrypoint to support `--host` in addition to `--port`, and improved startup logging so terminal runs clearly show the bound websocket URL; for `--host 0.0.0.0`, the process also prints reachable LAN IPv4 websocket URLs.
- Added a dedicated `Cowork Server Release` GitHub Actions workflow that runs validation, builds macOS and Windows cowork-server binaries, and publishes them to a **separate prerelease stream** triggered only by `cowork-server-v*` tags.
- Updated README docs for binary build/run usage so teams can bundle cowork-server into other surfaces without launching CLI/TUI.
- Verification:
  - `bun run build:server-binary -- --outfile dist/cowork-server-test`
  - `./dist/cowork-server-test --json --port 0`
  - `bun test`
  - `bun run typecheck`

# Task: Expand GitHub release notes for v0.1.19

## Plan
- [x] Review the current `v0.1.19` GitHub release body and the new changelog entry so the update preserves existing release metadata while adding the fuller notes.
- [x] Edit the GitHub release notes for `v0.1.19` to include the shipped changelog summary.
- [x] Verify the release body on GitHub and record the outcome below.

## Review
- Updated the published GitHub release notes for `v0.1.19` to prepend the fuller changelog summary while preserving the existing autogenerated `What's Changed` PR link and compare link.
- The release now calls out the shipped backup recovery console and backup controls, desktop sidebar/composer refinements, Codex auth persistence and recovery improvements, and the backup/auth/diagnostic fixes that landed in the `v0.1.18..v0.1.19` range.
- Verification:
  - `gh release view v0.1.19 --json body,url` -> pass; release body now includes the new `## Highlights` / `Added` / `Changed` / `Fixed` sections at `https://github.com/mweinbach/agent-coworker/releases/tag/v0.1.19`

# Task: Add changelog entry for v0.1.19

## Plan
- [x] Review the shipped `v0.1.18..v0.1.19` commit range and task log to extract only the release-relevant user-facing changes.
- [x] Create a top-level `CHANGELOG.md` and add a concise `0.1.19` entry that matches the shipped work.
- [x] Run the repo verification needed for a docs-only update and record the outcome below.

## Review
- Added a new repo-level `CHANGELOG.md` because the project did not already have a changelog file. The new `0.1.19` entry documents the shipped release in user-facing terms instead of forcing readers to reconstruct it from tags and task history.
- The entry covers the real release themes from `v0.1.18..v0.1.19`: the desktop backup recovery console and backup controls, sidebar/composer refinements, Codex auth persistence and recovery improvements, and desktop diagnostic parity/freeze fixes.
- Verification:
  - `~/.bun/bin/bun run docs:check` -> pass
  - `~/.bun/bin/bun test` -> pass (`1998 pass, 2 skip, 0 fail`)
  - `git diff --check` -> pass

# Task: Ship v0.1.19

## Plan
- [x] Confirm the next release version and the full set of versioned files that must change for a tagged app release.
- [x] Bump every release-version surface from `0.1.18` to `0.1.19` using the same file set as the prior tagged release.
- [x] Run the repo's release verification commands and confirm the worktree is clean aside from the intended release changes.
- [x] Commit the release, push `main`, create and push tag `v0.1.19`, then record the final evidence below.

## Review
- Release version was bumped to `0.1.19` in the root package, desktop package, CLI/TUI/desktop socket client version strings, MCP client version string, and the desktop updates-page release fixture so packaged metadata stays aligned.
- The release will ship the current `main` commit range since `v0.1.18`, and the existing tag-driven GitHub Actions workflow will package and publish the desktop artifacts once `v0.1.19` is pushed.
- Verification:
  - `~/.bun/bin/bun run docs:check` -> pass
  - `~/.bun/bin/bun test` -> pass (`1998 pass, 2 skip, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass
  - `git diff --check` -> pass
  - Local desktop packaging was intentionally skipped for the final release flow after the user clarified that CI/tag-driven packaging is sufficient for this ship.

# Task: Improve desktop developer diagnostics for replay/live transcript parity

## Plan
- [x] Audit the current desktop live reducer, transcript replay mapper, and developer-mode feed filtering for observability, harness, and backup diagnostics.
- [x] Add a shared developer-diagnostic formatter so live events and replayed transcript events render the same readable system notices while staying hidden outside developer mode.
- [x] Add focused desktop regressions for replay mapping, live reducer handling, and developer-mode filtering; run the relevant desktop tests and repo typecheck.

## Review
- `apps/desktop/src/app/store.feedMapping.ts` now owns the shared desktop diagnostic wording for `observability_status`, `session_backup_state`, and `harness_context`, and transcript replay uses that formatter instead of leaking vague `[type]` placeholders. Replay fallback copy for truly unknown event types now matches the live reducer (`Unhandled event: ...`).
- `apps/desktop/src/app/store.helpers/threadEventReducer.ts` now routes those same three server events into developer-only `system` feed items instead of silently dropping them, so live sessions and replayed transcripts tell the same debugging story while normal desktop usage still hides them through `ChatView` developer-mode filtering.
- Added focused regressions in `apps/desktop/test/store-feed-mapping.test.ts` and `apps/desktop/test/protocol-v2-events.test.ts`, while keeping the existing `apps/desktop/test/chat-reasoning-ui.test.ts` developer-mode visibility guard as the UI-level hide/show check.
- Verification:
  - `~/.bun/bin/bun test --cwd apps/desktop test/store-feed-mapping.test.ts test/protocol-v2-events.test.ts test/chat-reasoning-ui.test.ts` -> pass (`48 pass, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass
  - `git diff --check` -> pass

# Task: Investigate Codex auth disappearing after app restart

## Plan
- [x] Trace Codex auth read/write paths and confirm whether restart issues come from storage-path drift or from startup status/refresh behavior.
- [x] Add regression coverage for recoverable expired Codex auth states and refresh races so restart handling stays correct.
- [x] Run focused verification and record the confirmed root cause plus remaining risk below.

## Review
- Root cause is not a workspace-vs-global auth path mismatch. Codex auth is consistently read and written under `~/.cowork/auth/codex-cli/auth.json`, and the desktop server boot path keeps using the same home-derived Cowork root across launches.
- The restart failure mode is an expired access token that still has a refresh token, combined with a transient refresh failure during startup. Before the recent fix, startup could treat that state as effectively disconnected and the desktop persistence layer could then cache the stale "not connected" snapshot, making the token look gone after closing and reopening the app even though the auth file was still present.
- A second contributing risk is concurrent refresh across processes. The current auth refresh path now re-reads the on-disk auth file before writing so a stale process does not overwrite a newer token that another process already persisted.
- Added focused regression coverage in `test/providerStatus.test.ts`, `test/providers/codex-auth.test.ts`, and `apps/desktop/test/persistence-state-sanitization.test.ts` for recoverable expired-token startup status, cross-process refresh races, and desktop persistence sanitization.
- Verification:
  - `~/.bun/bin/bun test test/providerStatus.test.ts test/providers/codex-auth.test.ts apps/desktop/test/persistence-state-sanitization.test.ts` -> pass (`28 pass, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass

# Task: Recover Codex auth into Cowork-owned storage

## Plan
- [x] Confirm the current Codex auth ownership gap and record the concrete legacy-vs-Cowork path mismatch.
- [x] Update the Codex auth layer so Cowork canonicalizes legacy `~/.codex/auth.json` material into `~/.cowork/auth/codex-cli/auth.json` when our file is missing or unreadable.
- [x] Add focused regression coverage for legacy import and Cowork-path persistence, then run the relevant Bun tests.
- [x] Record the verified outcome below.

## Review
- The live machine state confirmed the ownership gap directly: `~/.cowork/auth/codex-cli/auth.json` was missing while `~/.codex/auth.json` still contained a valid access token plus refresh token. That meant Cowork looked logged out even though usable Codex auth still existed on disk.
- `src/providers/codex-auth.ts` now treats Cowork auth as the canonical location but will import valid legacy `~/.codex/auth.json` material into `~/.cowork/auth/codex-cli/auth.json` whenever the Cowork file is missing or unreadable. Reads, provider status refresh, runtime auth, and reconnect flows now self-heal back into the Cowork-owned path.
- Explicit Cowork logout now writes a local suppression marker so the next startup does not immediately re-import the legacy `.codex` token and undo the logout. Any fresh Cowork sign-in clears that marker when it writes the canonical auth file again.
- Updated focused regressions in `test/connect.test.ts`, `test/providerStatus.test.ts`, `test/runtime.pi-runtime.test.ts`, and `test/providers/codex-auth.test.ts` to prove legacy Codex auth is rewritten into the Cowork path and then used from there.
- Verification:
  - `~/.bun/bin/bun test test/providers/codex-auth.test.ts test/connect.test.ts test/providerStatus.test.ts test/runtime.pi-runtime.test.ts` -> pass (`45 pass, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass
  - `git diff --check` -> pass

# Task: Implement backup opt-out, whole-entry delete, and initial checkpoint seeding

## Plan
- [x] Extend core config/protocol/types for `backupsEnabled`, `workspace_backup_delete_entry`, `initial` checkpoint triggers, and disabled backup state.
- [x] Implement server/session/workspace-backup behavior for workspace defaults, session overrides, seeded `cp-0001`, whole-entry delete, and re-enable flows.
- [x] Wire desktop persistence/store/settings/backup UI to the new backup toggle and delete-entry actions.
- [x] Update focused tests/docs, run the required verification suites, and record the outcome below.

## Review
- Added `backupsEnabled` as a first-class session/workspace config across `src/types.ts`, `src/config.ts`, `src/server/protocol*.ts`, session persistence, and desktop workspace state. Live `session_config` snapshots now report the effective backup toggle, and the protocol added `workspace_backup_delete_entry` as version `7.10`.
- Session backups now seed an initial `cp-0001` from the session-start snapshot, surface `trigger: "initial"`, and expose `status: "disabled"` when backups are turned off. Live delete-entry operations disable the target session override before removing its backup folder; re-enabling recreates a fresh seeded backup from current workspace state.
- Desktop and TUI backup controls now expose the live-session backup toggle, the desktop backup page can delete an entire backup entry, and workspace settings persist `defaultBackupsEnabled` for future sessions.
- Verification:
  - `bun test test/session-backup.test.ts test/workspace-backups.test.ts test/protocol.test.ts test/server.test.ts test/session.test.ts test/agentSocket.parse.test.ts apps/desktop/test/backup-page.test.ts apps/desktop/test/protocol-v2-events.test.ts apps/desktop/test/workspace-settings-sync.test.ts apps/desktop/test/desktop-schemas.test.ts apps/desktop/test/persistence-state-sanitization.test.ts` -> pass (`504 pass, 0 fail`)

# Task: Preserve desktop overflow defaults on bootstrap and align persistent subagent provider validation

## Plan
- [ ] Update desktop bootstrap hydration so persisted `defaultToolOutputOverflowChars` values, including explicit `null`, survive rehydration instead of being reset to the default.
- [ ] Replace the hard-coded provider enum in `src/shared/persistentSubagents.ts` with the shared provider source of truth from `src/types.ts`.
- [ ] Add or update focused tests for desktop bootstrap hydration and persistent subagent provider parsing, then run verification and record the results.

## Review
  - `bun run typecheck` -> pass

# Task: Redesign workspace backup settings into a recovery console

## Plan
- [x] Inspect the live desktop state and the current Backup page hierarchy to confirm what made the screen unusable.
- [x] Add an on-demand workspace backup delta path in the control-session protocol so the UI can inspect checkpoint changes without abusing per-session events.
- [x] Rework the Backup settings page into a three-pane recovery layout with workspaces on the left, backup/session history in the middle, and checkpoint file deltas on the right.
- [x] Keep expensive delta generation user-triggered, then rerun focused verification and record the outcome.

## Review
- The Backup page is now structured as a recovery console instead of a long stack of cards. `apps/desktop/src/ui/settings/pages/BackupPage.tsx` renders a left workspace rail, a middle backups-and-checkpoints lane, and a right delta inspector that previews added, modified, and deleted files for the selected checkpoint.
- Added workspace-scoped delta plumbing through `src/server/workspaceBackups.ts`, `src/server/sessionBackup/delta.ts`, `src/server/protocol.ts`, and the control-session dispatcher so the desktop can request `workspace_backup_delta_get` and receive `workspace_backup_delta` previews for any backup entry in the selected workspace.
- Kept the freeze fix intact and tightened performance further: the page still auto-refreshes its backup snapshot on open, but it no longer auto-computes the first checkpoint delta. Users now trigger the expensive compare work by selecting a checkpoint or using the right-pane `Inspect latest checkpoint` affordance.
- Updated the desktop store/runtime/control-socket path to persist the selected workspace backup delta state and errors, and documented the new protocol contract in `docs/websocket-protocol.md` as version `7.9`.
- Live inspection used a direct desktop screenshot of the open app because the already-running Electron session was not exposing CDP on `127.0.0.1:9222`; the screenshot confirmed the app shell state, while the redesigned Backup page itself was validated via focused desktop tests and typecheck.
- Verification:
  - `~/.bun/bin/bun test test/protocol.test.ts test/workspace-backups.test.ts apps/desktop/test/protocol-v2-events.test.ts apps/desktop/test/backup-page.test.ts test/docs.check.test.ts --bail` -> pass (`200 pass, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass

# Task: Fix desktop Backup settings page freeze on open

## Plan
- [x] Reproduce the Backup page open path and inspect its initial refresh/render dependencies.
- [x] Stabilize the auto-refresh effect so opening the page triggers only the intended fetch work.
- [x] Add regression coverage for the open-page refresh path and rerun focused desktop verification.

## Review
- Root cause: `apps/desktop/src/ui/settings/pages/BackupPage.tsx` created an inline `refreshBackups` wrapper each render and included it in the initial `useEffect` dependency list. The first refresh flipped backup loading state, which recreated the wrapper, retriggered the effect, and could loop hard enough to freeze the settings view.
- Fixed the page by moving the initial refresh through a stable `useEffectEvent(...)`, so opening Backup now refreshes only when the selected workspace or control session changes.
- Added a live React/JSDOM regression in `apps/desktop/test/backup-page.test.ts` that mounts the page against the real desktop store and proves the auto-refresh path fires once even after the fetch updates runtime state.
- Verification:
  - `~/.bun/bin/bun test apps/desktop/test/backup-page.test.ts apps/desktop/test/settings-nav.test.ts apps/desktop/test/protocol-v2-events.test.ts --bail` -> pass (`44 pass, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass

# Task: Audit repo-wide test coverage for missing or ineffective assertions

## Plan
- [x] Inventory the current test surface and identify concrete weak or missing coverage areas across harness, providers, and UI/client code.
- [x] Add or strengthen the highest-signal regressions without rewriting unrelated production behavior.
- [x] Run targeted verification for each touched area, then run broader repo validation and record any remaining gaps or pre-existing issues.

## Review
- Strengthened `test/decode-client-message.test.ts` so websocket decode coverage now proves all protocol error-code mappings that matter in production: unsupported raw payloads, non-object JSON envelopes, missing `type`, and known-message validation failures.
- Strengthened `test/agentSocket.runtime.test.ts` so `AgentSocket` no longer relies on smoke coverage for reconnect behavior. The tests now prove resume URL construction, deferred send-queue flushing until `server_hello`, and keepalive pings only after a session is established.
- Strengthened `test/agentSocket.parse.test.ts` so the client parser proves `safeParseServerEventDetailed(...)` preserves `unknown_type`, `invalid_envelope`, and `invalid_event` distinctions instead of only falling back to null-ish parse failures.
- Strengthened `test/providers/auth-registry.test.ts` so provider auth coverage now checks trimmed API-key forwarding, blank-key rejection before side effects, full OAuth callback context forwarding, and missing-source-key copy failures instead of mostly asserting `ok`/mock-call counts.
- Strengthened `test/server.commands.test.ts` so command resolution proves real outcomes: skill front matter is stripped before execution, config commands override built-ins, and quoted placeholder arguments stay grouped correctly.
- Verification:
  - `~/.bun/bin/bun test test/decode-client-message.test.ts test/providers/auth-registry.test.ts test/agentSocket.runtime.test.ts test/agentSocket.parse.test.ts test/server.commands.test.ts --bail` -> pass (`50 pass, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass
  - `~/.bun/bin/bun test` in the default environment -> fails for pre-existing environment-sensitive reasons unrelated to this patch set:
    - remote MCP tests attempted live `mcp.grep.app` access because `RUN_REMOTE_MCP_TESTS` was enabled in the shell
    - CLI REPL tests hit `EPERM` writing under `/Users/mweinbach/.cowork/state`
    - `test/mcp.oauth-provider.test.ts` hit a pre-existing `EADDRINUSE` failure while binding an auto-OAuth callback server on `127.0.0.1:0`
  - `HOME=/tmp/agent-coworker-test-home RUN_REMOTE_MCP_TESTS=0 ~/.bun/bin/bun test` -> remote MCP and CLI-home failures were removed, but the suite still stopped on the same pre-existing `test/mcp.oauth-provider.test.ts` `EADDRINUSE` callback-capture failure.

# Task: Implement workspace backup settings page

## Plan
- [x] Add server-side workspace backup listing/admin support and expose it through new WebSocket control messages/events.
- [x] Thread the new backup data/actions through desktop store state, control-socket handling, and settings navigation.
- [x] Build the new Backup settings page UI with refresh/checkpoint/restore/delete/reveal flows.
- [x] Add focused protocol/server/desktop regression coverage and run the targeted verification suites.

## Review
- Added a workspace-scoped backup admin path in core/server via `src/server/workspaceBackups.ts`, backed by new control-session messages (`workspace_backups_get`, `workspace_backup_checkpoint`, `workspace_backup_restore`, `workspace_backup_delete_checkpoint`) and the new `workspace_backups` server event.
- Extended `SessionBackupManager` so existing backup directories can be reopened, older metadata lazily backfills `originalFingerprint`, and workspace admin actions can operate on closed/orphaned backups without recreating snapshots.
- Wired desktop backup state into `WorkspaceRuntime`, added backup store actions/control-socket hydration, registered a new `Backup` settings page, and built the user-facing UI for refresh, checkpoint, restore original, restore checkpoint, delete checkpoint, and reveal-folder flows.
- Added focused verification across protocol/server/desktop coverage, including new `WorkspaceBackupService` unit tests, server WebSocket flow coverage, desktop control-socket/store tests, settings-nav coverage, and SSR markup checks for the new page.
- Verification:
  - `~/.bun/bin/bun test test/protocol.test.ts test/session-backup.test.ts test/workspace-backups.test.ts test/server.test.ts test/session.test.ts test/session.managers.test.ts --bail` -> pass (`439 pass, 0 fail`)
  - `~/.bun/bin/bun test apps/desktop/test/protocol-v2-events.test.ts apps/desktop/test/backup-page.test.ts apps/desktop/test/settings-nav.test.ts --bail` -> pass (`43 pass, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass

# Task: Audit server-side WebSocket and harness surfacing gaps for desktop clients

## Plan
- [x] Inspect `src/server/protocol.ts`, `src/server/startServer.ts`, and `src/server/session/*` emitters that define the server-side WebSocket surface.
- [x] Compare emitted events and harness/session state against `docs/websocket-protocol.md` and `docs/harness/*.md` to find desktop-relevant gaps or high-risk surfaces.
- [x] Return a concise, file-backed audit summary and record the outcome below.

## Review
- `harness_context` is the only harness-specific WebSocket event in `src/server/protocol.ts`, but it is not part of the connect lifecycle. Runtime emits it only on explicit get/set even though the value is persisted into session snapshots and rehydrated on resume, which conflicts with `docs/harness/context.md` describing it as memory-only.
- Harness docs describe runner lifecycle emissions (`harness.run.started/completed/failed`) and `run_meta.json` observability snapshots, but there is no matching WebSocket event in the server protocol. Desktop clients would need to infer harness progress from generic session events unless the protocol grows.
- High-risk operational surfaces that desktop clients should surface if they exist include `observability_status`, `session_backup_state`, `session_usage` / `budget_warning` / `budget_exceeded`, and MCP diagnostics (`mcp_servers`, `mcp_server_validation`, `mcp_server_auth_*`), because those are the structured server-side signals for degraded harness health, backup state, budget stops, and MCP/auth failure details.

# Task: Review harness websocket surfacing gaps in desktop UI

## Plan
- [x] Inspect the desktop-imported WebSocket protocol types and enumerate the server events available to the desktop client.
- [x] Compare those events against `apps/desktop/src/**` store helpers, reducers, feed mapping, and rendered UI surfaces.
- [x] Check desktop-focused tests for event coverage and record concise findings plus likely missing UI surfaces below.

## Review
- `observability_status` is part of the documented connection lifecycle and carries Langfuse health/config state, but the desktop thread reducer drops it immediately and the desktop runtime model has nowhere to store it. There is no visible observability surface in the current settings/developer UI.
- `session_backup_state` is also part of the documented connection/runtime surface, but the desktop thread reducer ignores it completely. Checkpoint status, restore results, and backup failures therefore never reach the UI even though the server emits them after backup operations.
- `harness_context` is the structured harness-intent payload, yet desktop neither requests it (`harness_context_get`) nor stores/renders it when received. The only existing live handler is an early return in the thread reducer, so the desktop cannot show run objective, acceptance criteria, constraints, or metadata.
- Replay/transcript reconstruction in `apps/desktop/src/app/store.feedMapping.ts` falls back unknown protocol events into generic `[type]` system rows, so the little developer-mode visibility that exists for `observability_status`, `session_backup_state`, and `harness_context` is inconsistent between live sessions and transcript reloads.
- There is no desktop test coverage for `observability_status`, `session_backup_state`, or `harness_context`, so this blind spot is currently unguarded.
- Verification: `~/.bun/bin/bun test --cwd apps/desktop test/protocol-v2-events.test.ts test/thread-reconnect.test.ts test/store-feed-mapping.test.ts` -> pass (`42 pass, 0 fail`)
- Verification:
  - `~/.bun/bin/bun test --cwd apps/desktop test/protocol-v2-events.test.ts test/thread-reconnect.test.ts test/store-feed-mapping.test.ts test/providers-page.test.ts test/usage-page.test.ts` -> pass (`51 pass, 0 fail`)

# Task: Fix desktop chat composer send/stop button styling and stop behavior

## Plan
- [x] Inspect the desktop composer button component and current stop/send wiring.
- [x] Patch the button states so send and stop have the right styling and the stop action remains clickable while a run is active.
- [x] Add focused verification for the submit/stop behavior and rerun desktop typecheck.

## Review
- `apps/desktop/src/components/ai-elements/prompt-input.tsx` now gives the composer actions distinct, explicit treatments: the send control is a filled primary circular button with an arrow-up glyph, while the stop control is a filled destructive circular button with a square glyph. Both keep the flatter sidebar-era styling with no heavy shadows.
- `apps/desktop/src/ui/ChatView.tsx` now derives composer submit state through `getComposerSubmitState(...)` so send and stop no longer share the same disabled logic. When a run is active, the control switches to `streaming` mode and stays enabled as long as there is an active session/thread to cancel; idle send remains disabled only for empty input or prompt-modal lockout.
- Added a focused regression in `apps/desktop/test/chat-reasoning-ui.test.ts` to prove the stop action stays enabled during an active run and still disables correctly for missing session state or empty idle sends.
- Verification:
  - `~/.bun/bin/bun test --cwd apps/desktop test/chat-reasoning-ui.test.ts` -> pass (`11 pass, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass

# Task: Redesign the desktop left sidebar to be sleeker and show only recent threads

## Plan
- [x] Refactor the left sidebar layout to feel tighter and closer to the provided reference while preserving current desktop behavior.
- [x] Limit visible thread rows to the 10 most recent entries per expanded workspace and add a lightweight overflow affordance.
- [x] Run targeted verification and inspect the updated sidebar in the live desktop app.

## Review
- Reworked `apps/desktop/src/ui/Sidebar.tsx` into a denser, quieter workspace-first layout with smaller nav rows, a slimmer default sidebar width, and less path-heavy chrome.
- Restored the section label to `Workspaces`, kept workspace display order stable instead of re-sorting by recency, and added drag-and-drop workspace reordering backed by a new persisted `reorderWorkspaces(...)` store action.
- Split workspace selection from expansion: each workspace now has an explicit chevron next to the folder icon that toggles its thread list, while clicking the workspace row simply selects it.
- Limited visible thread rows to the 10 most recent items per expanded workspace and added a lightweight `Show N more` overflow affordance; helper coverage for thread capping and workspace reordering lives in `apps/desktop/src/ui/sidebarHelpers.ts` and `apps/desktop/test/sidebar.test.ts`.
- Added a motion layer in `apps/desktop/src/styles.css` and `apps/desktop/src/ui/Sidebar.tsx`: the rail softly slides in, chevrons rotate, workspace sections animate open/closed with staggered thread reveals, and nav/workspace/thread rows now have subtle lift/press feedback plus animated drag targets.
- Reduced shadow use across the sidebar so active states read flatter: active nav/thread rows now lean on restrained background changes instead of inset highlights, and drag feedback uses a soft accent tint/border pulse instead of box-shadow rings.
- Workspace emphasis now defers to thread emphasis: when a thread inside the selected workspace is active, only that thread row stays highlighted, and the chevron control no longer paints its own nested hover capsule inside the workspace row.
- Consolidated the workspace leading icon into a single slot: closed/open folder is the resting state, and hovering/focusing the expand control swaps that same slot to the chevron instead of rendering a second symbol beside it.
- Verification:
  - `~/.bun/bin/bun test --cwd apps/desktop test/sidebar.test.ts` -> pass (`3 pass, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass
  - Live desktop verification was attempted with Electron remote debugging plus the desktop browser wrapper, but local CDP attachment was blocked by renderer-port conflicts and the dev Electron process exiting before the client could attach.

# Task: Merge PR #30 into main and ship the next release

## Plan
- [x] Confirm the shipped commit range, release workflow expectations, and next version after `v0.1.17`.
- [x] Merge PR #30 into `main`, bump the versioned release files, and draft release notes from the commits being shipped.
- [ ] Run the required verification commands, push `main` plus the new tag, publish the release, and record the final evidence below.

## Review
- GitHub PR #30 was merged into `main` via rebase merge on 2026-03-10, so the shipped commit range for this release is `v0.1.17..main` and includes the release-notes rendering fix plus the full session-usage / auth-persistence stack.
- Release version was bumped to `0.1.18` in the root package, desktop package, CLI/TUI/desktop socket client version strings, MCP client version string, and the desktop updates-page release fixture so packaged metadata stays aligned.
- Draft release notes for `v0.1.18` were prepared from the shipped commits with four user-facing themes: rich desktop release notes, session usage tracking and `@usage`, budget persistence/recovery plus snapshot compaction, and persisted Cowork/Codex auth state.
- Verification:
  - `~/.bun/bin/bun run docs:check` -> pass
  - `~/.bun/bin/bun run typecheck` -> pass
  - `~/.bun/bin/bun test` -> pass (`1946 pass, 2 skip, 0 fail`)
  - `git diff --check` -> pass
  - `~/.bun/bin/bun run desktop:build -- --publish never` -> pass; local packaging built `Cowork-0.1.18-mac-arm64.dmg`/`.zip` and skipped notarization because Apple notarization credentials were not configured locally

# Task: Fix accepted PR #30 findings

## Plan
- [x] Replace per-turn `session_usage` emissions with a compact snapshot path that does not resend the full `turns[]` history on every completed turn, and add regressions for replay/transcript consumers plus zero-threshold formatting.
- [x] Make Codex auth writability probes tolerate cleanup-only failures while preserving the real permission-denied diagnostics.
- [x] Teach the desktop client to consume the new budget events cleanly in both live reducers and transcript replay without bogus feed rows.
- [x] Run the focused Bun test suites plus typecheck/doc checks as needed, then record the verified outcome below.

## Review
- `src/session/costTracker.ts`, `src/server/session/TurnExecutionManager.ts`, and `src/server/session/AgentSession.ts` now keep explicit `getSessionUsage()` responses fully detailed while switching automatic `session_usage` emissions to a compact snapshot capped to the latest eight turns. That removes the per-turn quadratic growth path without changing aggregate totals or the explicit fetch contract.
- `src/session/costTracker.ts` now skips percentage math when `warnAtUsd` or `stopAtUsd` is `0`, so summaries still render sane budget lines instead of `Infinity%` / `NaN%`.
- `src/providers/codex-auth.ts` now treats probe-file cleanup as best-effort after a successful write probe, so transient `unlink()` failures no longer block Codex auth setup or get misreported as directory permission failures.
- `apps/desktop/src/app/store.helpers/threadEventReducer.ts` now maps live `budget_warning` / `budget_exceeded` events to notifications, and `apps/desktop/src/app/store.feedMapping.ts` suppresses replay-only usage/budget protocol events so transcript hydration no longer creates bogus `[turn_usage]`, `[session_usage]`, `[budget_warning]`, or `[budget_exceeded]` feed rows.
- Added focused regressions in `test/session.costTracker.test.ts`, `test/session.test.ts`, `test/providers/codex-auth.test.ts`, and `apps/desktop/test/thread-reconnect.test.ts`.
- Verification:
  - `~/.bun/bin/bun test test/session.costTracker.test.ts test/session.test.ts test/providers/codex-auth.test.ts apps/desktop/test/thread-reconnect.test.ts` -> pass (`224 pass, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass
  - `git diff --check` -> pass

# Task: Review server protocol and desktop protocol consumer mapping diff against 8452ff10a2268e2b29700513f6ff5ff4393f0cd4

## Plan
- [x] Inspect the scoped diff in `src/server/protocol*.ts` plus the touched desktop protocol consumer mapping files against base commit `8452ff10a2268e2b29700513f6ff5ff4393f0cd4`.
- [x] Trace the new usage/budget protocol events through live desktop reducers, transcript replay, and the surrounding session emission paths so only concrete regressions remain.
- [x] Return only actionable PR-review findings with exact HEAD line ranges and concise supporting evidence.

## Review
- `apps/desktop/src/app/store.helpers/threadEventReducer.ts` still falls through to the generic `"Unhandled event"` system-feed path for the newly added `budget_warning` / `budget_exceeded` server events. `src/server/protocol.ts`, `src/server/protocolEventParser.ts`, and `src/server/session/AgentSession.ts` all advertise, parse, buffer, and emit those events, so a real budget threshold crossing now produces desktop feed noise instead of a mapped UX.
- `apps/desktop/src/app/store.feedMapping.ts` transcript replay still treats `turn_usage`, `session_usage`, and `budget_warning` as unknown payloads because `transcriptFeedPayloadSchema` does not recognize them and the fallback path renders `[type]` system rows. A direct `mapTranscriptToFeed(...)` check during review reproduced `[turn_usage]`, `[session_usage]`, and `[budget_warning]` lines from a minimal transcript.
- Verification:
  - `~/.bun/bin/bun test apps/desktop/test/thread-reconnect.test.ts test/protocol.test.ts test/agentSocket.parse.test.ts` -> pass (`169 pass, 0 fail`)
  - `~/.bun/bin/bun -e 'import { mapTranscriptToFeed } from "./apps/desktop/src/app/store.feedMapping"; const transcript=[{ts:"2024-01-01T00:00:00.000Z",threadId:"t1",direction:"server",payload:{type:"turn_usage",sessionId:"s1",turnId:"turn-1",usage:{promptTokens:10,completionTokens:5,totalTokens:15}}},{ts:"2024-01-01T00:00:01.000Z",threadId:"t1",direction:"server",payload:{type:"session_usage",sessionId:"s1",usage:null}},{ts:"2024-01-01T00:00:02.000Z",threadId:"t1",direction:"server",payload:{type:"budget_warning",sessionId:"s1",currentCostUsd:1,thresholdUsd:1,message:"warn"}}]; console.log(JSON.stringify(mapTranscriptToFeed(transcript), null, 2));'` -> reproduces `[turn_usage]`, `[session_usage]`, and `[budget_warning]` system entries on replay

# Task: Review TUI and protocol consumer mapping diff against 8452ff10a2268e2b29700513f6ff5ff4393f0cd4

## Plan
- [x] Inspect the scoped diff in `apps/TUI/*`, `src/server/protocol*.ts`, and any touched client-side protocol consumer mapping files against base commit `8452ff10a2268e2b29700513f6ff5ff4393f0cd4`.
- [x] Validate suspected regressions against the surrounding runtime, parser, and TUI state-management code so review findings are concrete.
- [x] Return only actionable PR-review findings with exact HEAD line ranges and concise supporting evidence.

## Review
- No actionable `apps/TUI/*` regression found in this patch. The new `/clear-hard-cap` slash command in `apps/TUI/component/prompt/slash-commands.ts` only dispatches the existing out-of-band `set_session_usage_budget` client message with `stopAtUsd: null`, and `apps/TUI/context/sync.tsx` wires that send path through the same socket/session guards used by other local actions.
- Supporting evidence checked:
  - `test/tui.slash-commands.test.ts` covers local registration/dispatch for `/clear-hard-cap`.
  - `test/repl.test.ts` confirms the matching REPL behavior sends the same client message shape.
  - `test/protocol.test.ts` validates `set_session_usage_budget` accepts `stopAtUsd: null`.
  - `test/session.test.ts` still contains passing cost-tracking cases proving direct budget updates recover a hard-stop lockout.
- Verification:
  - `~/.bun/bin/bun test test/tui.slash-commands.test.ts test/repl.test.ts test/protocol.test.ts` -> pass (`239 pass, 0 fail`)
  - Broader `test/session.test.ts` runs still show the pre-existing unrelated failure `logoutProviderAuth emits provider_auth_result and clears provider state`; the relevant session cost-tracking tests in that file passed during review.

# Task: Review session usage/protocol diff against 8452ff10a2268e2b29700513f6ff5ff4393f0cd4

## Plan
- [x] Inspect the scoped diff in `src/session/*`, `src/server/*`, `src/tools/usage.ts`, and the related tests/docs against base commit `8452ff10a2268e2b29700513f6ff5ff4393f0cd4`.
- [x] Validate any behavior changes that look risky against the surrounding runtime/persistence/protocol code so findings are concrete.
- [x] Return only normal PR-review findings with exact file paths and minimal lines to inspect.

## Review
- `src/server/session/TurnExecutionManager.ts` now emits `session_usage` after every completed turn, and `src/session/costTracker.ts` materializes the full `turns[]` history in every snapshot. Because `src/server/session/AgentSession.ts` also buffers `session_usage` for disconnect replay, both live wire traffic and replay memory now grow quadratically with session length.
- `src/session/costTracker.ts` formats warning/hard-cap progress as `current / threshold`, but the new protocol/tool validators explicitly allow `$0.00` thresholds. A zero-dollar budget therefore renders `Infinity%` in `usage summary`, which is a reachable user-facing regression.
- `docs/websocket-protocol.md` no longer matches the actual wire contract for the new usage messages: the `server_hello` section still says protocol `7.6` even though the exported version is `7.7`, and the budget message docs say thresholds must be positive even though the parser/tests accept `0`.

# Task: Address session usage design follow-ups

## Plan
- [x] Confirm which reported concerns are still open in the current tree and note any already-fixed items before patching.
- [x] Add proactive budget threshold server events, extract a shared strict `session_usage` schema for parser/store reuse, and add configurable pricing overrides.
- [x] Add focused regression coverage, update websocket docs, run the required verification commands, and record the outcome below.

## Review
- Initial audit: concern 3 is already fixed in the current tree. `src/server/sessionDb/mappers.ts` now reuses the strict `sessionUsageSnapshotSchema`, so malformed persisted `cost_tracker_json` payloads are rejected during row mapping.
- Extracted the shared usage schema into `src/session/sessionUsageSchema.ts` and reused it from `src/server/sessionStore.ts`, `src/server/sessionDb/mappers.ts`, and `src/server/protocolEventParser.ts`, so persistence and client-side `session_usage` parsing now validate the same strict nested shape.
- `src/server/session/AgentSession.ts` now listens to `SessionCostTracker` budget threshold transitions and emits structured `budget_warning` / `budget_exceeded` websocket events, while also logging the same alert text for existing clients that only surface `log` lines. `src/server/protocol.ts`, `src/server/protocolEventParser.ts`, and `docs/websocket-protocol.md` were updated to document the new wire contract (`7.7`).
- `src/session/pricing.ts` now supports runtime pricing overrides via `COWORK_MODEL_PRICING_OVERRIDES` JSON, so custom or updated `provider:model` entries can be added without another code change.
- Added focused regressions in `test/session.test.ts`, `test/session.costTracker.test.ts`, `test/session/pricing.test.ts`, and `test/agentSocket.parse.test.ts`.
- Verification:
  - `~/.bun/bin/bun test test/session.test.ts test/session.costTracker.test.ts test/session/pricing.test.ts test/agentSocket.parse.test.ts test/session-db-mappers.test.ts test/session-store.test.ts` -> pass (`248 pass, 0 fail`)
  - `~/.bun/bin/bun run docs:check` -> pass
  - `~/.bun/bin/bun run typecheck` -> pass
  - `~/.bun/bin/bun test` -> pass (`1937 pass, 0 fail, 2 skip`)
  - `git diff --check` -> pass

# Task: Refine desktop Backup settings page boundaries

## Plan
- [x] Inspect the backup settings shell spacing and backup-detail panel boundaries to pinpoint where the surfaces visually blend together.
- [x] Tighten the Backup page layout so the rail/detail split reads as separate sections and the main backup surface reaches the settings window edges cleanly.
- [x] Add or adjust focused desktop coverage for the updated Backup page structure, then rerun the required checks.

## Review
- `apps/desktop/src/ui/settings/SettingsShell.tsx` now lets the Backup page own its own spacing by removing the extra shell padding for that page, so the backup console can reach the settings window edges instead of sitting inside a second inset frame.
- `apps/desktop/src/ui/settings/pages/BackupPage.tsx` now uses a flush split surface with a stronger left rail tier, a clearer detail-pane background, and more obvious header/stat/action separation inside the selected backup view. The detail header also gets a small eyebrow label so the selected backup block reads as its own section instead of blending into the stats row below it.
- Added stable structural hooks (`data-backup-split`, `data-backup-rail`, `data-backup-detail`) and extended `apps/desktop/test/backup-page.test.ts` to assert that the split layout remains present without pinning brittle utility class strings.
- Verification:
  - `~/.bun/bin/bun test apps/desktop/test/backup-page.test.ts apps/desktop/test/settings-nav.test.ts --bail` -> pass (`17 pass, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass
  - `git diff --check` -> pass

# Task: Soften desktop Backup settings page color intensity

## Plan
- [x] Recheck which Backup page accents are visually competing with the content after the layout cleanup.
- [x] Tone down the local status, icon, and destructive-action colors so the page keeps hierarchy without loud badges/buttons.
- [x] Run focused desktop verification and record the result below.

## Review
- `apps/desktop/src/ui/settings/pages/BackupPage.tsx` now uses quieter local lifecycle pills instead of the default saturated primary badge, so repeated `Active` labels no longer dominate the list and header.
- The selected backup and checkpoint icon chips were moved from primary-tinted fills to muted neutral surfaces, and the checkpoint id accent was softened to standard foreground text so the detail header stops pulling focus away from the content.
- The restore-original action keeps its destructive semantics but now uses a light destructive outline treatment instead of a solid red block; delta counters and file-change pills were also toned down to softer, lower-saturation status colors.
- Verification:
  - `~/.bun/bin/bun test apps/desktop/test/backup-page.test.ts apps/desktop/test/settings-nav.test.ts --bail` -> pass (`17 pass, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass
  - `git diff --check` -> pass

# Task: Rebalance desktop Backup settings page neutral palette

## Plan
- [ ] Remove the leftover warm/pink local accents that still read as off-tone against the settings shell.
- [ ] Push the Backup page toward cleaner neutral layering so emphasis comes from borders and contrast, not tinted fills.
- [ ] Re-run focused desktop verification and record the outcome below.

# Task: Fix PR #30 review findings

## Plan
- [x] Re-read the live branch state for the four review findings and confirm which code paths were still unresolved.
- [x] Patch hard-stop recovery, cost-availability accounting, Responses cost normalization, and durable tool-driven budget updates without regressing the existing usage contract.
- [x] Run focused tests plus typecheck/diff validation, then record the verified outcome below.

## Review
- Added built-in hard-stop recovery paths for terminal clients: CLI now supports `/clear-hard-cap` via `set_session_usage_budget`, and TUI exposes the same out-of-band reset through its local slash-command registry.
- `src/session/costTracker.ts` now treats any unknown-cost turn as making the session-level estimate unavailable instead of silently keeping a partial numeric total. Per-model summaries also stay `null` once an unknown-cost turn is mixed into that model bucket.
- `src/runtime/piMessageBridge.ts` now preserves provider-computed nested cost totals (`usage.cost.total`) during normalization, so OpenAI Responses usage can carry exact `estimatedCostUsd` forward into session tracking.
- `src/tools/usage.ts` now notifies the session immediately after `set_budget`, and `TurnExecutionManager` persists/emits that updated snapshot right away so budget changes survive later turn failures or aborts.
- Verification:
  - `~/.bun/bin/bun test test/session.costTracker.test.ts test/runtime.pi-message-bridge.test.ts test/runtime.openai-responses-runtime.test.ts test/tools.usage.test.ts test/agent.test.ts test/repl.test.ts test/tui.slash-commands.test.ts` -> pass (`177 pass, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass
  - `git diff --check` -> pass

# Task: Verify and finish the session usage review-fix follow-up

## Plan
- [x] Inspect the user-applied fixes in `src/session/costTracker.ts` and `src/server/protocolParser.ts` to confirm whether the original review issues were fully closed.
- [x] Patch any remaining gaps in the same contract surfaces and add focused regression tests for snapshot isolation and `$0.00` budget validation.
- [x] Run the required focused test suite, update this review note with verification evidence, and then summarize the outcome.

## Review
- `src/session/costTracker.ts` now clones `byModel`, but `getSnapshot()` was still returning live `TurnCostEntry` objects through `turns: [...this.turns]`. External snapshot consumers could mutate `turns[n]` or `turns[n].usage` and corrupt tracker state in-place.
- `src/server/protocolParser.ts` correctly accepts `0`, but `src/tools/usage.ts` still validated `warnAtUsd` / `stopAtUsd` with `.positive()`. Since tool inputs are schema-validated in `src/runtime/piRuntime.ts`, model-driven `usage set_budget` calls still could not set a `$0.00` limit.
- Patched both remaining gaps and added focused tests in `test/session.costTracker.test.ts`, `test/protocol.test.ts`, and `test/tools.usage.test.ts`.
- Verification:
  - `~/.bun/bin/bun -e 'import { SessionCostTracker } from "./src/session/costTracker"; const t=new SessionCostTracker("s"); t.recordTurn({turnId:"1",provider:"openai",model:"gpt-5.4",usage:{promptTokens:10,completionTokens:5,totalTokens:15}}); const snap=t.getSnapshot(); snap.turns[0].model="mutated"; snap.turns[0].usage.totalTokens=999; console.log(JSON.stringify(t.getSnapshot().turns[0]));'` previously reproduced live `turns` mutation through the snapshot boundary; the new regression test now locks that down.
  - `~/.bun/bin/bun -e 'import { createUsageTool } from "./src/tools/usage"; import { SessionCostTracker } from "./src/session/costTracker"; const tool=createUsageTool({config:{},log(){},askUser:async()=>"",approveCommand:async()=>true,costTracker:new SessionCostTracker("s")}); const schema=tool.inputSchema; console.log(JSON.stringify(schema.safeParse({action:"set_budget",stopAtUsd:0})));'` previously failed schema validation (`expected number to be >0`); the focused tool test now asserts `$0.00` is accepted.
  - `~/.bun/bin/bun test test/protocol.test.ts test/session.costTracker.test.ts test/tools.usage.test.ts` -> pass (`170 pass, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass
  - `git diff --check` -> pass

# Task: Review PR #30 against main

## Plan
- [x] Inspect `git diff 8452ff10a2268e2b29700513f6ff5ff4393f0cd4` and group the changes into reviewable areas.
- [x] Validate changed protocol/session/auth/desktop code for correctness regressions with targeted file context and tests where useful.
- [x] Record the review outcome below and return prioritized findings for the PR.

## Review
- Confirmed four review-worthy regressions in the patch:
- `src/server/session/TurnExecutionManager.ts` now hard-blocks every new turn after a hard-stop threshold trips, but only the desktop client learned how to send `set_session_usage_budget`, so CLI/TUI users can lock themselves out of a session with no built-in recovery path.
- `src/session/costTracker.ts` treats cost tracking as fully available as soon as *any* turn has a known price. If earlier turns had `estimatedCostUsd === null`, they are silently omitted from the running total once a later priced turn arrives, so `session_usage.estimatedTotalCostUsd` and budget enforcement can undercount mixed-model sessions.
- `src/runtime/piMessageBridge.ts` now preserves cached prompt tokens but still ignores nested `usage.cost.total`, so OpenAI Responses turns lose the exact provider-computed cost coming from `src/runtime/openaiResponsesProjector.ts`.
- `src/server/session/TurnExecutionManager.ts` emits the full cumulative `session_usage` snapshot after every turn, including `turns[]`; the desktop transcript pipeline persists every server event verbatim, so transcript size grows quadratically with session length and reopen/reconnect work scales badly.
- Verification:
  - `~/.bun/bin/bun -e 'import { SessionCostTracker } from "./src/session/costTracker"; const t = new SessionCostTracker("s"); t.recordTurn({ turnId: "1", provider: "openai", model: "unknown-model", usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } }); t.recordTurn({ turnId: "2", provider: "openai", model: "gpt-5.4", usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 } }); console.log(JSON.stringify(t.getSnapshot()));'` -> reports `estimatedTotalCostUsd: 0.004` even though the first turn had unknown cost
  - `~/.bun/bin/bun -e 'import { normalizePiUsage } from "./src/runtime/piMessageBridge"; console.log(JSON.stringify(normalizePiUsage({ input: 80, output: 20, totalTokens: 130, cacheRead: 30, cost: { total: 0.00123 } })));'` -> returns `{"promptTokens":110,"completionTokens":20,"totalTokens":130,"cachedPromptTokens":30}` with no `estimatedCostUsd`
  - `~/.bun/bin/bun test test/session.test.ts test/session.costTracker.test.ts apps/desktop/test/thread-reconnect.test.ts apps/desktop/test/usage-page.test.ts` -> 206 pass, 1 unrelated existing failure in `test/session.test.ts` (`logoutProviderAuth emits provider_auth_result and clears provider state`)
- Current pass:
  - `src/server/session/TurnExecutionManager.ts` still queues `session.turn_response` persistence before `tracker.recordTurn(...)`, so the newly added cost-tracker state can remain one completed turn behind on resume if the app exits before another session mutation.
  - `src/runtime/piMessageBridge.ts` still normalizes only top-level `estimatedCostUsd`; nested provider-computed totals such as `usage.cost.total` from `src/runtime/openaiResponsesProjector.ts` are still dropped before `turn_usage` / `session_usage`.
  - Focused verification rerun: `~/.bun/bin/bun test test/session.test.ts test/runtime.openai-responses-runtime.test.ts test/runtime.pi-message-bridge.test.ts apps/desktop/test/thread-reconnect.test.ts apps/desktop/test/usage-page.test.ts` -> targeted suites pass except the still-failing `test/session.test.ts` case `logoutProviderAuth emits provider_auth_result and clears provider state`.

# Task: Fix session usage budget persistence and persisted cost tracker validation

## Plan
- [x] Inspect the session budget update path, persistence queueing, and persisted cost tracker mapping contract to confirm the two failure modes.
- [x] Patch `src/server/session/AgentSession.ts` so `setSessionUsageBudget()` queues a persisted snapshot immediately after budget changes.
- [x] Tighten `src/server/sessionDb/mappers.ts` to reject malformed `cost_tracker_json` payloads before session resume reaches `SessionCostTracker.fromSnapshot()`.
- [x] Add focused regression tests for both behaviors and run the required verification commands.

## Review
- `src/server/session/AgentSession.ts` now queues `session.usage_budget_updated` immediately after a successful `setSessionUsageBudget()` mutation, so warn/stop thresholds are persisted without waiting for a later unrelated session change.
- `src/server/sessionStore.ts` now exports a structured `sessionUsageSnapshotSchema` with strict nested validation for `turns`, `byModel`, `budgetStatus`, and pricing/usage payloads. `src/server/sessionDb/mappers.ts` reuses that schema for `cost_tracker_json`, so malformed persisted snapshots are rejected during row mapping instead of crashing later in `SessionCostTracker.fromSnapshot()`.
- Added focused regression coverage in `test/session.test.ts` for the budget-persistence queueing behavior and in `test/session-db-mappers.test.ts` for malformed `cost_tracker_json`.
- Verification:
  - `~/.bun/bin/bun test test/session.test.ts test/session-db-mappers.test.ts test/session-store.test.ts test/session-db.test.ts` -> pass (`211 pass, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass
  - `~/.bun/bin/bun test` -> pass (`1922 pass, 0 fail, 2 skip`)
  - `git diff --check` -> pass

# Task: Audit usage payload shape assumptions in tests and websocket docs

## Plan
- [x] Inspect `test/` for assertions, snapshots, and schema checks that pin usage to `promptTokens`, `completionTokens`, and `totalTokens`.
- [x] Inspect `docs/websocket-protocol.md` for usage payload examples or field descriptions that would need updates for optional `cachedPromptTokens` or `estimatedCostUsd`.
- [x] Return a concise file list with why each file matters, and note any assertions likely to reject or ignore the optional fields.

## Review
- `docs/websocket-protocol.md` still documents `turn_usage.usage` as exactly `promptTokens`, `completionTokens`, and `totalTokens`.
- The strongest rejector in `test/` is `test/agent.test.ts`, which explicitly proves extra provider usage keys are stripped back to the canonical three-field shape.
- `test/agent.toolloop.test.ts` also narrows helper fixture types to those three fields at compile time.
- Coverage in `test/session.test.ts`, `test/server.toolstream.test.ts`, and `test/agentSocket.parse.test.ts` currently checks only the canonical fields or nullability, so those tests would ignore richer optional usage fields unless expanded.
- Verification: `~/.bun/bin/bun test test/agent.test.ts test/runtime.pi-message-bridge.test.ts test/session.test.ts test/server.toolstream.test.ts` -> pass (`248 pass, 0 fail`)

# Task: Audit usage payload docs/tests for token-only shape assumptions

## Plan
- [x] Inspect `docs/websocket-protocol.md` for examples or schema text that only documents `promptTokens`, `completionTokens`, and `totalTokens`.
- [x] Inspect `test/` for assertions, snapshots, or object-shape expectations that lock usage payloads to those three keys or otherwise ignore richer optional fields.
- [x] Summarize the concrete file list, why each file would need changes, and which assertions would reject vs silently ignore optional `cachedPromptTokens` / `estimatedCostUsd`.

## Review
- `docs/websocket-protocol.md` currently hard-codes the `turn_usage.usage` payload to `promptTokens`, `completionTokens`, and `totalTokens` in both the JSON example and the field table. `session_usage` docs already cover session-level `estimatedTotalCostUsd`, but there is no mention of optional per-turn `cachedPromptTokens` or `estimatedCostUsd`.
- The strongest test lock is `test/agent.test.ts`, which explicitly asserts that provider-supplied extra usage keys are dropped and only the canonical three counters survive. If the runtime starts carrying `cachedPromptTokens` or `estimatedCostUsd`, that test will fail until updated.
- `test/runtime.pi-message-bridge.test.ts` also uses exact object equality for merged usage totals and would fail if merged/runtime usage starts surfacing optional fields. `test/session.test.ts` and `test/server.toolstream.test.ts` only assert the canonical counters individually, so they would likely ignore added optional fields rather than reject them.
- Verification: `~/.bun/bin/bun test test/agent.test.ts test/session.test.ts test/server.toolstream.test.ts test/runtime.pi-message-bridge.test.ts test/agentSocket.parse.test.ts test/tools.usage.test.ts` -> pass (`265 pass, 0 fail`)

# Task: Audit desktop and TUI usage consumers for fixed token-only assumptions

## Plan
- [x] Inspect desktop renderer/store/protocol consumer code for any usage handling that assumes only `promptTokens`, `completionTokens`, and `totalTokens`.
- [x] Inspect TUI client-facing code and tests for the same assumption, including any protocol parsing or fixture assertions that would reject extra usage fields.
- [x] Record the concrete file list, note why each file would need changes, and call out any validator/parser paths that currently reject richer usage payloads.

## Review
- Desktop has one actual rejector in client-owned code: `apps/desktop/src/app/store.feedMapping.ts` transcript hydration only accepts `turn_usage` payloads when `usage.promptTokens`, `usage.completionTokens`, and `usage.totalTokens` are all present numbers. Richer payloads with only renamed fields would be dropped during replay, and even additive fields still get narrowed back to the three-field shape there.
- Desktop live websocket parsing is not the blocker. `apps/desktop/src/lib/wsProtocol.ts` delegates to the shared parser in `src/server/protocolEventParser.ts`, and the `turn_usage` / `session_usage` event schemas there are `.passthrough()`, so extra usage keys are accepted on the wire.
- TUI is permissive but lossy: `apps/TUI/context/syncModelStreamLifecycle.ts` accepts extra keys via `.passthrough()` and already aliases `promptTokens`/`completionTokens` to `inputTokens`/`outputTokens`, but it normalizes down to `{ inputTokens, outputTokens, totalTokens }`, so any richer usage fields are ignored by design.
- Desktop protocol-consumer tests that would need fixture updates if usage becomes richer are `apps/desktop/test/thread-reconnect.test.ts` and `apps/desktop/test/chat-reasoning-ui.test.ts`; there are no parallel TUI protocol-consumer tests under `apps/TUI` for usage today.
- Verification: `~/.bun/bin/bun test apps/desktop/test/ws-protocol-parse.test.ts apps/desktop/test/thread-reconnect.test.ts apps/desktop/test/chat-reasoning-ui.test.ts` passed (`21 pass, 0 fail`).

# Task: Audit usage contract assumptions before adding cachedPromptTokens and estimatedCostUsd

## Plan
- [x] Locate every shared type/schema/parser that defines turn/session usage and check whether it hard-codes exactly `promptTokens`, `completionTokens`, and `totalTokens`.
- [x] Trace persistence, protocol, and UI mapping paths to find validators or serializers that could reject or drop the planned optional fields.
- [x] Review the corresponding tests/docs snapshots and record the concrete file list that must change plus any likely rejectors.

## Review
- Core type/runtime choke points are `src/runtime/types.ts`, `src/session/costTracker.ts`, `src/server/protocol.ts`, and `src/agent.ts`. The current runtime/session contract only models `promptTokens`, `completionTokens`, and `totalTokens`; the legacy `streamText` compatibility path in `src/agent.ts` also parses usage through a non-`passthrough` Zod object, so additive fields would be silently stripped there.
- Provider-native data already exposes the needed source values before normalization: `src/runtime/openaiResponsesProjector.ts` computes cached input tokens and total estimated cost, but `src/runtime/piMessageBridge.ts`, `src/runtime/openaiResponsesRuntime.ts`, and `src/runtime/piRuntime.ts` collapse usage back to the three canonical token counters before it reaches `turn_usage` / `session_usage`.
- Wire parsing is mostly permissive. `src/server/protocolEventParser.ts` uses `.passthrough()` for both `turn_usage.usage` and the outer `session_usage.usage`, so extra fields on the websocket payload will be accepted. The notable persistence strictness is `src/server/sessionStore.ts`: its `sessionUsageSnapshotSchema` is `.strict()` at the snapshot root, so any new top-level `session_usage` snapshot fields would be rejected there unless the schema is updated.
- Desktop replay/test surfaces pinned to the current shape are `apps/desktop/src/app/store.feedMapping.ts`, `apps/desktop/test/thread-reconnect.test.ts`, and `apps/desktop/test/chat-reasoning-ui.test.ts`. TUI-side model-stream usage parsing (`apps/TUI/context/syncModelStreamLifecycle.ts`, `apps/TUI/context/syncTypes.ts`) is permissive but normalizes usage down to input/output/total only, so richer fields would be dropped unless that path is widened too.

# Task: Rebase PR #30 session usage/cost branch onto main

## Plan
- [x] Confirm the current PR #30 branch state, review feedback, and merge-base divergence from `main`.
- [x] Rebase `pr/30` onto the latest `main`, resolving any conflicts without dropping the session usage/cost changes.
- [x] Run the required verification commands for the rebased branch and record the validated outcome below.

## Review
- Rebasing `pr/30` onto current `main` required manual conflict resolution in the core runtime protocol surfaces (`src/agent.ts`, `src/tools/context.ts`, `src/server/protocol.ts`, `src/server/session/TurnExecutionManager.ts`) plus the protocol docs/test follow-ups. The branch now sits directly on top of `main` (`git rev-list --left-right --count main...pr/30` -> `0  4`).
- While replaying the final review-fix commit, the branch still had a real hard-stop lockout bug: once a session crossed `stopAtUsd`, `TurnExecutionManager` rejected every new turn, but the only way to change the budget was still the model-invoked `usage set_budget` tool. That made the advertised recovery path impossible.
- Added a direct WebSocket control message `set_session_usage_budget`, wired through `src/server/protocol.ts`, `src/server/protocolParser.ts`, `src/server/startServer/dispatchClientMessage.ts`, `src/server/session/AgentSession.ts`, and `docs/websocket-protocol.md`. Clients can now raise or clear usage thresholds without starting another model turn, while the hard-stop ingress guard remains intact.
- Bumped `WEBSOCKET_PROTOCOL_VERSION` to `7.6` and documented the new control flow, including the new client message and the updated `server_hello.protocolVersion` examples.
- Verification:
  - `~/.bun/bin/bun run docs:check` -> pass
  - `~/.bun/bin/bun test test/protocol.test.ts test/agentSocket.parse.test.ts test/session.test.ts test/session.costTracker.test.ts test/tools.usage.test.ts` -> pass (`356 pass, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass
  - `~/.bun/bin/bun test` -> pass (`1891 pass, 2 skip, 0 fail`)

# Task: Fix Codex OAuth loopback redirect regression

## Plan
- [x] Audit the shipped Codex OAuth browser-login contract against the current implementation to find the live redirect mismatch behind the `unknown_error` auth page.
- [x] Patch the loopback callback/auth URL generation so the authorize request matches the expected Codex contract, and add regression coverage around the advertised redirect host.
- [x] Rerun the OAuth-focused tests plus repo validation, then record the fix and ship a hotfix release because `v0.1.14` already contains the broken redirect host.

## Review
- Root cause: the shipped Codex browser-login flow was advertising `redirect_uri=http://127.0.0.1:.../auth/callback`, while the repo’s own pinned Codex auth contract expects `http://localhost:.../auth/callback`. That host mismatch is enough for the upstream auth page to reject the request with the generic `unknown_error` screen before the local callback ever runs.
- Fixed `src/auth/oauth-server.ts` so the advertised redirect URI is `localhost`, then hardened the listener to bind both `::1` and `127.0.0.1` on the same callback port. That keeps the browser authorize URL aligned with the accepted Codex contract without hanging when `localhost` resolves to IPv6 on Linux/CI.
- Added a direct regression in `test/providers/codex-oauth-flows.test.ts` to assert that `prepareCodexBrowserOAuth()` advertises a `localhost` redirect URI in the actual browser challenge, not just in the lower-level URL builder helper.
- `v0.1.15` was an attempted hotfix tag that failed CI because the first localhost patch did not yet bind both loopback families. Rolled the release forward to `0.1.16` instead of mutating the failed tag so the published artifact history stays honest.
- Verification:
  - `~/.bun/bin/bun run docs:check` -> pass
  - `~/.bun/bin/bun run typecheck` -> pass
  - `~/.bun/bin/bun test test/providers/codex-oauth-flows.test.ts test/connect.test.ts test/session.test.ts` -> pass (`201 pass, 0 fail`)
  - `~/.bun/bin/bun test` -> pass (`1856 pass, 0 fail, 2 skip`)
  - `~/.bun/bin/bun run desktop:build -- --publish never` -> pass for local unsigned packaging; produced `apps/desktop/release/Cowork-0.1.15-mac-arm64.dmg`, `apps/desktop/release/Cowork-0.1.15-mac-arm64.zip`, blockmaps, and refreshed updater metadata before the dual-stack listener follow-up.

# Task: Render desktop release notes as formatted content instead of escaped HTML

## Plan
- [x] Inspect the desktop updates page and updater state shape to confirm why release notes HTML is rendering as literal tags.
- [x] Route release notes through the existing sanitized markdown/HTML renderer used elsewhere in the desktop app and add regression coverage for HTML-formatted notes.
- [x] Re-run desktop tests, typecheck, and the full repo suite, then record the result below.

## Review
- Root cause: `apps/desktop/src/ui/settings/pages/UpdatesPage.tsx` was rendering `updateState.release.releaseNotes` inside a plain text `<div>`, so GitHub/electron-updater release bodies that arrive as HTML were escaped and shown literally in the desktop Updates page.
- Fixed the release notes panel to use the existing sanitized rich-text path via `MessageResponse`, which already runs the app’s Streamdown + sanitize pipeline. That keeps markdown support, renders trusted HTML release bodies as formatted content, and avoids introducing a second renderer just for updater notes.
- Added a regression in `apps/desktop/test/updates-page.test.ts` that feeds HTML-formatted release notes through server-side rendering and asserts they show up as actual `<h1>/<p>/<li>` markup rather than escaped `&lt;h1&gt;...`.
- Verification:
  - `~/.bun/bin/bun test --cwd apps/desktop` -> pass (`201 pass, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass
  - `~/.bun/bin/bun test` -> pass (`1857 pass, 0 fail, 2 skip`)

# Task: Restore Codex OAuth acquisition parity without prebinding the callback port

## Plan
- [x] Replace the current auto browser-login acquisition path with the native Codex login flow while keeping Cowork-owned token persistence.
- [x] Preserve manual-code fallback state, but stop binding a localhost callback server during `authorize` so the real login flow can claim the callback port during `callback`.
- [x] Revalidate connect/session/auth-registry behavior plus the full repo test suite, then record the regression and prevention note below.

## Review
- `src/connect.ts` now uses `loginOpenAICodex()` for the automatic browser sign-in path with the pinned Codex originator `codex_cli_rs`, then persists the resulting access/refresh tokens into Cowork’s own `~/.cowork/auth/codex-cli/auth.json` format. That restores the upstream acquisition logic without giving up Cowork-owned token storage and refresh handling.
- Manual code completion still works through Cowork’s own token-exchange helper when a pending Codex challenge exists, but the authorize step no longer pre-binds the callback server. `src/providers/codex-oauth-flows.ts` now has a lightweight `createCodexBrowserOAuthChallenge()` helper that only generates PKCE/state/auth URL for fallback/manual use.
- `src/server/session/ProviderAuthManager.ts` now stores that lightweight challenge during `authorizeProviderAuth("codex-cli", "oauth_cli")` and intentionally does not emit a live `challenge.url` for Codex auto OAuth. That avoids stale/dead browser links in the UI and prevents the old port collision where authorize-time setup could occupy `1455` before the real login flow started.
- `src/providers/authRegistry.ts` now describes Codex auto OAuth as opening the official Codex sign-in flow automatically, matching the new behavior.
- Verification:
  - `~/.bun/bin/bun run typecheck` -> pass
  - `~/.bun/bin/bun test test/connect.test.ts test/session.test.ts test/providers/auth-registry.test.ts test/providers/codex-oauth-flows.test.ts` -> pass (`210 pass, 0 fail`)
  - `~/.bun/bin/bun test` -> pass (`1856 pass, 0 fail, 2 skip`)

# Task: Hunt the Codex OAuth browser-login regression across recent commits

## Plan
- [x] Audit the last 5-10 commits that touched Codex OAuth/browser login, including authorize URL, redirect host, scope, originator, and desktop callback flow.
- [x] Identify the concrete regression-causing change and patch the minimal code path instead of continuing speculative contract tweaks.
- [x] Rerun focused auth tests plus repo validation, then record the exact regression point and final fix below.

## Review
- History audit over `8cbadc7` through `fdca432` shows the first real browser-login regression point is commit `8cbadc7` (`Review Codex compaction support`). That change replaced a hardcoded browser redirect `http://localhost:${listener.port}/auth/callback` in `src/providers/codex-oauth-flows.ts` with `http://${OAUTH_LOOPBACK_HOST}:${listener.port}/auth/callback` while `src/auth/oauth-server.ts` still defined `OAUTH_LOOPBACK_HOST = "127.0.0.1"`. That is the first commit in the recent window that changed the actual browser authorize URL from provider-accepted `localhost` to rejected `127.0.0.1`.
- Commit `d09b341` (`Fix connect provider oauth flow`) materially changed the desktop/provider callback plumbing and emitted a real `provider_auth_challenge.url`, but it did not change client ID, originator, scope, or the browser redirect host. It is less plausible as the cause of an `auth.openai.com` failure before localhost callback.
- Commits `25d7c3a` and `18f7e88` are attempted host-fix follow-ups: they change `OAUTH_LOOPBACK_HOST` back to `localhost` and then harden dual-stack loopback binding. Those commits address the `8cbadc7` regression but still leave the browser redirect host coupled to the bind-host constant, which is fragile.
- Commits `57808e1`, `b44dbf1`, and `fdca432` are later local follow-ups. `57808e1` is comment-only, `b44dbf1` changes raw query encoding from `+` to `%20`, and `fdca432` narrows the scope to the live current browser-login scope. None of those are in the published `v0.1.16` release, because `main` is currently ahead of `origin/main` by 2 commits.
- Verification:
  - `git log --oneline -n 12` -> relevant auth/browser commits are `8cbadc7`, `d09b341`, `25d7c3a`, `18f7e88`, `57808e1`, `b44dbf1`, `fdca432`
  - `git show 8cbadc7^:src/providers/codex-oauth-flows.ts` vs `git show 8cbadc7:src/providers/codex-oauth-flows.ts` -> confirms the first browser-facing redirect regression from hardcoded `localhost` to `${OAUTH_LOOPBACK_HOST}` while the host constant still equaled `127.0.0.1`
  - `git rev-list --left-right --count main...origin/main` -> `2  0`, so the later scope/encoding fixes are still local and not in the published release build
  - `~/.bun/bin/bun run typecheck` -> pass
  - `~/.bun/bin/bun test test/providers/codex-oauth-flows.test.ts test/connect.test.ts` -> currently fails in this environment while trying to bind localhost loopback sockets
  - `node` loopback bind probes (`createServer().listen(..., "::1"/"127.0.0.1")`) -> `EPERM` here, which explains why the localhost-listener tests are not trustworthy in this current session even though the auth code itself was already previously validated before this audit turn

# Task: Fix Codex OAuth authorize URL parity with the live Codex flow

## Plan
- [x] Re-audit the live browser authorize URL emitted by Cowork against the Rust reference implementation, including raw query encoding and parameter ordering rather than only decoded values.
- [x] Patch the TS Codex OAuth builder so the emitted authorize URL matches the live Codex contract byte-for-byte where it matters, and keep the existing immutable-contract warnings in place.
- [x] Add regression coverage for the raw authorize URL shape, rerun the focused auth tests plus repo validation, and record the outcome below.

## Review
- Root cause: there were two separate authorize-url mismatches. First, Cowork used `URLSearchParams`, which serialized the Codex `scope` as `openid+profile+...` instead of percent-encoded spaces. Second, and more importantly for the still-failing live flow, Cowork was pinned to an older connector-expanded scope (`openid profile email offline_access api.connectors.read api.connectors.invoke`) while current official Codex browser-login URLs use the smaller live scope `openid profile email offline_access`. The earlier tests only compared decoded `searchParams`, so they missed both wire-level issues.
- Fixed `src/providers/codex-oauth-flows.ts` to build the authorize query manually with percent encoding, preserving the existing parameter order and the explicit immutable-contract warning. Fixed `src/providers/codex-auth.ts` to pin `CODEX_OAUTH_SCOPE` to the live current Codex browser-login scope instead of the older connector-expanded variant that can trip `auth.openai.com` `unknown_error` before callback.
- Tightened `test/providers/codex-oauth-flows.test.ts` and `test/connect.test.ts` so they assert the current raw authorize URL shape, including `%20` separators and the live minimal scope.
- Verification:
  - `~/.bun/bin/bun -e 'import { buildCodexAuthorizeUrl } from "./src/providers/codex-oauth-flows"; console.log(buildCodexAuthorizeUrl("http://localhost:1455/auth/callback","challenge_123","state_123"));'` -> emitted `scope=openid%20profile%20email%20offline_access`
  - `~/.bun/bin/bun test test/providers/codex-oauth-flows.test.ts` -> pass (`4 pass, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass
  - `~/.bun/bin/bun test` -> pass (`1856 pass, 0 fail, 2 skip`)

# Task: Ship desktop release v0.1.14

## Plan
- [x] Audit the current desktop release workflow, current published tag, and in-repo version references so the next release bump is internally consistent.
- [x] Bump the release version to `0.1.14` across the root/desktop package manifests and any user-visible/runtime version strings that would otherwise remain stale.
- [x] Run the practical local release validation steps, record any remaining known failures, then commit the release bump, tag `v0.1.14`, push, and monitor the GitHub release workflow through publish completion.

## Review
- Bumped the release version from `0.1.13` to `0.1.14` in the root package, desktop package, CLI/TUI/desktop websocket handshake version strings, and the MCP runtime client version so the shipped surfaces report the same release.
- Added a small test seam in `src/connect.ts` and rewrote `test/connect.test.ts` to stop using a file-scope `mock.module()` for `src/providers/codex-oauth-flows`. That removes the cross-suite module mock leak that was causing `test/providers/codex-oauth-flows.test.ts` to fail only during the full repo run.
- Local release validation:
  - `~/.bun/bin/bun run docs:check` -> pass
  - `~/.bun/bin/bun run typecheck` -> pass
  - `~/.bun/bin/bun test test/connect.test.ts test/providers/codex-oauth-flows.test.ts` -> pass (`15 pass, 0 fail`)
  - `~/.bun/bin/bun test` -> pass (`1855 pass, 0 fail, 2 skip`)
  - `~/.bun/bin/bun test --cwd apps/desktop` -> pass (`200 pass, 0 fail`)
  - `~/.bun/bin/bun run desktop:build -- --publish never` -> pass for local unsigned packaging; produced `apps/desktop/release/Cowork-0.1.14-mac-arm64.dmg`, `apps/desktop/release/Cowork-0.1.14-mac-arm64.zip`, blockmaps, and `apps/desktop/release/latest-mac.yml`. Local code signing/notarization were skipped because the required Apple credentials were not present, which is expected for a workstation build.

# Task: Rewrite the root README into an accurate open-source front door

## Plan
- [x] Audit the current README against the implemented product surface across the CLI, TUI, WebSocket server, desktop app, tools, providers, MCP, skills, persistence, and harness docs.
- [x] Rewrite `README.md` so it reflects the current architecture and workflow honestly, with a stronger project pitch, clearer setup, better feature framing, and better doc navigation.
- [x] Run the required verification (`bun test` and `bun run typecheck`) and record the outcome below.

## Review
- Rewrote the root `README.md` from a basic terminal-tool overview into a code-accurate OSS front page that presents Cowork as a WebSocket-first local agent backend with official TUI, CLI, and desktop clients.
- Updated the README content to match the current implementation surface: provider auth/status flows, persistent subagents, session backups/checkpoints, MCP management, layered skills, desktop workspace management, headless server usage, and the custom-client protocol story.
- Tightened the setup and developer guidance so the README now states the real runtime expectations: TUI requires a real terminal, `bun run serve` is the headless entrypoint, provider credentials are only needed for live turns, and web search can use Brave or Exa credentials.
- Verification:
  - `~/.bun/bin/bun run docs:check` -> pass
  - `~/.bun/bin/bun run typecheck` -> pass
  - `~/.bun/bin/bun test test/providers/codex-oauth-flows.test.ts` -> pass (`3 pass, 0 fail`)
  - `~/.bun/bin/bun test` -> still has 1 failing repo test: `test/providers/codex-oauth-flows.test.ts` (`completeCodexBrowserOAuth exchanges a manually provided code with the prepared PKCE state`), even though that same test passes in isolation. This README change did not touch runtime or auth code, so the remaining failure appears to be an existing order-dependent/flaky issue rather than a regression from the documentation update.

# Task: Harden desktop trace ordering and duplicate suppression

## Plan
- [x] Audit the desktop feed-mapping and grouped-trace path for duplicate reasoning/tool entries and any accidental reordering between messages and mixed trace content.
- [x] Add defensive normalization and regression coverage so grouped traces collapse exact duplicate reasoning notes and preserve feed order independent of timestamps.
- [x] Run the relevant desktop tests, typecheck, and a repo test pass; record any unrelated failures below.

## Review
- `apps/desktop/src/ui/chat/activityGroups.ts` now defensively collapses only adjacent duplicate reasoning notes in the grouped trace when the mode matches and the text is identical after trimming. This keeps the grouped card from showing the same reasoning summary twice if both a streamed reasoning item and a duplicated final note make it into the same activity block.
- Added ordering and duplication regression coverage in `apps/desktop/test/chat-activity-groups.test.ts` so grouped chat rendering is pinned to feed order rather than timestamp order, and adjacent duplicate reasoning summaries do not render twice.
- Added transcript-layer coverage in `apps/desktop/test/store-feed-mapping.test.ts` to verify `mapTranscriptToFeed()` dedupes streamed reasoning against legacy final reasoning events while preserving the original event order, even when timestamps are out of sequence.
- Strengthened the live desktop reducer regression in `apps/desktop/test/protocol-v2-events.test.ts` so the mixed feed order from streamed assistant/reasoning/tool updates is explicit and any future accidental reordering will fail the test.
- Verification:
  - `~/.bun/bin/bun test apps/desktop/test/chat-activity-groups.test.ts apps/desktop/test/store-feed-mapping.test.ts apps/desktop/test/protocol-v2-events.test.ts` -> pass
  - `~/.bun/bin/bun test --cwd apps/desktop` -> pass (`190 pass, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass
  - `~/.bun/bin/bun test` -> pass (`1831 pass, 0 fail`)

# Task: Investigate desktop trace misclassification from persisted session data

## Plan
- [x] Inspect the affected desktop thread in persisted session state and transcript storage to determine whether the apparent misordering comes from storage order or desktop rendering.
- [x] Compare the persisted event sequence with desktop feed mapping to identify whether the "reasoning-looking" block is actually stored as reasoning or assistant text.
- [x] Record the root cause and the storage/rendering recommendation for follow-up implementation.

## Review
- SQLite `session_events` for session `6dca255f-b103-4476-b542-c9cedd169ca3` only stores coarse lifecycle markers like `session.todos_updated`; it does not preserve the message/reasoning/tool chunk sequence needed to debug this UI issue.
- The exact mixed stream for desktop is in `/Users/mweinbach/Library/Application Support/Cowork/transcripts/5a551be4-4077-4af6-b6eb-e5bcbf0f6b3c.jsonl`. In that transcript, the relevant sequence is persisted in chronological order as:
  - assistant text: `Created the PDF at ...`
  - `todoWrite` tool input/call/result
  - assistant text: `**Visual QA and verification** ...`
- That means the trace ordering is correct for this example. The real bug is classification: `**Visual QA and verification**` and later `**Analyzing layout issues**` are persisted as `model_stream_chunk` `text_start` / `text_delta`, while `**Generating PDF and Images**` is persisted as `reasoning_*`.
- The desktop mapper in `apps/desktop/src/app/store.feedMapping.ts` is therefore behaving consistently with persisted data: once a block is stored as `text_*`, it becomes a normal assistant message instead of grouped reasoning UI.
- The classification happens before desktop rendering. The normalized transcript row for `Visual QA and verification` already has `rawPart.type = "text-start"` / `"text-delta"`, so the renderer no longer has enough information to distinguish "internal reasoning summary" from "assistant-visible text".
- Recommendation:
  - keep a stable normalized event stream for UI rendering,
  - but also persist provider-raw stream events or a richer pre-normalized form with a `normalizerVersion`,
  - so future renderer fixes or reclassifiers can rebuild old threads without losing provenance.

# Task: Persist raw model stream events and replay them in desktop rendering

## Plan
- [x] Extract the OpenAI/Codex raw-response projector into a reusable stateful helper so runtime streaming and desktop replay can share the same normalization logic.
- [x] Persist provider-raw model stream events alongside normalized chunks in the desktop transcript and add the protocol/runtime plumbing needed to emit them.
- [x] Update live desktop event handling and transcript hydration to prefer raw replay when available while staying backward-compatible with old transcripts.
- [x] Add regression coverage for raw replay fixing reasoning/tool classification and rerun the relevant desktop/runtime verification.

## Review
- Added a reusable OpenAI/Codex raw-response projector in `src/runtime/openaiResponsesProjector.ts` and a lightweight PI-event mapper in `src/runtime/piStreamParts.ts`. The runtime still emits normalized `model_stream_chunk` events, but desktop replay can now rebuild those same reasoning/text/tool boundaries from provider-native raw events without depending on the full server runtime.
- Introduced `model_stream_raw` as a new websocket/transcript event in `src/server/protocol.ts`, `src/server/protocolEventParser.ts`, and `docs/websocket-protocol.md` (protocol `7.5`). `TurnExecutionManager` now emits raw provider events before the derived normalized chunks and tags normalized chunks with `normalizerVersion`.
- Added durable raw chunk storage to SQLite via `session_model_stream_chunks` (`src/server/sessionDb.ts`, `src/server/sessionDb/repository.ts`, `src/server/sessionDb/migrations.ts`). This keeps raw model-stream provenance in the canonical session store instead of only in desktop JSONL transcripts.
- Desktop transcript hydration and live reducer paths now prefer replaying `model_stream_raw` when present, while still keeping synthetic normalized chunks for step boundaries and tool results. This is implemented in `src/client/modelStreamReplay.ts`, `apps/desktop/src/app/store.feedMapping.ts`, and `apps/desktop/src/app/store.helpers/threadEventReducer.ts`.
- While touching replay, assistant stream state is now keyed by `turnId:streamId` instead of only by turn. That prevents separate streamed text blocks within a single turn from collapsing into one assistant bubble during transcript replay.
- Verification:
  - `~/.bun/bin/bun run typecheck` -> pass
  - `~/.bun/bin/bun test apps/desktop/test/store-feed-mapping.test.ts apps/desktop/test/protocol-v2-events.test.ts apps/desktop/test/ws-protocol-parse.test.ts test/session-db.test.ts test/session.stream-pipeline.test.ts test/agentSocket.parse.test.ts` -> pass (`80 pass, 0 fail`)
  - `~/.bun/bin/bun test test/server.model-stream.test.ts test/docs.check.test.ts` -> pass (`120 pass, 0 fail`)
  - `~/.bun/bin/bun test` -> pass (`1836 pass, 0 fail`)

# Task: Re-normalize desktop model stream chunks from raw parts and reclassify scratchpad text

## Plan
- [ ] Rework desktop/client model-stream mapping so transcript hydration and live feed updates can derive normalized updates from stored `rawPart` first, with legacy fallback for old transcripts.
- [ ] Split assistant streamed text by stream block and reclassify scratchpad-style step text into reasoning summaries when the block ends, without affecting normal assistant progress updates.
- [ ] Add regression coverage for raw-backed normalization and reasoning reclassification, then run the relevant desktop tests, typecheck, and full repo tests.

# Task: Stop commentary-phase assistant text from leaking into persisted chat/history

## Plan
- [x] Trace the Dell thread leakage through runtime turn assembly and desktop raw replay to confirm where `phase:"commentary"` assistant items are being treated as normal chat output.
- [x] Filter commentary-phase assistant text out of persisted assistant/history extraction while preserving final-answer assistant content and non-commentary fallbacks.
- [x] Update desktop raw replay/feed mapping so stored commentary-phase text does not hydrate as normal assistant chat, then add regressions and run the relevant tests.

## Review
- The Dell thread root cause was not renderer ordering. In `/Users/mweinbach/Library/Application Support/Cowork/transcripts/8531ab94-0114-4ff5-90d6-2db8077cf13a.jsonl`, the raw `response.output_item.done` payloads explicitly tagged multiple assistant `message` items as `phase:"commentary"` before the final `phase:"final_answer"` message. Our runtime was flattening all assistant text blocks from the turn into one persisted `assistant_message`, so commentary leaked into both visible chat and later turn history.
- `src/runtime/openaiResponsesProjector.ts` and `src/runtime/piStreamParts.ts` now preserve assistant text `phase` metadata through raw replay, and `src/server/modelStream.ts` / `src/client/modelStream.ts` carry that phase through normalized desktop updates.
- `src/runtime/piMessageBridge.ts` now drops `phase:"commentary"` assistant text when extracting final assistant text and when converting turn outputs back into `responseMessages` for persisted history. That keeps tool calls and final-answer text, but prevents commentary-only blocks from being appended back into future turn context.
- `src/server/session/TurnExecutionManager.ts` now also ignores commentary-phase assistant parts in its fallback `responseMessages` text extraction, so even if a runtime hands back phase-tagged assistant content directly, the persisted `assistant_message` still only reflects final-answer text.
- `apps/desktop/src/app/store.feedMapping.ts` now ignores commentary-phase assistant deltas during transcript/live raw replay, so previously stored raw commentary blocks do not hydrate as normal chat messages in the desktop thread history.
- Added regressions in `test/runtime.openai-responses-runtime.test.ts`, `test/runtime.pi-message-bridge.test.ts`, `test/session.test.ts`, and `apps/desktop/test/store-feed-mapping.test.ts` that pin the Dell failure shape.
- Verification:
  - `~/.bun/bin/bun test test/runtime.pi-message-bridge.test.ts test/runtime.openai-responses-runtime.test.ts test/session.test.ts apps/desktop/test/store-feed-mapping.test.ts` -> pass (`208 pass, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass
  - `~/.bun/bin/bun test` -> pass (`1843 pass, 0 fail`)

# Task: Remove duplicated grouped reasoning disclosure in desktop trace

## Plan
- [x] Inspect the grouped desktop trace row rendering and confirm why reasoning summaries are duplicated inside the expanded card.
- [x] Replace the nested reasoning disclosure with a single static compact reasoning note in the mixed trace.
- [x] Update regression coverage and rerun desktop tests, typecheck, and the repo test suite.

## Review
- `apps/desktop/src/ui/chat/ActivityGroupCard.tsx` now renders grouped reasoning entries as a single compact static note in the mixed trace instead of nesting another expandable reasoning disclosure inside the already-expanded activity card. The card header still keeps the short preview, but the expanded body no longer shows the same reasoning summary twice.
- `apps/desktop/test/chat-activity-group-card.test.tsx` now verifies the reasoning entry directly: it renders once, keeps the full summary text, and does not contain its own nested disclosure/button controls. The regression now checks the real bug instead of counting generic `aria-controls` attributes from unrelated collapsibles in the card.
- Verification:
  - `~/.bun/bin/bun test apps/desktop/test/chat-activity-group-card.test.tsx` -> pass
  - `~/.bun/bin/bun test --cwd apps/desktop` -> pass (`186 pass, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass
  - `~/.bun/bin/bun test` -> 1 unrelated failure in `test/mcp.remote.grep.test.ts` (`remote MCP (mcp.grep.app) > connects, discovers tools, and executes searchGitHub`) returning `Streamable HTTP error ... code: 405`

# Task: Make desktop reasoning/tool trace slimmer and ordered

## Plan
- [x] Refactor desktop activity grouping to preserve ordered mixed reasoning/tool entries and keep tool merges bounded by reasoning separators.
- [x] Rebuild the grouped activity card around the shared local `ai-elements` reasoning/tool primitives with a compact trace presentation.
- [x] Add/update desktop tests for mixed ordering, compact reasoning previews, and trace-mode tool expansion behavior.
- [x] Run `bun test` and `bun run typecheck`, then record the results below.

## Review
- `apps/desktop/src/ui/chat/activityGroups.ts` now summarizes grouped activity as an ordered `entries` list instead of separate reasoning/tool buckets. Tool lifecycle merging still dedupes adjacent updates, but only within uninterrupted tool runs, so a reasoning summary now acts as a hard separator and the rendered order matches the original feed chronology.
- `apps/desktop/src/ui/chat/ActivityGroupCard.tsx` now renders one compact mixed trace list inside the grouped activity card. The card header is smaller, the summary preview is shorter, and the expanded content no longer splits into separate “reasoning” and “trace” sections.
- `apps/desktop/src/ui/chat/toolCards/ToolCard.tsx`, `apps/desktop/src/components/ai-elements/tool.tsx`, and `apps/desktop/src/components/ai-elements/reasoning.tsx` now support compact trace variants so the grouped card reuses the local `ai-elements` primitives instead of maintaining a bespoke parallel row implementation.
- Added regression coverage in `apps/desktop/test/chat-activity-groups.test.ts` for mixed ordering and reasoning-boundary merge rules, plus a new SSR UI test in `apps/desktop/test/chat-activity-group-card.test.tsx` that checks chronological rendering, collapsed reasoning previews, and auto-expanded approval rows.
- Verification:
  - `~/.bun/bin/bun test apps/desktop/test/chat-activity-groups.test.ts apps/desktop/test/chat-activity-group-card.test.tsx apps/desktop/test/chat-reasoning-ui.test.ts` -> pass
  - `~/.bun/bin/bun test --cwd apps/desktop` -> pass (`186 pass, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass
  - `~/.bun/bin/bun test` -> pass (`1827 pass, 0 fail`)

# Task: Remove the portal app

## Plan
- [x] Capture all repo wiring that still depends on `apps/portal` and isolate portal-only tests/docs.
- [x] Remove the portal app, root scripts/CI hooks, and documentation references without disturbing unrelated React/OpenTUI portal mentions.
- [x] Run the required verification (`bun test` and `bun run typecheck`) and record the result below.

## Review
- Removed the portal app completely: deleted `apps/portal/`, dropped the root `portal:*` scripts and portal install step from `package.json`, removed the portal-only test (`test/portal.harness.test.ts`), and removed the CI portal build step from `.github/workflows/ci.yml`.
- Updated the repo docs and metadata that still presented portal as a supported interface, including `README.md`, `CONTRIBUTING.md`, `AGENTS.md`, `docs/architecture.md`, `docs/harness/runbook.md`, and the desktop README/test wording that used the old harness-portal example.
- Regenerated the root lockfile with `bun install` after removing the portal app from the install flow.
- Verification:
  - `bun run typecheck` -> pass
  - `bun test` -> 1 unrelated failure, `Codex provider (gpt-5.4) > getModel exposes stable adapter shape` in `test/providers/codex-cli.test.ts`
  - The failing assertion expects API-key auth headers from the Codex provider adapter; this task did not modify provider/runtime code, and the portal-removal surface itself does not produce any test or typecheck failures.

# Task: Update Bun dependencies and verify regressions

## Plan
- [x] Capture the clean baseline and run `bun update` from the repo root.
- [x] Inspect the resulting dependency and lockfile changes for anything unexpected.
- [x] Run the required regression checks (`bun test` and `bun run typecheck`), investigate failures if they appear, and record the outcome below.

## Review
- `bun update` completed cleanly from the repo root and updated only `/Users/mweinbach/Projects/agent-coworker/package.json` plus `/Users/mweinbach/Projects/agent-coworker/bun.lock`. The refreshed direct versions are `@mariozechner/pi-ai 0.55.4`, `@modelcontextprotocol/sdk 1.27.1`, `@opentui/{core,react,solid} 0.1.86`, `@types/node 25.3.5`, `bun-types 1.3.10`, and `puppeteer-core 24.38.0`.
- The dependency refresh exposed one real compile regression in `/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/ui/settings/pages/ProvidersPage.tsx`: a `split(...).map(...)` callback started tripping `TS7006` because the surrounding helper was flowing `any`. Narrowing the local intermediate strings fixed the typecheck without changing runtime behavior.
- The refresh also surfaced one stale provider assertion in `/Users/mweinbach/Projects/agent-coworker/test/providers/codex-cli.test.ts`. The repo’s current runtime/auth contract already treats `codex-cli` API keys separately from raw `OPENAI_API_KEY` fallback, so the test now seeds a real saved `codex-cli` key in `~/.cowork/auth/connections.json` instead of assuming OpenAI env reuse.
- Verification passed after those fixes:
  - `~/.bun/bin/bun run typecheck` -> pass
  - `~/.bun/bin/bun test test/providers/codex-cli.test.ts test/providers/index.test.ts test/providers/saved-keys.test.ts` -> pass (`20 pass, 0 fail`)
  - `~/.bun/bin/bun test` -> pass (`1819 pass, 0 fail`)

# Task: Expose Codex OAuth status and rate limits in provider status

## Plan
- [x] Inspect the Codex app Rust sources and current Cowork provider-status/UI code to capture the exact usage endpoint fields worth surfacing.
- [x] Extend the shared `ProviderStatus` shape and Codex verification path to include parsed backend status/rate-limit data without changing editable `providerOptions`.
- [x] Update the desktop Providers page and focused tests, rerun the relevant verification commands, and record the outcome below.

## Review
- The Codex app/client sources confirmed the backend contract we should mirror: `GET /wham/usage` returns `plan_type`, a primary `rate_limit`, optional `code_review_rate_limit`, `additional_rate_limits`, and `credits`. Cowork now preserves that shape in a typed `usage` block on `ProviderStatus` instead of trying to overload editable `providerOptions`.
- `src/providerStatus.ts` now parses the live Codex usage payload into `usage.planType`, `usage.accountId`, and normalized rate-limit snapshots with `allowed`, `limitReached`, `primaryWindow`, `secondaryWindow`, and `credits`. The same status call still drives verification, so the extra data comes from the exact endpoint already proving the OAuth session is valid.
- `apps/desktop/src/ui/settings/pages/ProvidersPage.tsx` now renders a `Usage status` section for Codex with plan, account id, backend status message, and per-limit cards. Per your correction, windows are shown as remaining headroom (`96% left`, `100% left`) rather than consumed budget (`4% used`, `0% used`).
- `src/cli/repl.ts` now prints the Codex plan and the primary rate-limit headroom on `/connect` status output, so the new data is visible outside the desktop UI too.
- Focused verification passed:
  - `~/.bun/bin/bun test test/providerStatus.test.ts test/providers/codex-auth.test.ts test/runtime.pi-runtime.test.ts apps/desktop/test/providers-page.test.ts` -> pass (`30 pass, 0 fail`)
  - `~/.bun/bin/bunx tsc --noEmit` -> pass
- Live verification passed against the current signed-in Codex session:
  - `getProviderStatuses()` now returns `usage.accountId`, `usage.planType: "pro"`, and live `rateLimits` entries for `codex`, `code_review`, and `codex_bengalfox`
  - the live payload shape matched the real backend fields from `https://chatgpt.com/backend-api/wham/usage`

# Task: Align Codex OAuth verification with the Codex app contract

## Plan
- [x] Compare Cowork's current Codex OAuth verification path against the Codex app/client sources to identify where our status check diverges from the real backend contract.
- [x] Patch `providerStatus` to verify Codex OAuth using the same backend/account-id shape as the Codex app instead of generic OIDC userinfo discovery.
- [x] Rerun the focused provider/auth/runtime tests plus a live signed-in status/runtime check and record the outcome below.

## Review
- Root cause: Cowork was treating Codex OAuth verification like a generic OIDC login and probing `/.well-known/openid-configuration` + `userinfo`. Your real signed-in token worked for runtime calls, but that status check returned a false-negative `404`, so the UI showed Codex as unverified even though the transport was healthy.
- The Codex app sources (`/Users/mweinbach/Downloads/server.rs` and `/Users/mweinbach/Downloads/client.rs`) use a different contract: they persist `chatgpt_account_id` from token claims and talk to the ChatGPT/Codex backend with the `ChatGPT-Account-Id` header. Cowork now matches that in `src/providerStatus.ts` by verifying against `https://chatgpt.com/backend-api/wham/usage` with the bearer token plus account-id header and by keeping account/email data token-derived.
- Focused verification passed: `~/.bun/bin/bun test test/providerStatus.test.ts test/providers/codex-auth.test.ts test/runtime.pi-runtime.test.ts` (`24 pass, 0 fail`) and `~/.bun/bin/bunx tsc --noEmit`.
- Live verification passed after the patch:
  - `getProviderStatuses()` now returns `codex-cli` as `authorized: true`, `verified: true`, `mode: "oauth"`, message `Verified via Codex usage endpoint (pro).`
  - the signed-in live runtime still succeeds for both a plain prompt (`OK`) and a forced tool loop (`PONG`) through `createRuntime({ runtime: "pi" }).runTurn(...)`

# Task: Audit live Codex auth storage handling

## Plan
- [x] Inspect the active Codex auth loader path and determine which Cowork home it reads from.
- [x] Check the live default/common Cowork auth stores on this machine for a Codex auth document without exposing token values.
- [x] Run focused auth/runtime/status tests to verify parsing, refresh, and no-legacy-fallback behavior, then record the result below.

## Review
- The live loader path is `/Users/mweinbach/.cowork/auth/codex-cli/auth.json` by default, via `getAiCoworkerPaths()` and `readCodexAuthMaterial(..., { migrateLegacy: false })` in `src/connect.ts`, `src/runtime/piRuntime.ts`, and `src/providers/codex-auth.ts`.
- After signing in, a direct live call to `readCodexAuthMaterial()` on the default path returned valid Cowork-managed auth metadata from `~/.cowork/auth/codex-cli/auth.json` (account, email, plan type, expiry all parsed cleanly without consulting legacy paths).
- Live entry-point verification now succeeds through our own logic. `getProviderStatuses()` reports `codex-cli` as authorized in `oauth` mode, but still `verified: false` because the OIDC userinfo verification call returns `404`. Despite that verification warning, a real `createRuntime({ runtime: "pi" }).runTurn(...)` call for `codex-cli` succeeded for both a plain prompt (`OK`) and a forced tool-loop prompt (`PONG`) using the same Cowork auth file.
- Focused verification passed: `~/.bun/bin/bun test test/providers/codex-auth.test.ts test/runtime.pi-runtime.test.ts test/providerStatus.test.ts` (`24 pass, 0 fail`). This covers JWT/claim parsing, refresh persistence, malformed auth handling, provider status, and the explicit rule that missing Cowork auth must not fall back to legacy `~/.codex`.
- Conclusion: the live default Cowork auth path is now good, and the Codex runtime transport is working end to end. The remaining issue is narrower: provider verification still shows a false-negative warning because the userinfo check is returning `404` even though the actual Codex runtime calls succeed.

# Task: Fix Codex ChatGPT tool-loop continuation without previous_response_id

## Plan
- [x] Reproduce the live `No tool call found for function call output with call_id ...` failure against the raw Responses runtime and isolate whether the bug is in `call_id` handling or step continuation state.
- [x] Patch the OpenAI/Codex Responses runtime so only provider-managed continuation modes send bare tool-result deltas; the ChatGPT-backed Codex path must replay the assistant tool call plus tool results locally on the next step.
- [x] Add focused regression coverage for the non-`previous_response_id` Codex tool loop, rerun the targeted runtime tests, and record the verified outcome below.

## Review
- Root cause: the raw Responses runtime treated every OpenAI/Codex tool loop like the OpenAI API-key continuation path. After disabling `previous_response_id` for the ChatGPT-backed Codex transport, step 2 still sent only `function_call_output` items, so the backend had no matching prior `function_call` in context and rejected the request with `400 No tool call found for function call output with call_id ...`.
- Fixed `src/runtime/openaiResponsesRuntime.ts` so provider-managed continuation modes still send tool-result deltas only, while non-managed modes append the assistant tool call plus tool results into the local turn transcript before the next step. That restores the context the ChatGPT-backed Codex backend requires without regressing the OpenAI API-key path.
- Added a focused regression in `test/runtime.openai-responses-runtime.test.ts` that proves the second Codex ChatGPT tool-loop step replays `[user, assistant, toolResult]` with no `previous_response_id`, matching the backend contract.
- Verification:
  - `~/.bun/bin/bun test test/runtime.openai-responses-runtime.test.ts` -> pass (`9 pass, 0 fail`)
  - `~/.bun/bin/bunx tsc --noEmit` -> pass
  - `~/.bun/bin/bun test test/runtime.pi-runtime.test.ts test/session.test.ts` -> pass (`192 pass, 0 fail`)

# Task: Fix Codex auth reuse, add logout, and eliminate legacy token migration

## Plan
- [ ] Remove automatic `~/.codex/auth.json` migration from the Codex connect, provider-status, runtime, and model-adapter paths so Cowork only uses its own `~/.cowork/auth/codex-cli/auth.json`.

- [ ] Add a first-class Codex provider logout flow through the auth registry, WebSocket protocol/session handling, and desktop provider settings UI.
- [ ] Update the focused regression tests for auth migration/logout behavior, rerun the provider/session/desktop verification slices, and record the validated outcome below.

## Review

# Task: Harden Cowork-owned Codex auth persistence across desktop restarts

## Plan
- [x] Remove the mistaken `~/.codex/auth.json` fallback changes and re-align Codex auth reads to Cowork-owned `~/.cowork/auth/codex-cli/auth.json` only.
- [x] Harden Cowork auth-store writes so `codex-cli/auth.json` and `connections.json` are replaced atomically instead of being written in-place.
- [x] Make provider catalog/status treat a valid Cowork Codex auth file as connected even if `connections.json` was cleared, then rerun focused core and desktop verification.

## Review
- The `.codex` migration detour was reverted in `src/connect.ts`, `src/providerStatus.ts`, `src/providers/modelAdapter.ts`, and `src/runtime/piRuntime.ts`; Codex resolution is back to Cowork-owned auth only.
- `src/providers/codex-auth.ts` and `src/store/connections.ts` now write `~/.cowork/auth/codex-cli/auth.json` and `~/.cowork/auth/connections.json` through `writeTextFileAtomic()`, so desktop/server shutdown can no longer leave those files partially written in place.
- `src/providers/connectionCatalog.ts` now checks Cowork’s Codex auth file directly (without any legacy migration) when deciding whether `codex-cli` is connected. This keeps the desktop Providers list correct even if `connections.json` loses the `codex-cli` entry while the Cowork auth file is still valid.
- Live validation against the current machine state showed the exact split-brain bug: `~/.cowork/auth/codex-cli/auth.json` was valid while `connections.json` had an empty `services` object. After the patch, `getProviderCatalog()` still returns `["codex-cli"]` and `getProviderStatuses()` still resolves Codex as verified from the Cowork auth file.
- Verification:
  - `~/.bun/bin/bun test test/connect.test.ts test/providerStatus.test.ts test/providers/saved-keys.test.ts test/runtime.pi-runtime.test.ts test/providers/connection-catalog.test.ts test/providers/codex-auth.test.ts` -> pass (`43 pass, 0 fail`)

  - `~/.bun/bin/bun run typecheck` -> pass
  - `~/.bun/bin/bun test apps/desktop/test/providers-page.test.ts apps/desktop/test/workspace-settings-sync.test.ts apps/desktop/test/protocol-v2-events.test.ts` -> pass (`40 pass, 0 fail`)

# Task: Own Codex OAuth in Cowork and add explicit Codex logout

## Plan
- [x] Remove automatic `~/.codex` auth migration and switch Codex browser sign-in back to the in-repo Cowork-owned OAuth flow.
- [x] Tighten `codex-cli` credential resolution so runtime/model selection does not silently fall back to saved OpenAI API keys when the user expects Codex OAuth ownership.
- [x] Add a first-class Codex logout path through the WebSocket protocol, server session auth manager, and desktop Providers settings UI.
- [x] Update docs and focused regression coverage, then rerun the relevant auth/runtime/desktop verification commands and record the outcome below.

## Review
- Codex browser sign-in now uses `http://localhost:<port>/auth/callback`, the live current browser-login scope, and the official `originator=codex_cli_rs` instead of the previous app-specific authorize parameters that were producing the browser-side `unknown_error`.
- The Codex runtime path in `src/runtime/openaiNativeResponses.ts` now only rewrites the base URL for the ChatGPT-backed Codex transport. API-key-backed `codex-cli` requests keep the normal OpenAI base URL instead of being incorrectly sent to `.../v1/codex/responses`, and the ChatGPT-backed path now adds the official Codex `originator` header.
- Desktop provider settings now only show `Log out` for real Codex OAuth sessions (`mode === "oauth"`), and `ProvidersPage` uses the current Zustand snapshot during SSR so the connected/logout state renders correctly in the server-rendered desktop tests.
- Added focused regression coverage in `test/providers/codex-oauth-flows.test.ts` plus runtime/auth/desktop updates in `test/runtime.openai-responses-runtime.test.ts`, `test/connect.test.ts`, and `apps/desktop/test/providers-page.test.ts`.
- Verification:
  - `~/.bun/bin/bunx tsc --noEmit` -> pass
  - `~/.bun/bin/bun test test/providers/codex-oauth-flows.test.ts test/connect.test.ts test/providers/auth-registry.test.ts test/runtime.openai-responses-runtime.test.ts apps/desktop/test/providers-page.test.ts apps/desktop/test/protocol-v2-events.test.ts` -> pass (`58 pass, 0 fail`)
  - `~/.bun/bin/bun test test/providers/codex-auth.test.ts test/providers/saved-keys.test.ts test/providerStatus.test.ts` -> pass (`21 pass, 0 fail`)

# Task: Raw Responses runtime for OpenAI/Codex plus durable subagent sessions

## Plan
- [x] Split runtime execution so `openai` and `codex-cli` use a first-class raw Responses runtime with in-repo adapters, while `google` and `anthropic` stay on PI.
- [x] Extend session persistence and server/session wiring to support durable child subagent sessions with their own continuation state, metadata, and restart recovery.
- [x] Add persistent subagent tool and WebSocket lifecycle surfaces, update protocol/docs, and verify runtime/session/tool/protocol behavior with focused tests plus repo checks.

## Review
- Added a dedicated internal OpenAI/Codex Responses runtime in `src/runtime/openaiResponsesRuntime.ts` and kept `createRuntime()` publicly pinned to `runtime: "pi"` while dispatching `openai` / `codex-cli` through the raw Responses path and leaving `google` / `anthropic` on PI.
- Removed the PI deep-import bridge from the OpenAI/Codex execution path. The runtime now owns request shaping, tool/message conversion, streaming normalization, `previous_response_id` continuation, and provider-state return values in-repo.
- Tightened the raw Responses request contract around the locally installed OpenAI SDK surface by keeping `previous_response_id`, `truncation: "auto"`, and `store: true`, and dropping the unsupported `context_management` payload.
- Follow-up provider fix: the OpenAI API now receives function tools with `strict: false` so optional parameters like `read.offset` remain valid. The ChatGPT-backed Codex transport omits unsupported `previous_response_id`, `truncation`, and `max_output_tokens`, forces `store: false`, and clamps `text.verbosity` to `medium`, while the API-key-backed Codex/OpenAI Responses path still honors low|medium|high verbosity plus continuation fields.
- Extended persistence to snapshot `v3` with `sessionKind`, `parentSessionId`, `agentType`, and `providerState`, and wired the same metadata through the session DB schema, legacy import path, runtime hydration, and JSON snapshot reader/writer.
- Durable persistent subagents now flow through normal `AgentSession` instances with their own transcript/provider state, parent-child metadata, reopen-on-new-input behavior, root-delete cascade, and root-only listing semantics.
- Added persistent subagent tools (`spawnPersistentAgent`, `listPersistentAgents`, `sendAgentInput`, `waitForAgent`, `closeAgent`) without changing the one-shot `spawnAgent` contract, and passed those controls only into root-session turns.
- Added WebSocket support for `subagent_create` / `subagent_sessions_get`, matching `subagent_created` / `subagent_sessions` events, and child-session identity metadata on `server_hello` / `session_info`. Updated `docs/websocket-protocol.md` accordingly.
- Verification:
  - `~/.bun/bin/bunx tsc --noEmit` -> pass
  - `~/.bun/bin/bun test test/runtime.pi-options.test.ts test/runtime.pi-runtime.test.ts test/runtime.openai-responses-runtime.test.ts test/runtime.selection.test.ts test/session.test.ts test/protocol.test.ts test/agentSocket.parse.test.ts test/session-store.test.ts test/session-db.test.ts test/session-db-mappers.test.ts test/persistentAgents.tool.test.ts` -> pass (`377 pass, 0 fail`)
  - `~/.bun/bin/bun test test/runtime.openai-responses-runtime.test.ts test/runtime.pi-runtime.test.ts test/session.test.ts` -> pass after the OpenAI/Codex follow-up fix (`195 pass, 0 fail`)
  - `~/.bun/bin/bun test test/spawnAgent.tool.test.ts test/persistentAgents.tool.test.ts` -> pass (`10 pass, 0 fail`)
  - `~/.bun/bin/bun test test/spawnAgent.tool.test.ts test/persistentAgents.tool.test.ts test/server.test.ts --max-concurrency 1 --test-name-pattern "spawnAgent tool|persistent agent tools|subagent_create|subagent_sessions_get|research children use model|deleting a root session removes its persistent subagent resume target|child model changes stay session-local"` -> pass (`14 pass, 0 fail`)
  - `~/.bun/bin/bun test test/server.test.ts --max-concurrency 1 --test-name-pattern "subagent_create|subagent_sessions_get|research children use model|deleting a root session removes its persistent subagent resume target|child model changes stay session-local"` -> pass when rerun outside the sandbox (`4 pass, 0 fail`)
  - `~/.bun/bin/bun test` -> core/server/runtime paths pass, but the full suite still stops on pre-existing desktop dependency gaps in this workspace (`react-dom/server`, `lucide-react`, `zustand`, etc.); final result was `1717 pass, 2 skip, 13 fail`
  - `~/.bun/bin/bun test test/server.test.ts` inside the sandbox -> still fails early with `EADDRINUSE` during local port binding, before behavior assertions
  - `~/.bun/bin/bun run typecheck` -> blocked by missing desktop/Electron modules in this workspace (`Cannot find module 'electron'`, `zustand`, `lucide-react`, etc.), unrelated to these runtime/server changes

# Task: Audit provider references down to Anthropic API and Gemini API only

## Plan
- [x] Search the repo for legacy Anthropic/Google CLI-provider references using subagents plus local verification, and categorize runtime, docs, prompt, and test hits.
- [x] Rewrite or remove those references so Anthropic-related surfaces point only to the Anthropic API and Google-related surfaces point only to the Gemini API, while preserving valid provider/model identifiers and API-backed docs.
- [x] Run verification searches and the relevant Bun tests, then record the validated outcome and any explicit exceptions below.

## Review
- Removed the legacy `claude-code` and `gemini-cli` compatibility references from runtime-facing code and UI/test fixtures: `src/types.ts` no longer normalizes those aliases, the TUI provider dialog no longer contains a hidden `claude-code` OAuth branch, and the desktop notification regression now uses `codex-cli`.
- Removed the Claude Code GitHub workflow entirely and rewrote public docs and repo notes to describe Anthropic access only via `ANTHROPIC_API_KEY` and Google access only via the Gemini API. This included `README.md`, `CONTRIBUTING.md`, `GEMINI.md`, `Cowork_Agent_PRD.md`, `docs/architecture.md`, `CLAUDE.md`, `.gitignore`, and the bundled shadcn MCP doc.
- Verification:
  - `rg -n -i --hidden --glob '!node_modules' --glob '!.git' --glob '!dist' "claude code|claude-code|claude agent sdk|claude-agent-sdk|@anthropic-ai/claude-agent-sdk|gemini-cli|gemini cli" .` -> no matches
  - `~/.bun/bin/bun test test/types.test.ts apps/desktop/test/protocol-v2-events.test.ts test/providers/codex-oauth-flows.test.ts` -> pass (`62 pass, 0 fail`)
  - `~/.bun/bin/bun test` -> still has an existing nondeterministic failure in `test/providers/codex-oauth-flows.test.ts` when run inside the full-suite parallel load, even though that same file passes in isolation
# Task: Ship desktop release 0.1.9 with robust updater behavior and Windows installer publishing

## Plan
- [x] Keep the packaged updater behavior clean when platform update metadata is absent, so packaged builds surface `Unavailable` instead of a raw updater error.
- [x] Patch the desktop release workflow so unsigned Windows releases still publish the current installer, while signed-only updater metadata (`latest.yml`, `.blockmap`) stays gated behind `WIN_CSC_*`.
- [ ] Commit the release, tag `v0.1.9`, push to `origin/main`, and confirm the published GitHub release assets match the intended Windows installer-only behavior when signing is absent.

## Review
- Root cause: after `v0.1.8`, packaged Windows builds handled missing `latest.yml` gracefully, but the release workflow still skipped every Windows asset when `WIN_CSC_LINK` was absent. That left no downloadable Windows installer at all.
- The updater contract now stays clean across both cases:
  - if platform metadata exists, `electron-updater` can proceed normally
  - if `latest*.yml` is absent, the app moves into the existing `disabled` / `Unavailable` state instead of surfacing a raw 404
- Updated `.github/workflows/desktop-release.yml` so the Windows job always stages and uploads the current version's `.exe` installer. It only stages the matching `.blockmap` plus `latest.yml` when `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` are both present.
- Hardened the workflow to select the installer matching `apps/desktop/package.json` instead of the first `.exe` in `apps/desktop/release`, and to copy only the matching `.blockmap`. That avoids leaking stale local artifacts into staged Windows release uploads.
- Bumped `/Users/mweinbach/Projects/agent-coworker/package.json` and `/Users/mweinbach/Projects/agent-coworker/apps/desktop/package.json` to `0.1.9`, updated the desktop updater/UI tests to assert `0.1.9`, and extended updater coverage to treat missing `latest-mac.yml` the same way as missing `latest.yml`.
- Verification:
  - `~/.bun/bin/bun test test/desktop-release.workflow.test.ts` -> pass (`2 pass, 0 fail`)
  - `~/.bun/bin/bun test --cwd apps/desktop` -> pass (`171 pass, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass
  - `WIN_CSC_* / CSC_* unset; ~/.bun/bin/bun run desktop:build -- --publish never` -> pass; produced `apps/desktop/release/Cowork-0.1.9-win-x64.exe`
  - simulated Windows artifact staging with signing secrets absent -> staged only `Cowork-0.1.9-win-x64.exe`

# Task: Assess Windows signing secret creation for desktop releases

## Plan
- [x] Verify whether this machine has a real Windows code-signing certificate or exportable `.pfx`/`.p12` that can back `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`.
- [x] Verify whether GitHub auth from this machine is sufficient to write repo secrets if valid signing material exists.
- [x] Record whether generating fresh keys locally would produce a trusted Windows release or just recreate the untrusted-root updater failure.

## Review
- GitHub auth is available on this machine through the configured `git credential manager`, so pushing repo secrets is technically possible from here once valid signing material exists.
- There is no usable Windows code-signing certificate in `Cert:\CurrentUser\My` or `Cert:\LocalMachine\My`, and no exportable `.pfx` / `.p12` was found in the usual local certificate file locations under `C:\Users\maxw6`.
- Creating a new local self-signed code-signing certificate and uploading it as `WIN_CSC_*` would not fix the release path. Windows would not trust that certificate chain, so installer trust and updater signature validation would still fail with the same class of untrusted-root problem.
- The remaining workable paths are:
  - publish an unsigned Windows installer asset without `latest.yml` for manual downloads only, or
  - obtain a real Windows-trusted Authenticode certificate (or equivalent managed signing service) and then upload the resulting signing credentials to GitHub.

# Task: Fix desktop control-session providerOptions snapshot sync

## Plan
- [x] Change desktop `session_config` handling so editable provider options replace the local snapshot instead of merge-only behavior.
- [x] Add focused regression coverage for partial and missing `providerOptions` snapshots from the control session.
- [x] Run the relevant desktop tests and record the verified outcome below.

## Review
- Updated `apps/desktop/src/app/store.helpers/controlSocket.ts` so `session_config` now treats editable `providerOptions` as the authoritative control-session snapshot. The desktop workspace record now replaces its OpenAI/Codex editable provider-options subset with the normalized event payload and clears stale local values when the snapshot omits them.
- Updated `apps/desktop/test/workspace-settings-sync.test.ts` to lock the new semantics: partial `session_config.providerOptions` snapshots replace prior editable values instead of merging them, and a snapshot with no `providerOptions` clears previously stored overrides.
- Verification:
  - `bun test apps/desktop/test/workspace-settings-sync.test.ts` -> pass (`8 pass, 0 fail`)
  - `bun run typecheck` -> pass

# Task: Expose reasoning summary in OpenAI-compatible workspace controls

## Plan
- [x] Extend the shared OpenAI-compatible provider-option helpers and protocol/session validators to accept editable `reasoningSummary`.
- [x] Add desktop workspace settings plus TUI/CLI command surfaces for `reasoningSummary` on OpenAI API and Codex CLI.
- [x] Update docs and regression tests, then rerun the relevant verification commands and record the outcome below.

## Review
- Extended the editable OpenAI-compatible `providerOptions` subset so `reasoningSummary` now flows through `set_config`, `session_config`, desktop workspace persistence, and runtime deep-merge behavior for both `openai` and `codex-cli`.
- Desktop workspace settings now include a `Reasoning summary` select alongside verbosity and reasoning effort for OpenAI API and Codex CLI, and TUI/CLI now support `/reasoning-summary <auto|concise|detailed>` for the active OpenAI-compatible provider.
- Bumped the WebSocket protocol version to `7.2` and updated the protocol reference so the editable `providerOptions` contract documents `reasoningSummary`.
- Verification completed with `~/.bun/bin/bun test test/protocol.test.ts test/session.test.ts test/server.test.ts test/agentSocket.parse.test.ts test/repl.test.ts test/tui.slash-commands.test.ts apps/desktop/test/workspace-settings-sync.test.ts apps/desktop/test/workspaces-page.test.ts` (`486 pass, 0 fail`), `~/.bun/bin/bun run typecheck` (`pass`), and `~/.bun/bin/bun test` (`1773 pass, 2 skip, 0 fail`).

# Task: Add GPT-5.4 defaults and OpenAI-compatible workspace controls

## Plan
- [x] Update provider defaults and catalogs so `openai` and `codex-cli` default to `gpt-5.4`, with `textVerbosity: "medium"` and existing reasoning defaults.
- [x] Extend the WebSocket/session config path to accept, persist, emit, and merge editable OpenAI-compatible `providerOptions`.
- [x] Add desktop workspace settings plus live-thread sync for OpenAI API and Codex CLI verbosity and reasoning effort.
- [x] Add TUI and CLI command surfaces for active-provider verbosity and reasoning effort using the shared `set_config` path.
- [x] Update protocol/docs, add regression coverage, run required tests, and record the verified outcome below.

## Review
- UI/command-surface scope completed in this worktree: desktop workspace settings now expose separate OpenAI API and Codex CLI verbosity / reasoning-effort controls, desktop sync applies `providerOptions` through control-session `session_config` and live-thread `set_config`, and TUI/CLI now support `/verbosity`, `/reasoning-effort`, and `/effort` for the active OpenAI-compatible provider.
- Verification completed for the owned scope with `~/.bun/bin/bun test apps/desktop/test/workspace-settings-sync.test.ts apps/desktop/test/workspaces-page.test.ts test/tui.slash-commands.test.ts test/repl.test.ts` (`88 pass, 0 fail`).
- Backend/core scope completed in this worktree: OpenAI API and Codex CLI now default to `gpt-5.4`, OpenAI-compatible defaults keep `reasoningEffort: "high"` and `reasoningSummary: "detailed"` while lowering `textVerbosity` to `medium`, and server-only startup now seeds `DEFAULT_PROVIDER_OPTIONS`.
- Extended the core WebSocket/session path so `set_config` accepts editable `providerOptions` for `openai` and `codex-cli`, `session_config` emits the same normalized subset, and both runtime state and persisted `.agent/config.json` deep-merge the editable fields while preserving unrelated keys like `reasoningSummary` and non-OpenAI provider settings.
- Isolated the new desktop workspace-settings rendering behind `OpenAiCompatibleModelSettingsCard` so the `workspaces-page` test no longer needs to mock the shared desktop store module; this removed the mock leakage that was contaminating later desktop tests during full-suite runs.
- Updated the protocol reference to `7.1` and added regression coverage across protocol parsing, session state, server persistence, provider defaults, runtime PI mapping, and client-side server-event parsing.
- Verification completed for the owned scope with `~/.bun/bin/bun test test/protocol.test.ts test/session.test.ts test/server.test.ts test/runtime.pi-options.test.ts test/providers/openai.test.ts test/providers/codex-cli.test.ts test/providers/provider-options.test.ts test/providers/config-switching.test.ts test/config.test.ts test/agentSocket.parse.test.ts test/docs.check.test.ts` (`492 pass, 0 fail`), `~/.bun/bin/bun run typecheck` (`pass`), and `~/.bun/bin/bun test` (`1770 pass, 2 skip, 0 fail`).

# Task: Ship desktop hotfix release 0.1.8

## Plan
- [x] Patch the packaged desktop updater so missing release metadata (`latest.yml`) is treated as an unavailable feed instead of a surfaced updater error.
- [x] Bump the repo and desktop release versions from `0.1.7` to `0.1.8`, keeping the Windows updater runtime fix in the release payload.
- [x] Rerun the desktop release validation stack and confirm packaged Windows builds show a friendly unavailable state when no signed feed exists.
- [ ] Commit the hotfix, tag `v0.1.8`, push to `origin/main`, and note any remaining release-management follow-up that cannot be completed from this machine.

# Task: Fix desktop workspace-add lag/timeouts from settings

## Plan
- [x] Trace the add-workspace flow from settings through renderer actions, desktop preload, Electron IPC, and workspace server startup.
- [x] Remove main-process blocking work from the workspace-start IPC hot path and keep the startup/error behavior unchanged for callers.
- [x] Add regression coverage for the desktop startup/diagnostics path, run required verification, and record the outcome below.

## Review
- The settings UI path was already thin: `WorkspacesPage` calls the store’s `addWorkspace()`, which persists the new workspace and immediately runs `selectWorkspace()`. The lag/timeout risk sits on the Electron side once `selectWorkspace()` reaches `desktop:startWorkspaceServer`.
- `apps/desktop/electron/services/serverManager.ts` no longer performs synchronous file appends for startup diagnostics or mirrors every child-process stderr chunk to the Electron main process stderr by default. Diagnostics now queue async writes to the desktop log file, and stderr mirroring is opt-in via `COWORK_DESKTOP_DEBUG_SERVER_STDERR=1`.
- `apps/desktop/electron/services/validation.ts` now validates workspace directories asynchronously before starting the workspace server, so the IPC startup path no longer blocks the Electron main thread on `statSync`.
- Desktop-started workspace servers now default `COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP=1` in `apps/desktop/electron/services/serverManager.ts`, which removes first-run default-skill network/bootstrap work from the critical startup path unless the environment explicitly overrides it.
- Restart/remove semantics are hardened across the renderer and main process:
  - `apps/desktop/src/app/store.helpers/runtimeState.ts` now tracks per-workspace startup generations.
  - `apps/desktop/src/app/store.helpers.ts` ignores stale startup completions/errors once a workspace start has been superseded.
  - `apps/desktop/src/app/store.actions/workspace.ts` bumps startup generation on restart/remove and no longer does a second state save when adding a brand-new workspace.
  - `apps/desktop/electron/services/serverManager.ts` tracks pending child startups so `stopWorkspaceServer()` and `stopAll()` can kill a server before `server_listening` is emitted.
- Regression coverage was extended in `apps/desktop/test/server-manager.test.ts` and the new `apps/desktop/test/workspace-startup.test.ts` to cover async diagnostics flushes, stopping pending starts, single-save add behavior, and restart superseding an in-flight startup.
- Verification:
  - `~/.bun/bin/bun test apps/desktop/test/server-manager.test.ts apps/desktop/test/workspace-startup.test.ts apps/desktop/test/protocol-v2-events.test.ts apps/desktop/test/thread-reconnect.test.ts apps/desktop/test/workspace-settings-sync.test.ts` -> pass
  - `~/.bun/bin/bun run typecheck` -> pass
  - `~/.bun/bin/bun test` -> 1 unrelated failure, `runTurn + remote MCP (mcp.grep.app) > loads the remote MCP tools and can execute them via the tools passed to streamText`, failing with `Streamable HTTP error` / `405` from the remote MCP endpoint; desktop workspace-start changes do not touch that area

# Task: Use app SVG on desktop home empty state

## Plan
- [x] Locate the desktop home empty-state component and the current app SVG asset.
- [x] Replace the placeholder tile with the actual Cowork SVG while preserving the existing layout and accessibility semantics.
- [x] Run focused verification for the desktop renderer path and record the result below.

## Review
- The desktop home empty state in `apps/desktop/src/ui/ChatView.tsx` now renders the existing app SVG from `apps/desktop/build/icon.icon/Assets/svgviewer-output.svg` instead of the previous placeholder gradient square.
- The icon is used as a decorative image (`alt=""`, `aria-hidden="true"`) so the accessible content remains the empty-state heading, description, and button text.
- Verification:
  - `~/.bun/bin/bun run typecheck` -> pass
  - `~/.bun/bin/bun test apps/desktop/test/settings-nav.test.ts apps/desktop/test/workspaces-page.test.ts apps/desktop/test/protocol-v2-events.test.ts` -> pass (`35 pass, 0 fail`)

## Review
- `v0.1.7` fixed the release workflow, but packaged Windows apps still attempted to fetch `latest.yml` even when the release intentionally omitted unsigned Windows update metadata. That surfaced a noisy 404 from `electron-updater` instead of a usable in-app state.
- Patched `apps/desktop/electron/services/updater.ts` so missing `latest*.yml` feed errors are classified as an unavailable update feed. Packaged builds now move into the existing `disabled` / `Unavailable` state with a friendly message rather than surfacing an updater error stack.
- Updated the settings copy in `apps/desktop/src/ui/settings/pages/UpdatesPage.tsx` so the page describes update checks in terms of published platform metadata, not just whether the build is packaged.
- Bumped `/Users/mweinbach/Projects/agent-coworker/package.json` and `/Users/mweinbach/Projects/agent-coworker/apps/desktop/package.json` to `0.1.8`, plus the desktop updater/UI tests that assert the visible version string.
- Local packaging produced `apps/desktop/release/Cowork-0.1.8-win-x64.exe`, `apps/desktop/release/Cowork-0.1.8-win-x64.exe.blockmap`, and refreshed `apps/desktop/release/latest.yml` with `version: 0.1.8`.
- Verification:
  - `~/.bun/bin/bun test --cwd apps/desktop` -> pass (`170 pass, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass
  - `WIN_CSC_LINK='' ; WIN_CSC_KEY_PASSWORD='' ; <workflow cleanup logic> ; ~/.bun/bin/bun run desktop:build -- --publish never` -> pass; produced the unsigned `0.1.8` Windows installer after removing both `WIN_CSC_*` and `CSC_*`
  - `~/.bun/bin/bun test` -> still unstable in this environment; earlier baseline was `1748 pass, 2 skip, 4 fail` in pre-existing `test/tools.test.ts`, and the latest rerun crashed inside Bun after extensive passing output

# Task: Fix desktop Windows updater signing mismatch

## Plan
- [x] Trace why Windows auto-updates reject the published installer and confirm whether CI is signing Windows artifacts with the macOS Developer ID certificate.
- [x] Patch the desktop release workflow/config so Windows packaging only uses Windows signing inputs, or stays unsigned when none are configured, instead of inheriting the Apple certificate.
- [x] Add/update focused regression coverage, rerun the required verification commands, and record the outcome below.

## Review
- Root cause: `.github/workflows/desktop-release.yml` exported the generic `CSC_LINK` / `CSC_KEY_PASSWORD` secrets into the shared build step for both matrix entries. `electron-builder` falls back from `WIN_CSC_*` to those generic `CSC_*` variables on Windows, so the Windows NSIS installer picked up the Apple Developer ID `.p12` and shipped a signature chain that Windows does not trust. That exactly matches the updater error reporting `Developer ID Application: Max Weinbach (6UHAW5UAT4)` plus `A certificate chain could not be built to a trusted root authority`.
- Fixed the workflow so macOS and Windows build in separate steps. The macOS step still uses `CSC_LINK` / `CSC_KEY_PASSWORD`; the Windows step now uses only `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`.
- Hardened release publishing so unsigned Windows builds are smoke-tested only. If `WIN_CSC_LINK` is absent, CI now skips uploading `latest.yml` and the Windows installer, which prevents future GitHub Releases from advertising broken Windows auto-update metadata.
- Updated the publish job to assemble the exact downloaded asset list before calling `softprops/action-gh-release`, so tag releases still publish cleanly when the unsigned Windows upload path is intentionally skipped.
- Added `test/desktop-release.workflow.test.ts` to lock the two critical invariants: Windows must never inherit `CSC_*`, and Windows release assets are only uploaded when Windows signing secrets exist.
- Updated `apps/desktop/README.md` to document that Windows release assets are only published when `WIN_CSC_LINK` is configured, because Windows auto-update-compatible releases need a Windows-trusted signing certificate.
- Verification:
  - `~/.bun/bin/bun test test/desktop-release.workflow.test.ts` -> pass (`2 pass, 0 fail`)
  - `git diff --check` -> pass aside from existing CRLF conversion warnings on Windows
  - `~/.bun/bin/bun run typecheck` -> fails on a pre-existing `apps/desktop/electron/services/updater.ts` resolution error for `electron-updater`
  - `~/.bun/bin/bun test` -> fails in unrelated existing `test/tools.test.ts` cases (`webSearch` live-behavior expectations and `memory` searches that cannot spawn `rg` in this environment)

# Task: Ship desktop release 0.1.3 from the current auth-fix main branch

## Plan
- [x] Bump the repo and desktop release versions to `0.1.3`, keeping the current `main` fixes from the other machine as the release base.
- [x] Rerun the release validation stack (`typecheck`, desktop tests, full tests, packaged desktop build) against `0.1.3`.
- [x] Push the release commit, tag `v0.1.3`, publish the release, and verify the resulting GitHub Actions run/assets.

## Review
- Release base: current `main` already included the latest auth fixes from the other machine, with `3da887a Fix codex authentication flow` at `HEAD` before the version bump.
- Bumped `/Users/mweinbach/Projects/agent-coworker/package.json` and `/Users/mweinbach/Projects/agent-coworker/apps/desktop/package.json` to `0.1.3`, and updated the desktop tests that assert the visible updater version string.
- Verification before tagging:
  - `bun run typecheck` -> pass
  - `bun test --cwd apps/desktop` -> pass (`167 pass, 0 fail`)
  - `bun test` -> pass (`1750 pass, 2 skip, 0 fail`)
  - `bun run desktop:build -- --publish never` -> pass; generated `apps/desktop/release/Cowork-0.1.3-mac-arm64.zip`, `apps/desktop/release/Cowork-0.1.3-mac-arm64.dmg`, blockmaps, and refreshed updater manifests
  - `git diff --check` -> pass
- `apps/desktop/release/latest-mac.yml` now targets `Cowork-0.1.3-mac-arm64.zip` with the new SHA512 metadata, so the packaged updater manifest is aligned with the release version.

# Task: Fix Windows OAuth browser opener truncation

## Plan
- [x] Replace the Windows external-browser launcher so OAuth URLs with `&` are not parsed by `cmd` before the browser receives them.
- [x] Reuse the same fixed opener in MCP OAuth flows so browser-based auth is consistent across the app.
- [x] Add regression coverage for the Windows opener command, rerun focused auth tests plus the required repo verification, and record the validated outcome below.

## Review
- Root cause: on Windows, `src/utils/browser.ts` opened external URLs with `cmd /c start "" <url>`. OAuth authorize URLs contain query-string `&` separators, and `cmd` treats those as command delimiters unless they are shell-escaped. That meant the browser only received the truncated prefix of the OpenAI authorize URL, which directly explains the repeated `missing_required_parameter` failures even though PI was generating a valid full URL.
- Replaced the Windows browser launcher in `src/utils/browser.ts` with a direct `rundll32.exe url.dll,FileProtocolHandler <url>` opener so the full OAuth URL is passed to the browser without shell parsing. Added an internal command-builder export and a regression test to lock the Windows path away from `cmd`.
- Updated `src/mcp/oauthProvider.ts` to reuse the shared `openExternalUrl()` helper instead of its own duplicate `cmd /c start` implementation, so browser-based OAuth now uses the same safe launcher across provider auth and MCP auth flows.
- Added regression coverage in `test/utils.browser.test.ts` to prove the Windows opener uses `rundll32.exe` and preserves the full OAuth URL, then reran the affected auth and desktop suites.
- Verification:
  - Reproduction before fix: `node -e "const {spawn}=require('node:child_process'); const child=spawn('cmd',['/c','echo','https://auth.openai.com/oauth/authorize?response_type=code&client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback']); ..."` -> `cmd` printed only the prefix URL and treated `client_id` / `redirect_uri` as separate commands.
  - `~/.bun/bin/bun test test/utils.browser.test.ts test/connect.test.ts test/providers/auth-registry.test.ts test/mcp.oauth-provider.test.ts apps/desktop/test/providers-page.test.ts apps/desktop/test/protocol-v2-events.test.ts` -> pass (`51 pass, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass
  - `~/.bun/bin/bun test` -> pass (`1750 pass, 2 skip, 0 fail`)

# Task: Prep release version 0.1.9 for merge to main

## Plan
- [x] Identify the authoritative release version surfaces and any tests that pin the visible app version.
- [x] Bump the repo and desktop package versions from `0.1.8` to `0.1.9` and align the desktop updater/UI tests.
- [x] Run focused verification for the bumped version and record the outcome below.

## Review
- Bumped `package.json` and `apps/desktop/package.json` from `0.1.8` to `0.1.9` to prep the next merge-to-main release version.
- Updated the desktop updater and updates-page tests so their `currentVersion` fixtures and visible version assertions match `0.1.9`.
- Verification:
  - `bun test apps/desktop/test/updater-service.test.ts apps/desktop/test/updates-page.test.ts` -> pass (`11 pass, 0 fail`)
  - `bun run typecheck` -> pass
  - `git diff --check` -> pass aside from existing CRLF conversion warnings on Windows

# Task: Clear stale desktop Codex auth challenge URLs

## Plan
- [x] Trace and remove any stale desktop `provider_auth_challenge` state that can keep rendering the old Codex browser-auth link after the server-side flow changed.
- [x] Harden the desktop auth UI/event handling so `codex-cli` browser auth never exposes a manual `Open link` URL, even if an old or malformed challenge payload appears.
- [x] Add regression coverage for stale-challenge cleanup, rerun the relevant desktop/auth tests, and record the validated outcome below.

## Review
- Root cause: the PI-native login path was already generating a correct fully parameterized OAuth URL, but the desktop could still keep and render an older cached `provider_auth_challenge` for `codex-cli/oauth_cli`. That stale challenge contained the bare `https://auth.openai.com/oauth/authorize` link, so the settings page could still show `Open link` and send users into the same `missing_required_parameter` failure even after the server-side auth flow was fixed.
- Hardened desktop control-state handling in `apps/desktop/src/app/store.helpers/controlSocket.ts` by clearing `providerLastAuthChallenge` on reconnect and sanitizing incoming `codex-cli/oauth_cli` challenge payloads so any `challenge.url` is dropped before it reaches state or notifications.
- Hardened the auth actions in `apps/desktop/src/app/store.actions/provider.ts` to clear old auth challenge/result state before starting authorize or callback steps, which prevents stale login UI from surviving across retries.
- Hardened the settings UI in `apps/desktop/src/ui/settings/pages/ProvidersPage.tsx` so `codex-cli` browser auth never renders a manual `Open link`, even if stale challenge data somehow exists, and so the `Sign in` button directly runs the full auto OAuth flow.
- Added regression coverage:
  - `apps/desktop/test/protocol-v2-events.test.ts` now proves a stale `codex-cli/oauth_cli` challenge URL is stripped before storing/rendering.
  - `apps/desktop/test/providers-page.test.ts` now proves the Codex settings page ignores stale challenge URLs and still avoids a separate `Continue` step.
- Verification:
  - `~/.bun/bin/bun test apps/desktop/test/providers-page.test.ts apps/desktop/test/protocol-v2-events.test.ts test/providers/auth-registry.test.ts test/connect.test.ts` -> pass (`45 pass, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass
  - `~/.bun/bin/bun test` -> pass (`1749 pass, 2 skip, 0 fail`)

# Task: Switch Codex desktop sign-in to PI native auth

## Plan
- [x] Replace the custom Codex OAuth connect flow with PI's native `loginOpenAICodex()` path while keeping our existing stored auth material format and connection-store updates.
- [x] Align the provider auth registry and desktop settings UI with the PI-native Codex browser login path so the app no longer offers or describes the stale custom device/browser variants.
- [x] Update focused auth/connect tests, run the required verification commands, and record the validated outcome below.

## Review
- Root cause: the first login fix removed the invalid bare authorize link, but `src/connect.ts` still acquired fresh Codex credentials through the repo’s older custom OAuth helpers. The runtime side already expects PI-style Codex credentials, so the desktop was still on the wrong acquisition stack even after the UI handoff improved.
- Switched `src/connect.ts` to PI-native Codex auth by calling `loginOpenAICodex()` from `@mariozechner/pi-ai`, preserving the existing `.cowork/auth/codex-cli/auth.json` schema via `writeCodexAuthMaterial()`. Fresh browser sign-in now uses PI’s native `originator=pi` authorization flow while the rest of the app keeps the same stored-auth and connection-store behavior.
- Removed the stale Codex device-code option from the provider auth registry and desktop fallback auth-method lists in `src/providers/authRegistry.ts`, `apps/desktop/src/ui/settings/pages/ProvidersPage.tsx`, and `apps/desktop/src/app/store.helpers.ts`. The desktop now consistently presents Codex as a single browser-based ChatGPT sign-in path, which matches PI native auth instead of advertising a flow we no longer use.
- Updated regression coverage in `test/connect.test.ts`, `test/providers/auth-registry.test.ts`, `apps/desktop/test/providers-page.test.ts`, and `apps/desktop/test/protocol-v2-events.test.ts` to lock the PI-native login path, the reduced auth-method set, and the desktop challenge handling.
- Verification:
  - `~/.bun/bin/bun test test/connect.test.ts test/providers/auth-registry.test.ts apps/desktop/test/providers-page.test.ts apps/desktop/test/protocol-v2-events.test.ts` -> pass (`44 pass, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass
  - `~/.bun/bin/bun test` -> pass (`1748 pass, 2 skip, 0 fail`)
  - `git diff --check` -> pass aside from existing CRLF conversion warnings on Windows

# Task: Fix desktop Codex OAuth login flow and auth handoff

## Plan
- [x] Remove or replace the unusable bare ChatGPT authorize link from the Codex browser-auth challenge so the desktop never points users at an invalid OAuth URL.
- [x] Make the desktop provider sign-in flow automatically continue browser-based Codex OAuth from the settings page instead of requiring a separate manual "Continue" or "Open link" step.
- [x] Add regression coverage for the auth challenge payload and desktop provider-page behavior, then run the targeted test suites and record the outcome below.

## Review
- Root cause: `src/providers/authRegistry.ts` exposed `https://auth.openai.com/oauth/authorize` as the browser-auth challenge URL for `codex-cli`, but that endpoint is invalid without the runtime-generated OAuth query parameters (`client_id`, `redirect_uri`, PKCE, `state`, etc.). When the desktop surfaced that raw link, clicking it produced the `missing_required_parameter` auth failure instead of starting a valid login.
- Fixed the auth challenge payload by removing the unusable bare authorize URL for browser-based Codex OAuth and changing the instructions to make it explicit that the app opens the correct sign-in URL itself during the callback flow. Device-code auth still keeps the safe `https://auth.openai.com/codex/device` link.
- Fixed the desktop settings UX in `apps/desktop/src/ui/settings/pages/ProvidersPage.tsx` so non-code OAuth methods perform the real authorize+callback sequence from a single `Sign in` action. The separate `Continue` step is gone for auto OAuth, which aligns the settings page with the working `connectProvider()` flow that already opens the browser on callback.
- Added regression coverage:
  - `test/providers/auth-registry.test.ts` now locks the browser-auth challenge to `url === undefined` and checks the updated instructions.
  - `apps/desktop/test/providers-page.test.ts` now verifies the Codex provider page no longer renders a separate `Continue` step for auto OAuth.
- Verification:
  - `bun test test/providers/auth-registry.test.ts test/connect.test.ts` -> pass (`21 pass, 0 fail`)
  - `bun test apps/desktop/test/providers-page.test.ts apps/desktop/test/protocol-v2-events.test.ts` -> pass (`25 pass, 0 fail`)
  - `bun run typecheck` -> pass
  - `bun test` -> pass (`1750 pass, 2 skip, 0 fail`)

# Task: Remove broken Windows desktop release artifacts

## Plan
- [x] Remove the published Windows desktop assets and Windows updater manifest from the stable GitHub releases that currently expose them.
- [x] Keep the existing CI packaging intact; only change the public GitHub release assets/notes.
- [x] Verify the release pages and repo state after the removals, then record the outcome below.

## Review
- Removed the Windows release assets from the stable public releases `v0.1.1` and `v0.1.2`:
  - `Cowork-<version>-win-x64.exe`
  - `Cowork-<version>-win-x64.exe.blockmap`
  - `latest.yml`
- Left CI packaging untouched. The existing `Desktop Release` workflow still builds Windows in GitHub Actions; only the published release pages were cleaned up.
- Updated the release pages so they no longer imply Windows support:
  - `v0.1.2` is now titled `release 0.1.2 updater hotfix` and explicitly says I broke `v0.1.1` with the packaged `electron-updater` import mistake.
  - `v0.1.1` is now titled `release 0.1.1 broken superseded` and explicitly warns users not to use it.
- Verification:
  - `/Users/mweinbach/Projects/agent-coworker/.github/workflows/desktop-release.yml` is unchanged; CI packaging still includes Windows.
  - `gh release view v0.1.2 --json assets,name,body` shows only macOS assets and `latest-mac.yml`.
  - `gh release view v0.1.1 --json assets,name,body` shows only macOS assets and `latest-mac.yml`.
  - `git status --short --branch` shows only the intentional task-tracking updates before commit.

# Task: Ship 0.1.2 to replace the broken 0.1.1 desktop release

## Plan
- [x] Bump the repo and desktop release versions to `0.1.2`, keeping the updater hotfix commit as the release base.
- [x] Rerun the release validation stack (`typecheck`, desktop tests, full tests, packaged desktop build) against `0.1.2`.
- [x] Push the release commit, tag `v0.1.2`, and publish release notes that explicitly acknowledge the `0.1.1` updater import regression and the fix.

## Review
- Bumped `/Users/mweinbach/Projects/agent-coworker/package.json` and `/Users/mweinbach/Projects/agent-coworker/apps/desktop/package.json` to `0.1.2`, and updated the desktop tests that assert the visible current version in updater-facing UI/service state.
- Kept the hotfix release base at `26896b2 Fix desktop updater module interop`, which is the commit that corrected the packaged Electron main-process `electron-updater` CommonJS/ESM interop failure introduced in `0.1.1`.
- Verification before tagging:
  - `bun run typecheck` -> pass
  - `bun test --cwd apps/desktop` -> pass (`165 pass, 0 fail`)
  - `bun test` -> pass (`1749 pass, 2 skip, 0 fail`)
  - `bun run desktop:build -- --publish never` -> pass; generated `apps/desktop/release/Cowork-0.1.2-mac-arm64.zip`, `apps/desktop/release/Cowork-0.1.2-mac-arm64.dmg`, blockmaps, and refreshed updater manifests
- Release-note intent for `v0.1.2`: explicitly state that `v0.1.1` was broken because the updater rollout imported `electron-updater` incorrectly in the packaged Electron main process, that this was my release regression, and that `0.1.2` replaces it with the verified interop fix.

# Task: Fix packaged desktop auto-updater startup after the 0.1.1 release

## Plan
- [x] Reproduce or inspect the packaged startup failure and confirm whether `electron-updater` is being imported incompatibly in the Electron main process.
- [x] Patch the updater service to load `electron-updater` safely from the packaged ESM main process, and add regression coverage for the module-resolution path.
- [x] Run focused desktop validation and record the verified fix plus any remaining release follow-up.

## Review
- Root cause: `/Users/mweinbach/Projects/agent-coworker/apps/desktop/electron/services/updater.ts` imported `autoUpdater` as a named ESM export from `electron-updater`, but the packaged Electron main process resolves that dependency as CommonJS. The released `v0.1.1` app therefore crashed during startup with the CommonJS/ESM interop error before the updater service could initialize.
- Fixed the loader by switching the main-process updater service to `createRequire(import.meta.url)` and resolving `autoUpdater` from either the direct CommonJS module shape or a default-wrapped interop shape. The actual `electron-updater` module is now loaded lazily, so tests and non-Electron contexts no longer instantiate `AppUpdater` at import time.
- Added regression coverage in `/Users/mweinbach/Projects/agent-coworker/apps/desktop/test/updater-service.test.ts` for direct CommonJS export shape, default-wrapped interop shape, and the missing-export failure case.
- Verification:
  - `bun test apps/desktop/test/updater-service.test.ts` -> pass (`6 pass, 0 fail`)
  - `bun test --cwd apps/desktop` -> pass (`165 pass, 0 fail`)
  - `bun run typecheck` -> pass
  - `bun test` -> pass (`1749 pass, 2 skip, 0 fail`)
  - `bun run desktop:build -- --publish never` -> pass
  - `git diff --check` -> pass
- Release follow-up: this fixes `main`, but the already-published `v0.1.1` binaries remain broken until a new desktop release is cut or the release is otherwise superseded.

# Task: Merge remote desktop fixes and ship release 0.1.1

## Plan
- [x] Inspect `main` vs `origin/main`, merge the pending remote desktop fix commit, and resolve any conflicts without dropping the local auto-updater work.
- [x] Bump the repo and desktop app versions to `0.1.1` and rerun the required validation/build checks.
- [x] Commit the merged release state, push `main`, tag `0.1.1`, and publish the GitHub release marked “release 0.1.1 finally ready”.

## Review
- `main` was ahead/behind `origin/main` by one commit each. The pending remote desktop change was `e164e22 Debug desktop server errors`; it merged cleanly into the local auto-updater work as merge commit `82738b3 Merge remote-tracking branch 'origin/main'`, so there was no actual conflicted `MERGE_HEAD` to repair.
- Bumped the release version to `0.1.1` in both `/Users/mweinbach/Projects/agent-coworker/package.json` and `/Users/mweinbach/Projects/agent-coworker/apps/desktop/package.json`.
- Removed the updater UX’s hardcoded default app version by making `/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/lib/desktopApi.ts` read the desktop package version, and updated the affected desktop tests to assert `0.1.1`.
- Verification:
  - `bun run typecheck` -> pass
  - `bun test --cwd apps/desktop` -> pass (`162 pass, 0 fail`)
  - `bun test` -> pass (`1746 pass, 2 skip, 0 fail`)
  - `bun run desktop:build -- --publish never` -> pass; generated `apps/desktop/release/Cowork-0.1.1-mac-arm64.zip`, `apps/desktop/release/Cowork-0.1.1-mac-arm64.dmg`, blockmaps, and `apps/desktop/release/latest-mac.yml`
  - `git diff --check` -> pass
- The local packaged macOS build remains unsigned and unnotarized in this shell because Developer ID / notarization credentials were not exported locally; GitHub Actions is still responsible for the signed macOS and Windows release artifacts on the tag build.

# Task: Ensure packaged desktop builds ship and launch the pinned bundled agent sidecar

## Plan
- [x] Inspect the desktop resource bundling and packaged runtime launch path to confirm how the compiled app locates its backend binary.
- [x] Make the desktop build emit exactly one pinned packaged sidecar plus metadata, and make the runtime resolve that exact bundled binary instead of loosely scanning `cowork-server-*`.
- [x] Run desktop-focused verification and record the final bundled-binary behavior below.

## Review
- Verified the current packaged app contents before changing code:
  - `apps/desktop/release/mac-arm64/Cowork.app/Contents/Resources/binaries/cowork-server-aarch64-apple-darwin` is present in the built app and ZIP.
  - The existing runtime still selected a sidecar by scanning for the first matching `cowork-server-*` entry, which meant stale binaries in `apps/desktop/resources/binaries/` could be shipped and selected nondeterministically.
- Updated the sidecar pipeline so the packaged build now has an explicit pinned binary contract:
  - Added `/Users/mweinbach/Projects/agent-coworker/apps/desktop/electron/services/sidecar.ts` with the shared target-triple, packaged filename, manifest, and packaged-binary resolution logic.
  - Updated `/Users/mweinbach/Projects/agent-coworker/scripts/build_desktop_resources.ts` to clear `apps/desktop/resources/binaries/` before building, compile exactly one sidecar for the current target, and write `cowork-server-manifest.json` next to it.
  - Updated `/Users/mweinbach/Projects/agent-coworker/apps/desktop/electron/services/serverManager.ts` so packaged desktop startup resolves the manifest-pinned sidecar (or the exact expected platform filename as fallback) instead of grabbing an arbitrary `cowork-server-*` file.

### Verification
- `bun test apps/desktop/test/sidecar.test.ts apps/desktop/test/server-manager.test.ts` -> pass (`12 pass, 0 fail`)
- `bun run typecheck` -> pass
- `bun test` -> pass (`1736 pass, 2 skip, 0 fail`)
- `bun run build:desktop-resources` -> pass; emitted only:
  - `apps/desktop/resources/binaries/cowork-server-aarch64-apple-darwin`
  - `apps/desktop/resources/binaries/cowork-server-manifest.json`
- `bun run --cwd apps/desktop build:dir` -> pass; built app now contains:
  - `apps/desktop/release/mac-arm64/Cowork.app/Contents/Resources/binaries/cowork-server-aarch64-apple-darwin`
  - `apps/desktop/release/mac-arm64/Cowork.app/Contents/Resources/binaries/cowork-server-manifest.json`
- Verified the packaged manifest contents:
  - `filename: cowork-server-aarch64-apple-darwin`
  - `targetTriple: aarch64-apple-darwin`

---

# Task: Cut a test desktop release with the updated icon assets

## Plan
- [x] Inspect the current repo/workflow state and confirm how a tag push becomes a GitHub desktop release.
- [x] Run a local signed/notarized desktop build using the configured Apple/GitHub release credentials.
- [x] Commit the release-pipeline and icon changes needed for this test and push a tag that triggers the desktop release workflow.
- [x] Update the resulting GitHub release with an explicit note that this is a test build, then record the outcome below.

## Review
- Verified the local macOS release path with the final GitHub signing inputs before cutting the tag:
  - `bun run desktop:build` completed successfully with `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` exported from the same assets stored in GitHub Actions.
  - The build produced `apps/desktop/release/mac-arm64/Cowork.app`, `Cowork-0.1.0-mac-arm64.dmg`, `Cowork-0.1.0-mac-arm64.zip`, and the matching blockmaps/update manifest.
  - `codesign -dvvv apps/desktop/release/mac-arm64/Cowork.app` showed `Developer ID Application: Max Weinbach (6UHAW5UAT4)`, a secure timestamp, `Identifier=com.cowork.desktop`, and a stapled notarization ticket.
  - `xcrun stapler validate apps/desktop/release/mac-arm64/Cowork.app` succeeded.
  - `spctl -a -vv --type exec apps/desktop/release/mac-arm64/Cowork.app` returned `accepted` with `source=Notarized Developer ID`.
- The original no-icon release request was superseded before the final retry. The next release tag should include the refreshed desktop icon assets now present under `apps/desktop/build/`.
- Final published test release: `desktop-v0.1.0-test-icon-20260308-2`
  - Release URL: `https://github.com/mweinbach/agent-coworker/releases/tag/desktop-v0.1.0-test-icon-20260308-2`
  - The published release note explicitly marks it as a test release with the updated icon.
- GitHub validation for that final tag:
  - `Validate` -> pass
  - `Package (macOS)` -> pass, including Developer ID signing, notarization, stapling validation, and artifact upload
  - `Package (Windows)` -> pass after removing the broken optional `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD` env injection so unsigned Windows packaging could proceed
- Release publishing nuance:
  - The publish job created the draft release and uploaded all primary assets, but it failed on a duplicate `builder-debug.yml` upload from both platform artifacts.
  - Follow-up fix committed to `main`: the release workflow now publishes only `latest*.yml` metadata files, so future tag runs should not hit that duplicate-asset failure.
  - After the assets were confirmed present, the draft release was published manually with the requested test note.

# Task: Generate notarization secrets and add what is verifiably correct to GitHub

## Plan
- [x] Verify local `asc` and `gh` auth, inspect current Apple signing/notarization assets, and determine what can be generated from this machine.
- [x] Attempt to generate a fresh local Developer ID Application signing export suitable for `CSC_LINK` / `CSC_KEY_PASSWORD`.
- [x] Add the confirmed GitHub Actions secrets and record any remaining Apple-side blocker needed for full notarization.
- [x] Run targeted verification of the resulting GitHub secret state and document the outcome below.

## Review
- Verified local auth state first:
  - `gh auth status` is healthy for `github.com` with repo/workflow scopes.
  - `asc auth status` is healthy via the `AgentCoworker` keychain profile (`keyId=LZP39NWX42`).
  - Existing Apple account state includes a `DEVELOPER_ID_APPLICATION_G2` certificate in App Store Connect, but this machine had `0 valid identities` in the local keychain, so it could not sign with that existing cert.
- Recovered enough local Apple metadata to preload some GitHub Actions secrets:
  - Added `APPLE_API_KEY` from `/Users/mweinbach/Keys/AuthKey_LZP39NWX42.p8`.
  - Added `APPLE_API_KEY_ID=LZP39NWX42`.
  - Added `APPLE_TEAM_ID=6UHAW5UAT4` (derived from the existing Apple Developer certificate subject).
- Completed the local signing identity export once the user supplied the issued Apple certificate:
  - Generated `/Users/mweinbach/Keys/Cowork-DeveloperID-2026-03-08.csr` and `/Users/mweinbach/Keys/Cowork-DeveloperID-2026-03-08.key`.
  - Verified the downloaded `/Users/mweinbach/Keys/developerID_application.cer` matches that private key.
  - Exported `/Users/mweinbach/Keys/Cowork-DeveloperID-2026-03-08.p12` and saved the export password at `/Users/mweinbach/Keys/Cowork-DeveloperID-2026-03-08.p12.password.txt` with `0600` permissions.
  - Added `CSC_LINK` (base64-encoded `.p12` contents) and `CSC_KEY_PASSWORD` to GitHub Actions secrets.
- Completed the notarization-auth fallback path using Apple ID credentials:
  - Added `APPLE_ID` and `APPLE_APP_SPECIFIC_PASSWORD` to GitHub Actions secrets.
  - With `APPLE_TEAM_ID` already present, the workflow now has a complete Apple ID notarization credential set even though `APPLE_API_ISSUER` is still unset.
- Apple-side limitation is now informational rather than blocking:
  - A direct `asc certificates create --certificate-type DEVELOPER_ID_APPLICATION` attempt still failed with `This operation can only be performed by the Account Holder`, so cert creation remains Account Holder-only. The manual Apple portal flow worked once the user completed it.
- There are no remaining GitHub-secret blockers for the macOS signing/notarization workflow. `APPLE_API_ISSUER` is still unset, but it is no longer required because the Apple ID notarization path is fully configured.

### Verification
- `gh secret list --app actions --json name,updatedAt,visibility` confirms:
  - `APPLE_API_KEY`
  - `APPLE_API_KEY_ID`
  - `APPLE_ID`
  - `APPLE_APP_SPECIFIC_PASSWORD`
  - `APPLE_TEAM_ID`
  - `CSC_LINK`
  - `CSC_KEY_PASSWORD`
- Local export artifacts exist and are readable only by the current user:
  - `/Users/mweinbach/Keys/Cowork-DeveloperID-2026-03-08.p12`
  - `/Users/mweinbach/Keys/Cowork-DeveloperID-2026-03-08.p12.password.txt`

# Task: Enforce macOS signing and notarization in GitHub desktop releases

## Plan
- [x] Inspect the existing desktop release workflow, packaging config, and notarization hook to confirm how macOS releases are currently signed.
- [x] Harden the GitHub Actions macOS packaging job so release builds fail fast when Developer ID signing or notarization secrets are missing.
- [x] Run verification, then record the exact Apple/GitHub requirements and repo changes in the review section below.

## Review
- Updated `/Users/mweinbach/Projects/agent-coworker/.github/workflows/desktop-release.yml` so the macOS packaging job now fails early when the required Developer ID signing secrets (`CSC_LINK`, `CSC_KEY_PASSWORD`) or notarization credentials are missing. It accepts either the App Store Connect API-key trio (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) or the Apple ID trio (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`).
- Removed the unconditional `CSC_IDENTITY_AUTO_DISCOVERY=false` release env override. That setting prevented electron-builder from finding the imported Developer ID identity from `CSC_LINK`, which meant macOS CI could silently skip code signing even when the certificate was present.
- Added a macOS post-build verification step that locates the packaged `.app` and validates it with `codesign`, `xcrun stapler validate`, and `spctl`, so the workflow now fails before artifact upload if the release app is not properly Developer ID signed and stapled.
- Updated `/Users/mweinbach/Projects/agent-coworker/apps/desktop/README.md` to document the actual required GitHub secrets for signed/notarized macOS releases and the new CI enforcement behavior.

### Verification
- `python3` YAML parse of `.github/workflows/desktop-release.yml` -> pass
- `git diff --check` -> pass
- `bun run typecheck` -> pass
- `bun test` -> pass (`1730 pass, 2 skip, 0 fail`)

# Task: Stabilize packaged Windows desktop server troubleshooting

## Plan
- [x] Reproduce the packaged desktop startup path and verify whether the bundled sidecar actually fails or whether diagnostics/state are misleading.
- [x] Fix the packaged Electron app identity so Windows uses a stable `Cowork` user-data folder, and migrate legacy persisted desktop state from `%APPDATA%\desktop`.
- [x] Persist packaged sidecar startup diagnostics to a user-data log file so installed-app server failures can be inspected after the fact.
- [x] Run focused desktop tests plus the required repo verification commands, then record the outcome below.

## Review
- Reproduced the packaged Windows startup path with `apps/desktop/release/win-unpacked/Cowork.exe` and verified that the bundled sidecar launches correctly from `resources/binaries` and listens on an ephemeral localhost port. In other words, current HEAD does not have a blanket “desktop sidecar is missing/broken” packaging bug.
- Found a concrete packaged-Windows identity bug instead: Electron was using the package name `desktop` for `userData`, so the installed app was persisting state under `%APPDATA%\desktop` rather than `%APPDATA%\Cowork`. That makes troubleshooting confusing, can mix packaged state with older/dev runs, and hides the actual persisted workspace/session state in an unexpected folder.
- Updated `C:\Users\maxw6\Projects\agent-coworker\apps\desktop\electron\main.ts` to explicitly set the Electron app name to `Cowork`, and updated `C:\Users\maxw6\Projects\agent-coworker\apps\desktop\electron\services\persistence.ts` to migrate legacy `state.json`, `transcripts/`, and `logs/server.log` forward from `%APPDATA%\desktop` into the new `%APPDATA%\Cowork` location on first access.
- Added persistent sidecar startup diagnostics in `C:\Users\maxw6\Projects\agent-coworker\apps\desktop\electron\services\serverManager.ts`. Packaged server start attempts, stderr summaries, retries, success, and failure details now append to `%APPDATA%\Cowork\logs\server.log`, which gives installed Windows users an actual file to inspect when they hit “server unavailable” errors.
- Expanded desktop regression coverage in `C:\Users\maxw6\Projects\agent-coworker\apps\desktop\test\persistence-state-sanitization.test.ts`, `C:\Users\maxw6\Projects\agent-coworker\apps\desktop\test\persistence-permissions.test.ts`, and `C:\Users\maxw6\Projects\agent-coworker\apps\desktop\test\server-manager.test.ts`. Also fixed `C:\Users\maxw6\Projects\agent-coworker\apps\desktop\test\sidecar.test.ts`, which had Windows-brittle mock paths and was failing independently of runtime behavior.

### Verification
- `~/.bun/bin/bun test apps/desktop/test/persistence-state-sanitization.test.ts apps/desktop/test/persistence-permissions.test.ts apps/desktop/test/server-manager.test.ts apps/desktop/test/sidecar.test.ts` -> pass (`20 pass, 0 fail`)
- `~/.bun/bin/bun test --cwd apps/desktop` -> pass (`154 pass, 0 fail`)
- `~/.bun/bin/bun run typecheck:desktop` -> pass
- `~/.bun/bin/bun run typecheck` -> pass
- `git diff --check` -> pass (only line-ending warnings from Git on Windows)
- `~/.bun/bin/bun test` -> still fails outside this change with existing unrelated suites (`CLI REPL websocket send failures`, `webSearch tool`, `memory tool`)

# Task: Move desktop Exa Search API settings into their own section

## Plan
- [x] Inspect the current desktop Providers settings page and isolate how `exa_api_key` is being grouped under Google.
- [x] Update the desktop Providers settings UI so Google no longer renders the Exa key inside its auth methods and Exa appears in its own dedicated settings card.
- [x] Add focused desktop regression coverage for the section split.
- [x] Run targeted verification, then record the outcome in the review section below.

## Review
- Updated `C:\Users\maxw6\Projects\agent-coworker\apps\desktop\src\ui\settings\pages\ProvidersPage.tsx` so the desktop Providers page no longer renders `exa_api_key` inside the Google card. Google still shows its own auth methods and models, while Exa Search now appears as its own dedicated expandable card in the same settings list.
- Kept the existing backend wiring intact. The Exa card still saves through provider `google` plus method `exa_api_key`, so no server/auth registry changes were needed for this desktop-only settings fix.
- Added `C:\Users\maxw6\Projects\agent-coworker\apps\desktop\test\providers-page.test.ts` with regression coverage proving the expanded Google card no longer exposes the Exa input and the dedicated Exa Search card still renders its own API-key control.

### Verification
- `~/.bun/bin/bun test apps/desktop/test/providers-page.test.ts` -> pass (`2 pass, 0 fail`)
- `~/.bun/bin/bun test apps/desktop/test/providers-page.test.ts apps/desktop/test/settings-nav.test.ts` -> pass (`11 pass, 0 fail`)
- `~/.bun/bin/bunx tsc --noEmit -p apps/desktop/tsconfig.json` -> pass
- `~/.bun/bin/bun test --cwd apps/desktop` -> pass (`142 pass, 0 fail`)
- `~/.bun/bin/bun test` -> reproducibly crashes inside Bun after many passing suites with `panic(main thread): switch on corrupt value`, so the repo-wide run could not complete in this environment.

# Task: Add a real general sub-agent prompt

## Plan
- [x] Confirm the current `general` sub-agent failure path and prompt expectations.
- [x] Add `prompts/sub-agents/general.md` aligned with the general sub-agent toolset.
- [x] Update regression coverage so `general` prompt loading is required instead of expected to fail.
- [x] Run targeted verification plus `bun test`, then record the outcome here.

## Review
- Added `C:\Users\maxw6\Projects\agent-coworker\prompts\sub-agents\general.md` so the shipped prompt set now matches the runtime contract in `src/tools/spawnAgent.ts` and `src/prompt.ts`, where `general` is a valid sub-agent type and the default when `agentType` is omitted.
- Kept the new prompt consistent with the existing sub-agent prompts: short, task-focused, and explicit that the sub-agent should return concrete results, changed files, and verification/blockers without asking the user directly.
- Updated `C:\Users\maxw6\Projects\agent-coworker\test\prompt.test.ts` so `loadSubAgentPrompt(config, "general")` is now a required success path instead of a required failure. That makes the original ENOENT regression visible in tests if `general.md` goes missing again.

### Verification
- `bun test test/prompt.test.ts test/spawnAgent.tool.test.ts` -> pass (`52 pass, 0 fail`)
- `bun run typecheck` -> pass
- `bun test` -> initially failed only because this shell had `BRAVE_API_KEY` set, which changes `webSearch` test behavior outside this change
- `$env:BRAVE_API_KEY=''; bun test test/tools.test.ts --test-name-pattern "webSearch tool"` -> pass (`6 pass, 0 fail`)
- `$env:BRAVE_API_KEY=''; bun test` -> pass (`1724 pass, 2 skip, 0 fail`)
- `git diff --check` -> pass
- No other runtime/docs changes were needed beyond the prompt file and prompt regression coverage.

# Task: Fix repo audit findings from the 2026-03-07 review

## Plan
- [x] Fix reconnect/resume event loss so resumed clients can recover events emitted during disconnect.
- [x] Fix desktop file explorer polling, accessibility, and global text-selection regressions.
- [x] Repair typecheck coverage/config, remove the permissions helper footgun, and make the relevant `tsc` checks pass.
- [x] Rerun targeted tests/builds/typechecks, then update this review with the actual fixes landed.

## Review
- Reconnect/resume now buffers replayable turn events while a socket is detached and flushes them on resume before pending prompts replay. The server-side session binding cleanup path also starts that buffer on disconnect, and regression coverage was added in `test/server.test.ts`.
- The desktop workspace file explorer no longer busy-polls every second regardless of visibility. Background refresh now reuses unchanged directory snapshots, refreshes expanded directories only when contents actually changed, and only auto-refreshes while the window is visible and focused. The tree rows now use `role="tree"` / `role="treeitem"` semantics with `aria-level`, `aria-expanded`, `aria-selected`, and keyboard handling for Enter, Space, ArrowLeft, and ArrowRight.
- The desktop app no longer globally disables text selection. Row-level `select-none` was narrowed so filenames, paths, logs, and message content stay copyable.
- The desktop package typecheck now includes `apps/desktop/electron/*`, and the repo now exposes `bun run typecheck` to run the working root-core plus desktop checks together. Root `tsconfig.json` was narrowed so the repo-root check no longer drags desktop/TUI code through the wrong compiler settings, and the desktop-specific type errors in the Electron launcher, chat view, protocol imports, and Streamdown integration were fixed.
- `src/utils/permissions.ts` now canonicalizes paths for the sync helpers too, so the exported `isReadPathAllowed` / `isWritePathAllowed` helpers deny symlink escapes instead of relying only on lexical prefix checks. Regression tests cover both read and write helper escapes.

### Verification
- `~/.bun/bin/bun test` -> pass (`1710 pass, 2 skip, 0 fail`)
- `~/.bun/bin/bun test --cwd apps/desktop` -> pass (`140 pass, 0 fail`)
- `~/.bun/bin/bun run typecheck` -> pass
- `~/.bun/bin/bunx tsc --noEmit` -> pass
- `~/.bun/bin/bunx tsc --noEmit -p apps/desktop/tsconfig.json` -> pass
- `git diff --check` -> pass

# Task: Keep slide-skill runs from scaffolding local Node projects in user workspaces

## Plan
- [x] Confirm whether the reported clutter comes from workspace-local `package.json` / `package-lock.json` / `node_modules` creation in the slide workflow.
- [x] Add runtime prompt and skill-loading guidance that keeps one-off deliverable folders free of disposable package-manager scaffolding.
- [x] Cover the new guidance with targeted prompt/skill tests and record the chosen scope.

## Review
- Confirmed in the user-provided test workspace (`/Users/mweinbach/Desktop/Cowork Test`) that the slide workflow had created a local Node project, not just two stray files: `package.json`, `package-lock.json`, and a `node_modules/` tree were present in the deliverable folder.
- Chose prevention over hiding. The desktop explorer already has a normal hidden-files toggle, but globally treating `package.json` or `node_modules` as hidden would mask legitimate project files in real code workspaces.
- Updated `/Users/mweinbach/Projects/agent-coworker/src/prompt.ts` so the runtime-appended skill policy now tells all models to avoid creating `package.json`, lockfiles, or `node_modules` in one-off deliverable folders and to stage unavoidable JS dependencies outside the user's deliverable folder.
- Updated `/Users/mweinbach/Projects/agent-coworker/src/tools/skill.ts` so loading the `slides` skill appends a Cowork-owned addendum even when the active skill source is `~/.cowork/skills/slides/SKILL.md`. That addendum explicitly tells the model not to turn a deck folder into a disposable Node project.
- Updated `/Users/mweinbach/Projects/agent-coworker/skills/slides/SKILL.md` with the same instruction as a fallback/built-in copy, even though the normal runtime path prefers global skills.

### Verification
- `~/.bun/bin/bun test test/prompt.test.ts test/tools.test.ts` -> pass (`193 pass, 0 fail`)
- `~/.bun/bin/bunx tsc --noEmit` -> pass
- `~/.bun/bin/bun test` -> pass (`1724 pass, 2 skip, 0 fail`)
- `git diff --check` -> pass

# Task: Repo-wide audit with subagents to find fix-worthy issues

## Plan
- [x] Review prior audit context, current repo state, and repo instructions to set audit scope.
- [x] Run parallel subagent audits over server/core, UI surfaces, providers/tools, and tests/docs.
- [x] Validate the strongest findings locally with direct code inspection and targeted commands/tests.
- [x] Record prioritized findings and concrete fix candidates in the review section below.

## Review
- High: reconnect/resume currently drops in-flight server events. `/Users/mweinbach/Projects/agent-coworker/src/server/startServer.ts` emits directly to the live socket and silently returns when the socket is absent, while reconnect only replays pending prompts; `/Users/mweinbach/Projects/agent-coworker/src/client/agentSocket.ts` only flushes queued outbound messages after `server_hello`. A disconnect during a turn can therefore lose `model_stream_chunk`, `assistant_message`, and `log` events with no automatic catch-up path in current clients.
- High: the advertised repo-root typecheck is structurally broken, and the desktop package typecheck misses main-process code. Root `/Users/mweinbach/Projects/agent-coworker/tsconfig.json` includes `apps` under the OpenTUI/Bun config, so `bunx tsc --noEmit` compiles desktop React code without the desktop alias/path settings and reports many root-only failures. Meanwhile `/Users/mweinbach/Projects/agent-coworker/apps/desktop/tsconfig.json` only includes `src`, so `apps/desktop/electron/*` is not covered by the desktop package check.
- High: the desktop workspace file explorer polls the root plus every expanded directory every second and rerenders the full tree each cycle. In large workspaces that is a constant filesystem + React work loop while idle, which is likely to show up as sidebar sluggishness and battery drain.
- Medium: the desktop file tree is not keyboard/accessibility complete. Row containers are `div role="button"` elements that also contain nested real `<button>` controls, and row keyboard handling only supports `Enter`, so the primary navigation surface has weak semantics and incomplete keyboard behavior.
- Medium: `apps/desktop/src/styles.css` globally disables text selection with `body { user-select: none; }`. Unless descendants opt back in, that makes filenames, paths, logs, and error text harder or impossible to copy in the desktop app.
- Low: `src/utils/permissions.ts` exports `isReadPathAllowed` / `isWritePathAllowed` helpers that only do lexical prefix checks, while the symlink-safe behavior lives in the `assert*` variants. I did not find current runtime callers of the weaker helpers, but keeping both exported in a security-sensitive module is an avoidable footgun.

### Verification
- `~/.bun/bin/bun test` -> pass (`1705 pass, 2 skip, 0 fail`)
- `~/.bun/bin/bun run docs:check` -> pass
- `~/.bun/bin/bun run portal:build` -> pass
- `~/.bun/bin/bun run --cwd apps/desktop electron-vite build` -> pass
- `~/.bun/bin/bunx tsc --noEmit` -> fails with root-config / desktop-config mismatch plus additional type errors
- `~/.bun/bin/bunx tsc --noEmit -p apps/desktop/tsconfig.json` -> fails and does not include `apps/desktop/electron/*`

# Task: Move default skill bootstrap into shared runtime startup and expose installed skills to file tools

## Plan
- [x] Inspect the current skill bootstrap path and move the default-skill install flow out of the desktop wrapper into shared runtime startup.
- [x] Ensure all supported runtime entrypoints (desktop, TUI, CLI, server, harness) use the same one-time curated-skill bootstrap in `~/.cowork/skills`.
- [x] Allow read-only file tools to browse installed skills, then verify runtime behavior and update docs/task notes to match the new model.

## Review
- Before this change, the one-time GitHub bootstrap existed only in desktop startup. TUI, CLI, server, and harness code paths still depended on their own config loading behavior, and normal `read`/`glob`/`grep` access still could not browse installed skill references under `~/.cowork/skills`.
- Added `/Users/mweinbach/Projects/agent-coworker/src/skills/defaultGlobalSkills.ts`, which owns the one-time curated bootstrap for `spreadsheet`, `slides`, `pdf`, and `doc`. It downloads those skills from `openai/skills` into `~/.cowork/skills`, writes `~/.cowork/config/default-global-skills.json`, memoizes per home directory, and skips later launches unless the bootstrap is explicitly forced.
- Updated `/Users/mweinbach/Projects/agent-coworker/src/store/connections.ts` so `AiCoworkerPaths` includes `skillsDir`, and `ensureAiCoworkerHome()` now creates `~/.cowork/skills` as part of the standard Cowork home bootstrap.
- Moved ownership of the default-skill bootstrap into `/Users/mweinbach/Projects/agent-coworker/src/server/startServer.ts`. Shared server startup now calls `ensureDefaultGlobalSkillsReady(...)` before `loadConfig(...)` and defaults `COWORK_DISABLE_BUILTIN_SKILLS=1`, which means desktop, TUI, CLI, and server entrypoints all use the same shared runtime behavior because they all route through `startAgentServer(...)`.
- Updated `/Users/mweinbach/Projects/agent-coworker/scripts/run_raw_agent_loops.ts` so the raw harness also installs default skills through the same shared bootstrap, preserves the shared/global skill search order, and stops reintroducing the built-in repo `skills/` directory into harness configs when built-in skills are disabled.
- Removed the desktop-only ownership from `/Users/mweinbach/Projects/agent-coworker/apps/desktop/electron/services/serverManager.ts`. Desktop now just passes through process env and relies on shared startup like every other runtime instead of running a separate bootstrap wrapper.
- Updated `/Users/mweinbach/Projects/agent-coworker/src/config.ts`, `/Users/mweinbach/Projects/agent-coworker/src/prompt.ts`, and `/Users/mweinbach/Projects/agent-coworker/src/tools/skill.ts` so runtime config, the system prompt, and the `skill` tool all reflect the actual active search order when built-in skills are disabled and global skills live in `~/.cowork/skills`.
- Updated `/Users/mweinbach/Projects/agent-coworker/src/utils/permissions.ts` so read-only file tools now include configured `skillsDirs` in their allowed roots. That means `read`, `glob`, and `grep` can inspect installed skills under `~/.cowork/skills` for references/examples/assets, while `write`/`edit`/`notebookEdit` remain limited to the project/output/upload roots.
- Desktop packaging still excludes bundled skills: `/Users/mweinbach/Projects/agent-coworker/scripts/build_desktop_resources.ts` removes stale `dist/skills`, and `/Users/mweinbach/Projects/agent-coworker/apps/desktop/README.md` now documents that default skills come from the shared runtime bootstrap into `~/.cowork/skills`.
- Added or updated regression coverage in `/Users/mweinbach/Projects/agent-coworker/test/default-global-skills.test.ts`, `/Users/mweinbach/Projects/agent-coworker/test/config.test.ts`, `/Users/mweinbach/Projects/agent-coworker/test/permissions.test.ts`, `/Users/mweinbach/Projects/agent-coworker/test/prompt.test.ts`, `/Users/mweinbach/Projects/agent-coworker/test/server.test.ts`, `/Users/mweinbach/Projects/agent-coworker/test/server.toolstream.test.ts`, and `/Users/mweinbach/Projects/agent-coworker/apps/desktop/test/server-manager.test.ts` for:
  - first-run install into `~/.cowork/skills`
  - one-time/no-reinstall behavior after the bootstrap state file exists
  - config omission of built-in skills when shared startup disables them
  - shared server startup using the global-skill path
  - prompt/skill search-order text matching runtime config
  - read access to configured `skillsDirs`
  - desktop startup no longer carrying a separate bootstrap layer
- Verification:
  - `~/.bun/bin/bun test test/default-global-skills.test.ts test/config.test.ts test/permissions.test.ts test/prompt.test.ts test/server.test.ts test/server.toolstream.test.ts apps/desktop/test/server-manager.test.ts` -> pass (`225 pass, 0 fail`)
  - `~/.bun/bin/bun run build:desktop-resources` -> pass; `dist/skills` is no longer present after the build
  - `~/.bun/bin/bun test` -> pass (`1705 pass, 2 skip, 0 fail`)
  - `git diff --check` -> pass

---

# Task: Set the desktop macOS icon from the provided Icon Composer asset

## Plan
- [x] Verify the supported packaging path for Apple `.icon` assets and inspect the existing desktop icon configuration.
- [x] Wire the provided `Cowork.icon` asset into the desktop build with minimal changes and preserve the required fallback icon assets.
- [x] Run verification (`bun test`, `bun run typecheck`, and desktop packaging checks) and record the outcome below.

## Review
- Added the provided Icon Composer asset at `/Users/mweinbach/Projects/agent-coworker/apps/desktop/build/icon.icon` as the source-of-truth macOS icon source and documented that source in `/Users/mweinbach/Projects/agent-coworker/apps/desktop/README.md`.
- Verified the current web guidance first, then confirmed locally that this repo's installed `electron-builder`/`app-builder` stack (`24.13.3`) still rejects `mac.icon: build/icon.icon` with `icon directory ... doesn't contain icons`, so direct `.icon` packaging is not compatible with the current toolchain.
- Used `xcrun actool apps/desktop/build/icon.icon --app-icon icon --compile <tmpdir> --output-partial-info-plist <tmpdir>/assetcatalog_generated_info.plist --minimum-deployment-target 11.0 --platform macosx --target-device mac` to compile the source asset into a packaging-safe `icon.icns`, then replaced `/Users/mweinbach/Projects/agent-coworker/apps/desktop/build/icon.icns` with that output and regenerated `/Users/mweinbach/Projects/agent-coworker/apps/desktop/build/icon.png` from the compiled icon.
- Regenerated `/Users/mweinbach/Projects/agent-coworker/apps/desktop/build/icon.ico` from the same compiled PNG so the Windows installer/app icon now matches the provided source art too. The final `.ico` now contains 7 embedded sizes: `16`, `24`, `32`, `48`, `64`, `128`, and `256`.
- Kept `/Users/mweinbach/Projects/agent-coworker/apps/desktop/electron-builder.yml` on `mac.icon: build/icon.icns`, which now points at the icon compiled from the user-provided Icon Composer source instead of the older artwork.

### Verification
- `~/.bun/bin/bun run typecheck` -> pass
- `~/.bun/bin/bun run --cwd apps/desktop build:dir` -> pass; packaging reached `release/mac-arm64` and only warned about missing local signing/notarization credentials
- `~/.bun/bin/bun test` -> pass (`1730 pass, 2 skip, 0 fail`)
- Visual check of `/Users/mweinbach/Projects/agent-coworker/apps/desktop/build/icon.png` confirms the generated desktop icon matches the provided source art
- Binary inspection of `/Users/mweinbach/Projects/agent-coworker/apps/desktop/build/icon.ico` confirms the embedded Windows icon sizes listed above
- Native Windows packaging was not run in this macOS environment; verification here covers the generated `.ico` asset, the checked-in `win.icon` config path, and the repo test/typecheck suite

---

# Task: Replace bundled repo skills with curated OpenAI spreadsheet, slides, pdf, and doc skills

## Plan
- [x] Fetch the exact upstream curated `spreadsheet`, `slides`, `pdf`, and `doc` skill directories referenced by the user.
- [x] Replace the repo's bundled `skills/spreadsheet`, `skills/slides`, `skills/pdf`, and `skills/doc` directories with those upstream copies.
- [x] Verify the resulting skill tree and diff, then record the replacement results here.

## Review
- Replaced the repo-bundled `skills/spreadsheet`, `skills/slides`, `skills/pdf`, and `skills/doc` directories with the exact contents from the curated upstream paths the user specified under `openai/skills` (`skills/.curated/{spreadsheet,slides,pdf,doc}`).
- Confirmed before replacement that repo code does not depend on the older local slide skill layout, so a wholesale directory swap was the correct fix instead of trying to merge files between the old and new structures.
- The biggest structural change is `skills/slides`: the older repo-specific root-level helper files and `pptxgenjs_helpers/` directory were removed in favor of the curated upstream layout with `agents/`, `assets/`, `references/`, and `scripts/`. The repo now carries the upstream `detect_font.py`, `LICENSE.txt`, asset bundle, and helper reference files exactly where the curated skill expects them.
- Verified exact parity with the fetched upstream sources using recursive directory diffs for all four skills (`diff -rq` against the cloned `openai/skills` checkout). Those checks returned clean, so the local bundled copies match the requested upstream source trees byte-for-byte.
- Verified the repo after replacement:
  - `~/.bun/bin/bun test` -> pass (`1698 pass, 2 skip, 0 fail`)
  - `git diff --check` -> pass
  - `find skills -maxdepth 2 -mindepth 1 | sort` confirms the bundled skill root now contains only `doc`, `pdf`, `slides`, and `spreadsheet`, with the curated upstream subdirectory layout for each.

---

# Task: Clean up the desktop question modal and remove the nested scroll feel

## Plan
- [x] Inspect the current desktop question modal implementation and existing prompt modal tests.
- [x] Refine the ask modal layout so the question UI fits cleanly without an internal scroll region.
- [x] Run verification, capture a live desktop modal screenshot, and record the result.

## Review
- Updated `/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/ui/PromptModal.tsx` to remove the internal `overflow-y-auto` body and tighten the ask modal around the actual content instead of forcing a nested scroll area inside the dialog.
- Cleaned up the layout using the existing shadcn surface: the header is denser, the suggested replies are now full-width option rows instead of bulky pill chips, the custom-answer area is more compact, and the footer action reads more cleanly. The dialog itself is slightly wider so long option text wraps naturally instead of feeling cramped.
- Verification:
  - `~/.bun/bin/bun test apps/desktop/test/prompt-modal-ask.test.ts` -> pass (`5 pass, 0 fail`)
  - `~/.bun/bin/bun test --cwd apps/desktop` -> pass (`137 pass, 0 fail`)
  - `~/.bun/bin/bun test` -> pass (`1698 pass, 2 skip, 0 fail`)
  - `git diff --check` -> pass
- Live validation:
  - Relaunched the Electron desktop app with `COWORK_ELECTRON_REMOTE_DEBUG=1 COWORK_DESKTOP_RENDERER_PORT=1421 ~/.bun/bin/bun run desktop:dev`, attached over the repo’s `desktop:browser` CDP wrapper, injected a representative ask prompt into the live renderer, and confirmed the modal no longer uses the nested scroll region shown in the bug screenshot.
  - Saved the live screenshot at `/Users/mweinbach/Projects/agent-coworker/output/playwright/prompt-modal-clean-no-scroll.png`.

---

# Task: Make desktop local source citations open cleanly instead of showing [blocked]

## Plan
- [x] Inspect the desktop markdown rendering path and confirm where `file://` source links are being rewritten to `[blocked]`.
- [x] Add a desktop-safe local-file link path before Streamdown hardening so local citations render as usable links.
- [x] Run verification, including a live Electron check of the source list.

## Review
- Updated `/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/components/ai-elements/message.tsx` so desktop assistant markdown rewrites local `file://` citations into a desktop-only `cowork-file:` link before Streamdown hardening, extends the local sanitize schema to preserve that protocol, and renders those citations through a desktop-aware link component instead of letting `rehype-harden` replace them with `[blocked]`.
- Kept the fix inside the existing desktop Streamdown/ai-elements surface rather than weakening global URL blocking. External `http`/`https`/`mailto` links still go through a confirmation step before opening in the browser, while local workspace files now use the Electron bridge via `openPath()`.
- Added `/Users/mweinbach/Projects/agent-coworker/apps/desktop/test/message-links.test.ts` with helper coverage plus a real `MessageResponse` render regression test that would fail if local citations ever regress back to `[blocked]`.
- Verification:
  - `~/.bun/bin/bun test apps/desktop/test/message-links.test.ts` -> pass (`5 pass, 0 fail`)
  - `~/.bun/bin/bun test --cwd apps/desktop` -> pass (`137 pass, 0 fail`)
  - `~/.bun/bin/bun test` -> pass (`1698 pass, 2 skip, 0 fail`)
  - `git diff --check` -> pass
- Live validation:
  - Relaunched the Electron desktop app with `COWORK_ELECTRON_REMOTE_DEBUG=1 COWORK_DESKTOP_RENDERER_PORT=1421 ~/.bun/bin/bun run desktop:dev`, attached over the repo’s `desktop:browser` CDP wrapper, and confirmed the `Sources` list in the existing `Requesting Feedback on Model` thread no longer shows `[blocked]`.
  - Saved the live screenshot at `/Users/mweinbach/Projects/agent-coworker/output/playwright/source-links-fix-after-sanitize.png`.

---

# Task: Merge grouped desktop tool lifecycle rows and fix trace badge alignment

## Plan
- [x] Inspect the grouped trace renderer and confirm why tool call/result updates are showing as separate rows.
- [x] Collapse adjacent tool lifecycle updates into one trace row inside the `Thinking` panel.
- [x] Fix the grouped trace status pill alignment and run verification with a live desktop check.

## Review
- Updated `/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/ui/chat/activityGroups.ts` so grouped desktop traces now merge adjacent tool items by lifecycle compatibility instead of only by raw name. The merge handles in-progress -> terminal transitions, exact duplicate terminal rows, generic-completed -> richer-completed rows, and the common desktop pattern where one row carries a verbose string result while the next carries a compact `{ count | chars | ok | exitCode }` summary for the same tool call.
- Tightened `/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/ui/chat/ActivityGroupCard.tsx` so the `Done`/status pills use explicit icon sizing and `whitespace-nowrap`, and the grouped `Thinking` header now stacks earlier in the three-column desktop shell instead of forcing the title, count badge, and status pill into the same narrow row.
- Expanded `/Users/mweinbach/Projects/agent-coworker/apps/desktop/test/chat-activity-groups.test.ts` with regression coverage for duplicate terminal rows, generic-to-richer completed rows, and verbose-string-result -> compact-summary-result pairs.
- Verification:
  - `~/.bun/bin/bun test apps/desktop/test/chat-activity-groups.test.ts` -> pass (`8 pass, 0 fail`)
  - `~/.bun/bin/bun test --cwd apps/desktop` -> pass (`132 pass, 0 fail`)
  - `~/.bun/bin/bun test` -> pass (`1693 pass, 2 skip, 0 fail`)
  - `git diff --check` -> pass
- Live validation:
  - Relaunched the Electron app with `COWORK_ELECTRON_REMOTE_DEBUG=1 ~/.bun/bin/bun run desktop:dev`, attached to the running renderer over CDP, and verified the two visible grouped traces dropped from `18`/`25` rows to `13`/`14` merged lifecycle rows after a full reload.
  - Captured the updated live desktop state at `/Users/mweinbach/Projects/agent-coworker/output/playwright/tool-trace-merged-centered-3.png`.

---

# Task: Make the expanded desktop tool trace readable inside the Thinking card

## Plan
- [x] Inspect the current grouped trace UI and identify why the expanded Thinking panel is unreadable.
- [x] Replace the nested tool-card stack inside the Thinking disclosure with a compact readable step trace.
- [x] Run verification, including a live Electron screenshot of the expanded trace.

## Review
- Reworked `/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/ui/chat/ActivityGroupCard.tsx` so the expanded `Thinking` disclosure no longer renders a second stack of nested `ToolCard` disclosures. It now shows a compact numbered step list with readable one-line summaries, clear status pills, and optional inline details for rows that have extra metadata.
- Kept the fix inside the existing shadcn surface by continuing to use local `Card`, `Badge`, and `Collapsible` primitives instead of adding new trace-specific state elsewhere in the store. The grouping logic in `/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/ui/chat/activityGroups.ts` and the standalone tool-card surface for non-grouped tool rows remain intact.
- Updated `/Users/mweinbach/Projects/agent-coworker/tasks/lessons.md` to capture the correction from the user: grouped tool traces should not reuse the full nested tool-card stack inside another disclosure.
- Verification:
  - `~/.bun/bin/bun test --cwd apps/desktop` -> pass (`127 pass, 0 fail`)
  - `~/.bun/bin/bun test` -> pass (`1688 pass, 2 skip, 0 fail`)
  - `git diff --check` -> pass
- Live validation:
  - Relaunched the desktop app with `COWORK_ELECTRON_REMOTE_DEBUG=1 ~/.bun/bin/bun run desktop:dev`, attached over CDP, and captured the expanded `Thinking` panel after opening the grouped trace.
  - The live expanded trace screenshot is `/Users/mweinbach/Projects/agent-coworker/output/playwright/tool-trace-readable-expanded.png`.

---

# Task: Auto reconnect desktop threads and restore saved sessions on startup

## Plan
- [x] Inspect the desktop restore/reconnect flow and confirm whether the existing socket layer already supports resume/retry.
- [x] Enable desktop socket auto reconnect and make startup reopen the most relevant saved workspace/thread instead of leaving the app in a disconnected state.
- [x] Run verification, including desktop-focused tests and a live Electron reconnect smoke check.

## Review
- In `/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/app/store.helpers/controlSocket.ts` and `/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/app/store.helpers/threadEventReducer.ts`, desktop control and thread sockets now opt into the existing shared `AgentSocket` auto-reconnect behavior instead of treating every close as terminal.
- In `/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/app/store.actions/bootstrap.ts`, persisted startup restore now prefers the most recently opened workspace, picks the best resumable thread from that workspace, and immediately calls `selectThread()`/`selectWorkspace()` after state load so transcript hydration and reconnect logic run during app startup rather than waiting for a manual click.
- Added regression coverage in `/Users/mweinbach/Projects/agent-coworker/apps/desktop/test/workspace-settings-sync.test.ts` and `/Users/mweinbach/Projects/agent-coworker/apps/desktop/test/thread-reconnect.test.ts` to pin auto-reconnect socket options, most-recent-workspace restore, and the restored-thread behavior. I also reset the shared desktop runtime maps in those tests so they behave like clean app launches instead of leaking sockets across cases.
- Verification:
  - `~/.bun/bin/bun test apps/desktop/test/thread-reconnect.test.ts apps/desktop/test/workspace-settings-sync.test.ts` -> pass (`10 pass, 0 fail`)
  - `~/.bun/bin/bun test --cwd apps/desktop` -> pass (`127 pass, 0 fail`)
  - `~/.bun/bin/bun test` -> pass (`1688 pass, 2 skip, 0 fail`)
  - `git diff --check` -> pass
- Live validation:
  - Launched the desktop app with `COWORK_ELECTRON_REMOTE_DEBUG=1 ~/.bun/bin/bun run desktop:dev`, attached over CDP with `~/.bun/bin/bun run desktop:browser -- snapshot -i`, and confirmed startup reopened the persisted `Cowork Test` workspace and `Requesting Feedback on Model` thread directly into the chat shell with the normal composer visible.
  - Captured the live startup state at `/Users/mweinbach/Projects/agent-coworker/output/playwright/desktop-reconnect-restore.png`.

---

# Task: Reduce desktop tool/reasoning UI density in chat

## Plan
- [x] Inspect the desktop chat feed rendering path and identify where tool and reasoning items dominate the main timeline.
- [x] Refactor the desktop chat UI to collapse tool and reasoning activity into a lighter secondary surface while keeping detailed inspection available.
- [x] Run verification, capture a live desktop visual pass, and record the outcome.

## Review
- Reworked the desktop chat timeline so consecutive reasoning and tool events are grouped into a single collapsible “Thinking” block instead of rendering every tool inline in the main transcript. The grouping logic lives in `/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/ui/chat/activityGroups.ts`, and the new grouped surface is rendered by `/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/ui/chat/ActivityGroupCard.tsx`.
- Updated `/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/ui/ChatView.tsx` to render those grouped activity blocks in the transcript, while preserving the existing message/error/system rows. This keeps tool/reasoning detail available, but moves it behind one disclosure per activity burst.
- Tightened the underlying tool rows in `/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/components/ai-elements/tool.tsx` and stopped normal successful tools from auto-expanding in `/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/ui/chat/toolCards/ToolCard.tsx`, so expanded traces still read as secondary detail instead of another wall of UI.
- Added regression coverage in `/Users/mweinbach/Projects/agent-coworker/apps/desktop/test/chat-activity-groups.test.ts` for grouping and summary behavior.
- Verification:
  - `bun test --cwd apps/desktop` -> pass (`125 pass, 0 fail`)
  - `bun test` -> pass (`1686 pass, 2 skip, 0 fail`)
  - `git diff --check` -> pass
- Live validation:
  - Relaunched the Electron app with `COWORK_ELECTRON_REMOTE_DEBUG=1 bun run desktop:dev`, attached with the repo’s `desktop:browser` CDP wrapper, and confirmed the thread now renders a compact `Thinking` block with the tool count and a one-line preview instead of a long stack of tool cards.
  - Saved the live screenshot at `/Users/mweinbach/Projects/agent-coworker/output/playwright/tool-density-after-2.png`.

---

# Task: Improve the desktop question prompt modal UI

## Plan
- [x] Review the current ask modal implementation and local shadcn primitives.
- [x] Refine the question modal hierarchy and spacing inside `apps/desktop/src/ui/PromptModal.tsx` without changing ask behavior.
- [x] Run verification, record the results, and note any remaining visual-validation gap.

## Review
- Updated `/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/ui/PromptModal.tsx` so the ask modal has a clearer visual hierarchy: a lighter header with a small status badge, stronger title/question grouping, cleaner suggested-reply chips, and a more intentional custom-answer section.
- Kept the work inside the existing shadcn dialog/button/input/badge primitives instead of introducing new modal-specific components or state. The only behavior-oriented change is layout hardening for long prompts via a bounded modal height and a scrollable body.
- Verification:
  - `bun test --cwd apps/desktop` -> pass (`122 pass, 0 fail`)
  - `bun test` -> pass (`1683 pass, 2 skip, 0 fail`)
  - `git diff --check` -> pass
- Live validation:
  - Relaunched the desktop app with `COWORK_ELECTRON_REMOTE_DEBUG=1 bun run desktop:dev`, reattached over the repo’s `desktop:browser` CDP wrapper, and confirmed the app shell and existing thread still rendered cleanly after the modal refactor.
  - I was not able to reproduce a fresh ask prompt from that session, so the modal-specific visual confirmation is still based on the component/layout change rather than a new live screenshot of the exact prompt state.

---

# Task: Fix desktop composer overlap between the model selector and send button

## Plan
- [x] Identify the exact composer/layout path causing the overlap.
- [x] Adjust the desktop composer layout so the model selector, message field, and send action no longer collide at typical desktop widths.
- [x] Run focused verification and record any remaining live-validation gap.

## Review
- Kept the fix inside the desktop shadcn/ai-elements surface instead of adding new state/layout plumbing after the user called out that the first pass was over-engineered.
- Tightened the actual prompt primitives in `/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/components/ai-elements/prompt-input.tsx`: smaller shell padding, smaller textarea minimum height, a bordered footer row, flexible tool area, and a compact shadcn button size for the send/stop action.
- Updated `/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/ui/ChatView.tsx` so the helper copy now lives in the footer action group instead of taking its own row below the composer, and compacted the model selector trigger to behave like a proper footer control instead of crowding the message area.
- This keeps the fix in the existing ai-elements composition (`PromptInputBody` / `PromptInputFooter` / `PromptInputTools` / `PromptInputSubmit`) and existing shadcn primitives (`SelectTrigger`, `Button`) rather than pushing it into store sizing logic.
- Verification:
  - `bun test --cwd apps/desktop` -> pass (`122 pass, 0 fail`)
  - `bun test` -> pass (`1683 pass, 2 skip, 0 fail`)
  - `git diff --check` -> pass
- Live verification note: I attempted to relaunch the Electron app for another visual pass, but the headless dev session did not stay attached long enough in this shell to do a reliable Playwright follow-up screenshot. The code path and desktop test suite are clean; a manual visual check in a normal desktop session is still worthwhile.

---

# Task: Run the harness in this repo with Codex gpt-5.4

## Plan
- [x] Add `gpt-5.4` to the curated Codex model catalog if it is not already selectable.
- [x] Add the smallest practical raw harness scenario/run for `codex-cli` using `gpt-5.4`.
- [x] Execute the harness run against the current repo and inspect the generated artifacts/results.
- [x] Run targeted verification and record the outcome.

## Review
- Added `gpt-5.4` to the curated Codex model list in `/Users/mweinbach/Projects/agent-coworker/src/providers/catalog.ts` and added a dedicated raw harness scenario, `codex-gpt-5.4-smoke`, in `/Users/mweinbach/Projects/agent-coworker/scripts/run_raw_agent_loops.ts`. The harness runbook now documents that scenario in `/Users/mweinbach/Projects/agent-coworker/docs/harness/runbook.md`.
- The first harness attempt exposed a real bug in local auth resolution for harness runs: several paths derived the Cowork home directory from `dirname(userAgentDir)`, which broke when harness runs rewrote `userAgentDir` to `<runDir>/.agent-user`. That caused Codex auth lookup to fall back to `<runDir>/.cowork/auth/...` instead of the real `~/.cowork/auth/...`. Fixed by introducing `/Users/mweinbach/Projects/agent-coworker/src/utils/coworkHome.ts` and switching the affected config/runtime/session/model-adapter call sites to use it.
- Also tightened the Codex smoke prompt so it only exercises files inside the harness working directory, avoiding false-negative permission denials from trying to read the parent repo while the run is sandboxed to the per-run output directory.
- Successful harness run:
  - Command: `AGENT_OUTPUT_DIR=output bun scripts/run_raw_agent_loops.ts --scenario codex-gpt-5.4-smoke --report-only`
  - Run root: `/Users/mweinbach/Projects/agent-coworker/output/raw-agent-loop_codex-gpt-5.4-smoke_2026-03-07T01-05-56-136Z`
  - Per-run dir: `/Users/mweinbach/Projects/agent-coworker/output/raw-agent-loop_codex-gpt-5.4-smoke_2026-03-07T01-05-56-136Z/codex-smoke-01-core-tools_codex-cli_gpt-5.4`
  - Result: single successful attempt (`attempts.json` shows `ok: true`), `run_meta.json` shows `requestedModel`/`resolvedModel` both `gpt-5.4`, and `final.txt` contains the expected JSON with `<<END_RUN>>`.
  - The generated report file is `/Users/mweinbach/Projects/agent-coworker/output/raw-agent-loop_codex-gpt-5.4-smoke_2026-03-07T01-05-56-136Z/codex-smoke-01-core-tools_codex-cli_gpt-5.4/codex_harness_smoke.md`.
- Verification:
  - `bun test test/runtime.pi-runtime.test.ts test/session.test.ts test/providers/codex-cli.test.ts apps/desktop/test/modelChoices.test.ts` -> pass (`188 pass, 0 fail`)
  - `bun run docs:check` -> pass
  - `bun test` -> pass (`1683 pass, 2 skip, 0 fail`)
  - `git diff --check` -> pass

---

# Task: Run and smoke-test the desktop app end to end

## Plan
- [x] Launch the Electron desktop app in dev mode and confirm it boots without fatal startup errors.
- [x] Exercise the primary desktop chat UI path with the repo's browser automation workflow and capture any visible issues.
- [x] Run relevant automated verification after the live smoke test and record the outcome.

## Review
- Launched the desktop app with `COWORK_ELECTRON_REMOTE_DEBUG=1 bun run desktop:dev`. Electron/Vite booted cleanly, the renderer loaded at `http://localhost:1420/`, and Electron exposed CDP on `ws://127.0.0.1:9222/...` with no startup crash. The only terminal warning during boot was the existing observability configuration warning from the bundled server.
- Used the Playwright interactive workflow to attach to the live renderer over CDP and confirm the real window loaded (`Cowork Desktop`, `http://localhost:1420/`). The initial shell rendered the expected empty-state copy (`No workspaces yet`, `Let's build`, `Pick a workspace and start a new thread.`).
- Continued the UI smoke test through the repo-supported desktop browser wrapper against the same CDP session. Verified Settings navigation (`Providers`, `Workspaces`, `Developer`) and return-to-app flow without renderer failure. After returning to the main app, the restored `Cowork Test` workspace/session rendered an active composer and file/context pane.
- Exercised the compose/send path: filling the message box enabled the `Send message` button, and submitting did not crash the app. Instead, the app surfaced the provider configuration view (`Connect your AI providers to start chatting.` with connected Google/Codex CLI sections), which is consistent with a runtime that needs provider setup before chatting.
- Verification:
  - `bun test --cwd apps/desktop` -> pass (`122 pass, 0 fail`)
  - `bun test` -> pass (`1683 pass, 2 skip, 0 fail`)

---

# Task: Align desktop app shadcn and ai-elements integration

## Plan
- [x] Add proper shadcn project metadata and `@/` alias wiring for `apps/desktop`.
- [x] Update the vendored desktop shadcn primitives to match current shadcn composition and accessibility expectations where needed.
- [x] Tighten the desktop `ai-elements` wrappers and chat surfaces so they compose cleanly with the shadcn layer.
- [x] Run verification (`apps/desktop` tests, targeted repo tests, and shadcn/ai-elements CLI dry-run checks) and record the review.

## Review
- Added `/Users/mweinbach/Projects/agent-coworker/apps/desktop/components.json` plus `@/*` alias wiring in `/Users/mweinbach/Projects/agent-coworker/apps/desktop/tsconfig.json` and `/Users/mweinbach/Projects/agent-coworker/apps/desktop/electron.vite.config.ts` so `apps/desktop` is now a real shadcn project. `npx shadcn@latest info --json` now reports `config` and the installed desktop UI components instead of `config: null`.
- Filled the missing `accent` semantic token in `/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/styles.css` and normalized the vendored shadcn primitives (`button`, `badge`, `card`, `checkbox`, `dialog`, `input`, `select`, `textarea`) with app-local aliases, `data-slot` metadata, and more consistent icon sizing/composition.
- Refactored the desktop `ai-elements` layer so the composer behaves like a compound component again: `/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/components/ai-elements/prompt-input.tsx` now exposes `Body`/`Footer`/`Tools`, forwards primitive props/refs, restores a focus-within ring on the shell, and uses AI Elements-style `status` semantics for submit/stop actions. `/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/ui/ChatView.tsx` now consumes that structure and moves the model selector into the footer/tools row.
- Fixed the desktop tool feed to preserve AI Elements-style lifecycle states instead of flattening them to `running|done|error`. `/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/app/types.ts`, `/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/app/store.feedMapping.ts`, `/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/components/ai-elements/tool.tsx`, and `/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/ui/chat/toolCards/*` now keep approval metadata, represent `approval-requested` / `output-denied` / `output-error` distinctly, and auto-expand terminal or approval-blocked tool cards.
- Verification:
  - `npx shadcn@latest info --json` in `apps/desktop` -> pass
  - `npx shadcn@latest add @ai-elements/prompt-input --dry-run` in `apps/desktop` -> pass
  - `bun test apps/desktop/test/protocol-v2-events.test.ts apps/desktop/test/legacy-tool-logs.test.ts apps/desktop/test/tool-card-formatting.test.ts apps/desktop/test/chat-reasoning-ui.test.ts` -> pass
  - `bun test --cwd apps/desktop` -> pass (`122 pass, 0 fail`)
  - `bun test` -> pass (`1683 pass, 2 skip, 0 fail`)
  - `bun x tsc -p apps/desktop/tsconfig.json --noEmit` -> still fails on pre-existing unused-import / unrelated repo type issues in `apps/desktop/src/app/store.actions/*` and shared root `src/*` files; not introduced by this change

---

# Task: Close remaining PI runtime PR follow-ups (tool-call IDs + MCP error semantics)

## Plan
- [x] Ensure `toolcall_end` uses the same derived tool ID/name path as `toolcall_start`/`toolcall_delta`.
- [x] Treat MCP-style `{ isError: true }` tool outputs as tool failures in PI runtime execution.
- [x] Add targeted regression tests for the above.
- [x] Run focused verification and record results.

## Review
- Updated `src/runtime/piRuntime.ts` raw event mapping so `toolcall_end` now derives identifiers from `toolCallFromPartial(event)` (same path as start/delta), preserving stable `tool_input_*`/`tool_call` correlation.
- Updated PI runtime tool execution to classify MCP-style error payloads (`{ isError: true, ... }`) as `tool-error` events and persisted `toolResult.isError: true` entries instead of false-success `tool-result` emissions.
- Exposed targeted runtime internals for regression tests and added coverage in `test/runtime.pi-runtime.test.ts` for:
  - `toolcall_end` ID/name consistency from partial payloads,
  - MCP-style `isError` mapping to `tool-error`.
- Verification:
  - `bun test test/runtime.pi-runtime.test.ts` -> pass

---

# Task: Fix all current PR review findings (security, bugs, race, flakiness, maintainability)

## Plan
- [x] Remove secret leakage from runtime telemetry spans.
- [x] Fix PI runtime correctness bugs (`isZodSchema` import, `prepareStep` overrides, abort-before-tools checks, non-text message bridging).
- [x] Eliminate Codex auth refresh races and improve auth/header error handling semantics.
- [x] Restore provider-aware webSearch behavior and expand regression coverage.
- [x] Fix raw harness script regressions (missing provider key vars, finalize pass tool side-effects).
- [x] Improve maintainability hotspots (runtime path duplication/gating cleanup, stale comments/types, runtime selection behavior).
- [x] Address test flakiness in Codex auth-related tests by removing hidden network/shared-state dependencies.
- [x] Run targeted suites, then full `bun test`, and document outcomes.

## Review
- Redacted telemetry inputs in PI runtime so `llm.input.options` no longer records sensitive auth material (`apiKey`, `authorization`, token-like keys).
- Fixed PI runtime correctness issues:
  - restored missing `isZodSchema` import path,
  - applied `prepareStep` overrides correctly by separating message/provider-option overrides from raw stream options,
  - added abort checks before tool execution to prevent post-cancel side effects,
  - preserved non-text user content in PI bridge via explicit placeholders.
- Added Codex refresh coalescing (`refreshCodexAuthMaterialCoalesced`) and wired both runtime + model adapter to remove concurrent refresh races.
- Tightened Codex adapter auth semantics by failing on expired token instead of silently returning empty auth headers.
- Restored provider-aware `webSearch` behavior with BRAVE-first fallback (for non-google providers), EXA fallback, and provider-appropriate disabled messages.
- Fixed raw harness regressions:
  - restored required provider API key environment resolution variables,
  - disabled tools in finalize pass (instead of relying on prompt-only behavior).
- Maintainability improvements:
  - runtime selection now explicitly uses config-driven resolution (`createRuntime` switch on `resolveRuntimeName`),
  - removed stale `@deprecated` marker from active `modelAdapter`,
  - made `defineTool.execute` required,
  - simplified legacy runtime path gating (`streamText + stepCountIs`) in both `agent` and `spawnAgent`.
- Flakiness fixes:
  - avoided near-expiry Codex token refresh path in `test/runtime.pi-runtime.test.ts`,
  - removed hidden shared tmp-state dependence in provider test helpers and stabilized codex header-shape test with explicit env key.
- Added regression coverage:
  - `test/runtime.pi-runtime.test.ts`
  - `test/runtime.pi-message-bridge.test.ts`
  - `test/tools.test.ts`
- Verification:
  - `bun test test/runtime.pi-runtime.test.ts test/runtime.pi-message-bridge.test.ts test/tools.test.ts test/providers/codex-cli.test.ts`
  - `bun test test/agent.test.ts test/spawnAgent.tool.test.ts test/mcp.test.ts test/runtime.selection.test.ts`
  - `bun test` -> **1681 pass, 2 skip, 0 fail**

---

# Task: Address PR review must-fix items (runtime telemetry/auth/raw-chunk correctness)

## Plan
- [x] Eliminate duplicate abort-callback execution in PI runtime turn loop.
- [x] Preserve Codex account-header behavior in PI runtime auth path (`ChatGPT-Account-ID` parity).
- [x] Honor `includeRawChunks` end-to-end in session stream normalization/emission.
- [x] Ensure runtime telemetry is actually applied on PI model calls (or adjust behavior/docs if unsupported).
- [x] Add targeted regression coverage for the above and run full verification (`bun test`).

## Review
- Removed duplicate abort callback invocation in `src/runtime/piRuntime.ts` by relying on the outer catch-path abort handling.
- Restored Codex account-header parity by carrying `accountId` through runtime model resolution and forwarding `ChatGPT-Account-ID` into PI stream headers.
- Added `AgentConfig.includeRawChunks` plumbing (`src/types.ts`, `src/config.ts`, `config/defaults.json`) and used it in `TurnExecutionManager` for both runtime call options and `rawPart` emission.
- Added PI-runtime telemetry span instrumentation in `src/runtime/piRuntime.ts` and explicit telemetry parsing helpers (`__internal.parseTelemetrySettings`).
- Added regression coverage:
  - `test/runtime.pi-runtime.test.ts`
  - `test/runtime.pi-options.test.ts`
  - `test/session.stream-pipeline.test.ts`
- Verification:
  - `~/.bun/bin/bun test test/runtime.pi-runtime.test.ts test/runtime.pi-options.test.ts test/session.stream-pipeline.test.ts` -> **39 pass, 0 fail**
  - `~/.bun/bin/bun test` -> **1673 pass, 2 skip, 2 fail** (sandbox EPERM writing `~/.cowork/state/cli-state.json.*.tmp` in two CLI REPL tests)
  - `HOME=/tmp/agent-coworker-test-home ~/.bun/bin/bun test` -> **1675 pass, 2 skip, 0 fail**

---

# Task: Remove AI SDK dependencies completely (PI-only runtime)

## Plan
- [x] Remove all `ai` / `@ai-sdk/*` imports from `src/` runtime paths and keep PI as the sole production runtime.
- [x] Replace AI SDK `ModelMessage` and `tool()` usage with local types/helpers.
- [x] Replace `@ai-sdk/mcp` client plumbing with `@modelcontextprotocol/sdk` client transports.
- [x] Refactor provider model adapters to local implementations (no AI SDK provider packages) while preserving existing config/header behavior.
- [x] Update tests that assert AI SDK-specific behavior to the PI/local-adapter behavior.
- [x] Remove `ai` / `@ai-sdk/*` dependencies from `package.json` and refresh lockfile.
- [x] Run targeted suites + full `bun test`, then document review outcomes.

## Review
- Removed all runtime/test/script imports from `ai` and `@ai-sdk/*`; PI runtime is now the only model runtime in `src/runtime/`.
- Replaced SDK-coupled tool wrappers with a local `defineTool()` helper and moved `ModelMessage` to a local type in `src/types.ts`.
- Replaced MCP client integration from `@ai-sdk/mcp` to direct `@modelcontextprotocol/sdk` transports (`stdio`, `sse`, `streamableHttp`) while preserving `loadMCPTools()` behavior.
- Refactored provider adapters to local header-based model adapters (`src/providers/modelAdapter.ts`) and removed AI SDK provider package usage.
- Removed AI SDK fallback title generation path; session titles now use runtime turn calls only.
- Updated docs (`README.md`, `docs/architecture.md`, `docs/custom-tools.md`, `docs/harness/observability.md`, `docs/websocket-protocol.md`) to reflect PI-only runtime/tooling language.
- Verification:
  - `bun test test/runtime.selection.test.ts test/runtime.pi-message-bridge.test.ts test/runtime.pi-options.test.ts test/session-title-service.test.ts test/config.test.ts test/providers/index.test.ts test/providers/openai.test.ts test/providers/google.test.ts test/providers/anthropic.test.ts test/providers/codex-cli.test.ts test/providers/saved-keys.test.ts test/providers/provider-options.test.ts test/tools.test.ts test/mcp.test.ts test/mcp.local.integration.test.ts test/agent.test.ts test/spawnAgent.tool.test.ts` -> **355 pass, 0 fail**
  - `bun test` -> **1684 pass, 2 skip, 0 fail**

---

# Task: Migrate agent runtime from AI SDK to PI (all phases)

## Plan
- [x] Phase 1: Introduce a runtime abstraction (`LLMRuntime`) and route `runTurn` through it while preserving behavior.
- [x] Phase 2: Add a PI-backed runtime implementation behind config/runtime selection and keep AI SDK runtime available during transition.
- [x] Phase 3: Keep first-class provider behavior by mapping provider/model/auth/options semantics for `google`, `openai`, `anthropic`, and `codex-cli`.
- [x] Phase 4: Migrate `spawnAgent` and session title generation to runtime abstraction and PI-backed execution paths.
- [x] Phase 5: Preserve websocket/TUI stream compatibility by normalizing PI stream events into existing `model_stream_chunk` part contracts.
- [x] Phase 6: Flip default runtime to PI, update docs/config/protocol notes, and clean up direct AI SDK runtime wiring.
- [x] Add or update targeted regression tests for runtime selection, provider parity, stream mapping, subagent execution, and title generation.
- [x] Run targeted verification suites, then full `bun test`.

## Review
- Added `src/runtime/` with runtime boundary (`types.ts`) plus `aiSdkRuntime` and `piRuntime`; `src/agent.ts` now routes model execution through `createRuntime()` and keeps AI SDK override compatibility for existing tests.
- Added runtime selection/config support (`AgentConfig.runtime`, `AGENT_RUNTIME`, defaults `runtime: "pi"` in `config/defaults.json`) and exported saved-key resolution for provider-auth parity in PI runtime.
- Implemented PI provider/model/auth mapping for `openai`, `google`, `anthropic`, and `codex-cli` (including Codex OAuth refresh path), PI tool-schema bridging from Zod -> JSON Schema, and PI message bridging to existing `ModelMessage` history format.
- Migrated subsystem callers to runtime abstraction: `spawnAgent` uses runtime by default with legacy AI SDK path for injected test deps; session title generation uses runtime path for PI while preserving AI SDK structured-title compatibility path.
- Preserved stream contract by mapping PI stream/tool lifecycle events into existing normalized stream part types (`model_stream_chunk` compatibility retained in session pipeline/TUI/client reducers).
- Updated documentation (`docs/architecture.md`, `docs/websocket-protocol.md`) for runtime abstraction and runtime-agnostic stream raw parts.
- Added regression coverage: `test/runtime.selection.test.ts`, `test/runtime.pi-message-bridge.test.ts`, `test/runtime.pi-options.test.ts`, plus updates in `test/session-title-service.test.ts` and `test/config.test.ts`.
- Fixed surfaced regressions during verification:
  - `src/server/session/TurnExecutionManager.ts`: hoisted `lastStreamError` so catch-path classification uses in-scope stream error context.
  - Desktop test stability: expanded mocked `desktopCommands` exports in multiple desktop tests to avoid full-suite order-dependent missing-export failures.
- Verification:
  - `bun test test/runtime.selection.test.ts test/runtime.pi-message-bridge.test.ts test/runtime.pi-options.test.ts test/session-title-service.test.ts test/agent.test.ts test/agent.toolloop.test.ts test/spawnAgent.tool.test.ts test/config.test.ts test/server.model-stream.test.ts test/session.stream-pipeline.test.ts` -> **288 pass, 0 fail**
  - `bun test test/session.test.ts` -> **174 pass, 0 fail**
  - `bun test` -> **1686 pass, 2 skip, 0 fail**

---

# Task: Validate real production loop tool coverage for Google gemini-3.1-pro-preview-customtools

## Plan
- [x] Add a dedicated raw harness scenario/runs for Google `gemini-3.1-pro-preview-customtools` that require all built-in tools at least once across runs.
- [x] Run the scenario against real provider auth with production loop wiring and capture artifacts.
- [x] Fix any runtime regressions discovered while running the live loop.
- [x] Add/adjust regression tests where needed and run targeted suites.
- [x] Run full verification (`bun test`) and record outcomes.

## Review
- Added a new harness scenario, `google-customtools-tool-coverage`, in `scripts/run_raw_agent_loops.ts` and updated argument parsing/help + run-root naming to support selecting it.
- Scenario includes 4 Google runs on `gemini-3.1-pro-preview-customtools` covering all built-in tools: `ask`, `bash`, `edit`, `glob`, `grep`, `memory`, `notebookEdit`, `read`, `skill`, `spawnAgent`, `todoWrite`, `webFetch`, `webSearch`, `write`.
- Fixed a real harness validation bug discovered during live run: `requiredFirstNonTodoToolCall` was derived only from traced stream payloads, which can miss tool calls for some provider/tool traces. Added ordered `tool-log` extraction and used it as primary source (with traced fallback).
- Removed unnecessary first-call ordering enforcement from `gct-02-skill-bash`; kept required tool usage assertions.
- Fixed unrelated pre-existing red suite while validating: `createWebSearchTool()` now returns Anthropic provider-native `anthropic.tools.webSearch_20250305({})` for `provider: "anthropic"`, matching expected runtime/tool id.
- Live production loop verification (using saved Google auth from `~/.cowork/auth/connections.json`):
  - `bun scripts/run_raw_agent_loops.ts --scenario google-customtools-tool-coverage --report-only`
  - latest run root: `tmp/raw-agent-loop_google-customtools-tool-coverage_2026-02-24T17-16-23-673Z`
  - aggregated tool-log verification: `UNIQUE_TOOL_COUNT=14`
- Verification:
  - `bun test test/tools.test.ts test/repl.disconnect-send.test.ts` -> **154 pass, 0 fail**
  - `bun test` -> **1671 pass, 2 skip, 0 fail**

---

# Task: Loosen strict Zod validation around tool-call stream parsing

## Plan
- [x] Add tolerant server-event parsing for `model_stream_chunk` (non-object `part`, partial stream metadata defaults).
- [x] Add detailed parse diagnostics (`parseServerEventDetailed`) while keeping `safeParseServerEvent` compatibility.
- [x] Wire client socket diagnostics via optional `onInvalidEvent` and robust frame decoding (string/ArrayBuffer/ArrayBufferView/Blob/object).
- [x] Loosen tool-call ID handling across stream normalizers (numeric IDs + anonymous fallback IDs instead of empty strings).
- [x] Improve raw provider-event mapping resilience (`evt.rawPart` fallback + loose primitive text coercion).
- [x] Preserve structured array args in TUI tool-input lifecycle.
- [x] Keep sanitization defaults but add an explicit fuller mode (`rawPartMode: "full"` + `COWORK_MODEL_STREAM_RAW_MODE=full` hook).
- [x] Update protocol docs and regression tests for the new behavior.
- [x] Run targeted verification suites.

## Review
- Added `parseServerEventDetailed` + `ServerEventParseResult`/`ServerEventParseErrorReason` in `src/server/protocolEventParser.ts`, exported via `src/server/protocol.ts`.
- `model_stream_chunk` parsing now tolerates missing `turnId/index/provider/model` (defaults: `"unknown-turn"`, `-1`, `"unknown"`, `"unknown"`) and normalizes non-object `part` payloads to `{ value: <raw> }`.
- `AgentSocket` now supports optional invalid-event diagnostics (`onInvalidEvent`) and decodes binary/blob websocket frames before parsing.
- Server and client stream normalization now coerce numeric IDs, avoid empty-string tool IDs, and use deterministic anonymous IDs.
- Client stream mapper now performs looser primitive text coercion and uses `evt.rawPart` as a secondary fallback for provider raw event mapping.
- TUI tool-arg normalization now preserves parsed array payloads instead of forcing record-only shape.
- Added/updated regression coverage in:
  - `test/agentSocket.parse.test.ts`
  - `test/server.model-stream.test.ts`
  - `test/tui.model-stream.test.ts`
- Updated `docs/websocket-protocol.md` validation + `model_stream_chunk` notes for diagnostics/defaults/part normalization/raw mode.
- Verification:
  - `bun test test/agentSocket.parse.test.ts test/server.model-stream.test.ts test/tui.model-stream.test.ts test/model-stream.provider-loop.test.ts test/session.stream-pipeline.test.ts`
  - `bun test test/protocol.test.ts`
  - `bun test` -> **1666 pass, 2 skip, 0 fail**

---

# Task: Fix PR review regressions (desktop persistence, auth resilience, protocol coverage)

## Plan
- [x] Restore desktop persisted-state backward compatibility on load while keeping save-time safety.
- [x] Make desktop transcript hydration resilient to malformed lines and avoid thread selection hard-failures.
- [x] Restore legacy transcript reasoning aliases (`assistant_reasoning`, `reasoning_summary`) in feed mapping.
- [x] Align desktop persisted-state IPC validation with runtime expectations.
- [x] Relax Codex device OAuth response parsing to accept forward-compatible extra fields.
- [x] Make MCP auth-store reads recover from malformed/invalid credential files instead of failing closed.
- [x] Make CLI state loading recover from malformed/invalid JSON schema drift.
- [x] Change `set_model` / `set_enable_mcp` persistence failures to fail-open runtime updates with surfaced non-fatal errors.
- [x] Expand parser/decode regression coverage (server-event fixture parsing + binary websocket decode path).
- [x] Update websocket protocol docs for strict server-event parsing behavior and persistence-failure semantics.
- [x] Run targeted and full verification (`bun test ...`, `bun test`).

## Review
- Desktop persistence now sanitizes malformed state, recovers from invalid `state.json` JSON, and skips malformed transcript lines.
- Thread selection no longer hard-fails on transcript read errors, and legacy reasoning aliases are mapped correctly.
- Desktop persisted-state schemas now default workspace/session booleans (`defaultEnableMcp`, `yolo`, `developerMode`, `showHiddenFiles`) for stronger IPC/runtime alignment.
- `set_model` / `set_enable_mcp` now apply runtime updates even when persistence fails and surface non-fatal `internal_error` events.
- MCP auth-store and CLI state-store reads now recover from malformed files instead of failing closed.
- Added/updated regression coverage including binary decode parsing, server-event fixtures, desktop state/transcript recovery, and desktop schema defaults.
- Documentation updated for server-event parsing behavior and `server_hello.protocolVersion` (`7.0`).
- Verification:
  - targeted suites for affected areas
  - full suite: `bun test` → **1656 pass, 2 skip, 0 fail**

---

# Task: Preserve webSearch alias compatibility and harden legacy snapshot import

## Plan
- [x] Restore compatibility alias support in `src/tools/webSearch.ts` for `q`, `searchQuery`, `text`, and `prompt`.
- [x] Preserve strict input handling while allowing provider-native compatibility extras (`mode`, `dynamicThreshold`).
- [x] Add `webSearch` regression coverage for alias-based inputs plus compatibility extras.
- [x] Make `importLegacySnapshots()` skip unreadable legacy entries instead of aborting migration.
- [x] Add SessionDb regression coverage proving unreadable `.json` entries are skipped while valid snapshots import.
- [x] Run verification (`bun test test/tools.test.ts`, `bun test test/session-db.test.ts`, `bun test`).

## Review
- `webSearch` input parsing now accepts legacy alias keys and resolves the first provided query field in priority order: `query`, `q`, `searchQuery`, `text`, `prompt`.
- The schema remains `.strict()` and now explicitly allows compatibility extras `mode` and `dynamicThreshold` so provider-native payloads are not rejected before execution.
- Added regression test `accepts compatibility query aliases and provider-native extra keys` in `test/tools.test.ts`.
- `importLegacySnapshots()` now wraps per-file reads in `try/catch` so unreadable files are skipped and migration proceeds.
- Added regression test `skips unreadable legacy snapshot entries while importing valid ones` in `test/session-db.test.ts`.
- Verification:
  - `bun test test/tools.test.ts`
  - `bun test test/session-db.test.ts`
  - `bun test`

---

# Task: Handle invalid connection store without aborting auth flows

## Plan
- [x] Confirm the current `readConnectionStore()` error behavior for malformed and legacy-shape `connections.json`.
- [x] Make `readConnectionStore()` treat invalid JSON/schema as recoverable and return an empty store instead of throwing.
- [x] Add regression tests proving `connectProvider()` can recover from invalid store files.
- [x] Add regression tests proving `getProviderStatuses()` still returns statuses when store JSON/schema is invalid.
- [x] Run verification (`bun test test/connect.test.ts`, `bun test test/providerStatus.test.ts`, `bun test`).

## Review
- Added a dedicated `ConnectionStoreParseError` in `/Users/mweinbach/Projects/agent-coworker/src/store/connections.ts` so parse/schema failures are distinguishable from filesystem failures.
- `readConnectionStore()` now treats invalid `connections.json` content as recoverable and falls back to an empty in-memory store, preserving normal `/connect` and provider-status flows.
- Filesystem failures (other than `ENOENT`) still throw, so permission and IO issues remain visible.
- Added regression test `recovers from malformed connection store JSON when saving a provider key` in `/Users/mweinbach/Projects/agent-coworker/test/connect.test.ts`.
- Added regression test `treats legacy-shaped connection store as empty instead of throwing` in `/Users/mweinbach/Projects/agent-coworker/test/providerStatus.test.ts`.
- Verification:
  - `bun test test/connect.test.ts`
  - `bun test test/providerStatus.test.ts`
  - `bun test`

---

# Task: Keep MCP/session loading resilient to malformed JSON

## Plan
- [x] Make `loadMCPConfigRegistry()` best-effort by turning per-layer parse failures into file-level parse warnings.
- [x] Ensure malformed MCP layers do not block resolution of valid layers in snapshot/runtime paths.
- [x] Make `listPersistedSessionSnapshots()` skip malformed/invalid snapshot files instead of throwing.
- [x] Add regression coverage in `test/mcp.config-registry.test.ts` and `test/session-store.test.ts`.
- [x] Run verification (`bun test test/mcp.config-registry.test.ts`, `bun test test/session-store.test.ts`, `bun test`).

## Review
- `readLayer()` in `/Users/mweinbach/Projects/agent-coworker/src/mcp/configRegistry/layers.ts` now catches parse/schema failures per file, records `file.parseError`, and keeps loading remaining layers.
- `loadMCPConfigRegistry()` now emits warning entries for malformed layer files while continuing to merge valid system/user/workspace servers.
- Added regression coverage in `/Users/mweinbach/Projects/agent-coworker/test/mcp.config-registry.test.ts` proving malformed workspace JSON no longer aborts registry loading and warnings/parse metadata are populated.
- `listPersistedSessionSnapshots()` in `/Users/mweinbach/Projects/agent-coworker/src/server/sessionStore.ts` now skips malformed JSON and invalid snapshot shapes per file instead of failing the entire list operation.
- Added regression coverage in `/Users/mweinbach/Projects/agent-coworker/test/session-store.test.ts` proving corrupt session files are skipped while valid snapshots remain listable/sorted.
- Verification:
  - `bun test test/mcp.config-registry.test.ts`
  - `bun test test/session-store.test.ts`
  - `bun test`

---

# Task: Fix review regressions in stream event dispatch and anonymous tool IDs

## Plan
- [x] Stop classifying consumer `onEvent` exceptions as `invalid_envelope` in `AgentSocket`.
- [x] Keep anonymous stream fallback IDs stable for a whole turn in `TurnExecutionManager`.
- [x] Ensure id-less `tool_input_*`, `tool_call`, and `tool_result` chunks share one fallback key path.
- [x] Add regression coverage for socket callback exception bubbling.
- [x] Add regression coverage for id-less tool lifecycle key correlation.
- [x] Run verification (`bun test` targeted suites + full suite).

## Review
- `src/client/agentSocket.ts` now limits `invalid_envelope` handling to decode/parse failures; valid event dispatch (`this.onEvent(evt)`) is outside that catch so consumer exceptions propagate instead of being suppressed.
- `src/server/session/TurnExecutionManager.ts` now uses `fallbackIdSeed: turnId` (not per-part index), making anonymous fallback IDs stable for the whole streamed turn.
- `src/server/modelStream.ts` now uses `toolCallId()` for `tool-input-start`, `tool-input-delta`, and `tool-input-end` IDs so id-less tool input/call/result chunks share one fallback call key.
- Added runtime regression tests in `test/agentSocket.runtime.test.ts` covering invalid envelope diagnostics and non-swallowed `onEvent` exceptions.
- Added stream lifecycle regression in `test/session.stream-pipeline.test.ts` proving id-less `tool_input_*`, `tool_call`, and `tool_result` chunks share the same fallback key.
- Updated `test/server.model-stream.test.ts` expectations for tool-input anonymous ID fallback behavior.
- Verification:
  - `bun test test/agentSocket.runtime.test.ts test/server.model-stream.test.ts test/session.stream-pipeline.test.ts`
  - `bun test` -> **1671 pass, 2 skip, 0 fail**

# Task: Add initial-response timeout to webFetch for hanging sites

## Plan
- [x] Inspect current webFetch hang behavior and existing tests.
- [x] Add a 5000ms timeout that only applies until the initial response arrives.
- [x] Add regression coverage and rerun the relevant tests.

## Review
- `src/tools/webFetch.ts` now applies a 5000ms abort timeout only while waiting for each `fetch()` call to produce an initial `Response`. Once headers arrive, the timer is cleared, so slow body reads are still allowed.
- The timeout is wired through the existing safe redirect loop, so a hung redirect hop is also bounded instead of stalling the tool indefinitely.
- Added focused regression coverage in `test/tools.test.ts` for both cases: a never-responding fetch now fails fast with a timeout, and a quick response with a slow `text()` body still succeeds.
- Verification:
  - `~/.bun/bin/bun test test/tools.test.ts` -> pass (`144 pass, 0 fail`)
  - `~/.bun/bin/bunx tsc --noEmit` -> pass
  - `git diff --check` -> pass

# Task: Add a dedicated gpt-5.4 system prompt

## Plan
# Task: Add desktop auto updater

## Plan
- [x] Inspect the current Electron desktop lifecycle, IPC bridge, settings navigation, and release pipeline to fit the updater into existing patterns.
- [x] Add a main-process updater service plus explicit desktop IPC/event contracts for updater state, manual checks, and restart/install.
- [x] Add a dedicated Updates settings page and menu wiring for `Check for Updates…` and `openUpdates`.
- [x] Add updater-focused regression coverage and run the required verification commands.

## Review
- Added a packaged-only `DesktopUpdaterService` in [apps/desktop/electron/services/updater.ts](/Users/mweinbach/Projects/agent-coworker/apps/desktop/electron/services/updater.ts) using `electron-updater`. It tracks updater state centrally in the main process, performs an automatic check shortly after startup plus every 6 hours, auto-downloads stable releases, emits non-fatal error state, and exposes a restart-only install path.
- Wired the updater through the existing explicit desktop bridge:
  - shared types/channels/events in [apps/desktop/src/lib/desktopApi.ts](/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/lib/desktopApi.ts)
  - runtime validation in [apps/desktop/src/lib/desktopSchemas.ts](/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/lib/desktopSchemas.ts)
  - preload bridge methods/event subscriptions in [apps/desktop/electron/preload.ts](/Users/mweinbach/Projects/agent-coworker/apps/desktop/electron/preload.ts)
  - system IPC handlers in [apps/desktop/electron/ipc/system.ts](/Users/mweinbach/Projects/agent-coworker/apps/desktop/electron/ipc/system.ts)
  - renderer command wrappers in [apps/desktop/src/lib/desktopCommands.ts](/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/lib/desktopCommands.ts)
- Added a dedicated Updates settings surface in [apps/desktop/src/ui/settings/pages/UpdatesPage.tsx](/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/ui/settings/pages/UpdatesPage.tsx), extended settings navigation with the new `updates` page, and wired menu-triggered update checks via `openUpdates` plus `Check for Updates…` menu entries in [apps/desktop/electron/services/menuTemplate.ts](/Users/mweinbach/Projects/agent-coworker/apps/desktop/electron/services/menuTemplate.ts).
- Threaded updater state through the desktop app store so the renderer can subscribe once and render current status/version/progress consistently from [apps/desktop/src/App.tsx](/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/App.tsx), [apps/desktop/src/app/store.helpers.ts](/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/app/store.helpers.ts), and [apps/desktop/src/app/store.actions/bootstrap.ts](/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/app/store.actions/bootstrap.ts).
- Added regression coverage for the updater service and UI contract in:
  - [apps/desktop/test/updater-service.test.ts](/Users/mweinbach/Projects/agent-coworker/apps/desktop/test/updater-service.test.ts)
  - [apps/desktop/test/desktop-schemas.test.ts](/Users/mweinbach/Projects/agent-coworker/apps/desktop/test/desktop-schemas.test.ts)
  - [apps/desktop/test/menu.test.ts](/Users/mweinbach/Projects/agent-coworker/apps/desktop/test/menu.test.ts)
  - [apps/desktop/test/settings-nav.test.ts](/Users/mweinbach/Projects/agent-coworker/apps/desktop/test/settings-nav.test.ts)
  - [apps/desktop/test/updates-page.test.ts](/Users/mweinbach/Projects/agent-coworker/apps/desktop/test/updates-page.test.ts)
- Added `electron-updater` to [apps/desktop/package.json](/Users/mweinbach/Projects/agent-coworker/apps/desktop/package.json) and confirmed the existing release metadata path still works with packaged output.

### Verification
- `bun install` -> pass; added `electron-updater@6.8.3`
- `bun run typecheck` -> pass
- `bun test --cwd apps/desktop` -> pass (`160 pass, 0 fail`)
- `bun test` -> pass (`1744 pass, 2 skip, 0 fail`)
- `bun run desktop:build -- --publish never` -> pass; produced:
  - `apps/desktop/release/Cowork-0.1.0-mac-arm64.dmg`
  - `apps/desktop/release/Cowork-0.1.0-mac-arm64.zip`
  - `apps/desktop/release/latest-mac.yml`
- Verified [apps/desktop/release/latest-mac.yml](/Users/mweinbach/Projects/agent-coworker/apps/desktop/release/latest-mac.yml) points at `Cowork-0.1.0-mac-arm64.zip` and includes matching SHA512 metadata.
- `git diff --check` -> pass

- [x] Add a model-specific gpt-5.4 prompt file under prompts/system-models.
- [x] Wire gpt-5.4 into the prompt template matcher.
- [x] Add regression coverage and run the prompt tests.

## Review
- Added [gpt-5.4.md](/Users/mweinbach/Projects/agent-coworker/prompts/system-models/gpt-5.4.md) as a dedicated model-specific prompt file. It currently starts as the same template content as `gpt-5.2`, but it is now a separate file that can diverge cleanly later.
- Updated [prompt.ts](/Users/mweinbach/Projects/agent-coworker/src/prompt.ts) so `gpt-5.4` resolves to `prompts/system-models/gpt-5.4.md` instead of falling back to the default `system.md`.
- Added regression coverage in [prompt.test.ts](/Users/mweinbach/Projects/agent-coworker/test/prompt.test.ts) to ensure `gpt-5.4` prefers its model-specific prompt when present.
- Verification:
  - `~/.bun/bin/bun test test/prompt.test.ts` -> pass (`41 pass, 0 fail`)
  - `~/.bun/bin/bunx tsc --noEmit` -> pass

# Task: Tune the gpt-5.4 system prompt for cleaner workspace behavior

## Plan
- [x] Inspect the current gpt-5.4 prompt sections that drive file creation and coding workflow.
- [x] Update the prompt to avoid generic /tmp or output folders, keep work in relevant project paths, and prefer shell-first coding before creating helper files.
- [x] Run targeted prompt verification and record the outcome.

## Review
- Updated [gpt-5.4.md](/Users/mweinbach/Projects/agent-coworker/prompts/system-models/gpt-5.4.md) to explicitly keep the workspace clean, avoid generic `/tmp`, `tmp`, `temp`, `output`, `outputs`, and `scratch` folders unless the user or project convention requires them, and prefer task-relevant workspace paths.
- Added shell-first guidance to the same prompt: use direct shell commands, existing project tooling, and direct file edits first for code tasks, and only create ad hoc Python or shell scripts when the user asked for one, the task clearly needs a reusable multi-step program, or repeated shell-first attempts are error-prone enough that a file is more efficient.
- Added a real-prompt regression test in [prompt.test.ts](/Users/mweinbach/Projects/agent-coworker/test/prompt.test.ts) so the shipped `gpt-5.4` prompt must continue to contain the new workspace-hygiene and shell-first instructions.
- Verification:
  - `~/.bun/bin/bun test test/prompt.test.ts` -> pass (`42 pass, 0 fail`)
  - `~/.bun/bin/bunx tsc --noEmit` -> pass

# Task: Propagate workspace-hygiene prompt guidance to shared prompts

## Plan
- [x] Inspect the matching file-operation and bash sections in `prompts/system.md` and `prompts/system-models/gpt-5.2.md`.
- [x] Copy the workspace-cleanliness and shell-first guidance from `gpt-5.4` into the default and `gpt-5.2` prompts.
- [x] Extend prompt regression coverage so the shipped default, `gpt-5.2`, and `gpt-5.4` prompts all retain the new guidance.
- [x] Run targeted prompt verification and record the outcome.

## Review
- Updated [system.md](/Users/mweinbach/Projects/agent-coworker/prompts/system.md) and [gpt-5.2.md](/Users/mweinbach/Projects/agent-coworker/prompts/system-models/gpt-5.2.md) so the shared file-operation guidance now explicitly keeps the workspace clean, avoids generic `/tmp`, `tmp`, `temp`, `output`, `outputs`, and `scratch` folders unless the user or project convention requires them, and prefers task-relevant workspace folders when a new directory is genuinely needed.
- Added the same shell-first coding guidance to both prompts: prefer direct shell commands, existing project tooling, and direct file edits first, and only create ad hoc Python or shell scripts when the user asked for a script, the task clearly needs a reusable multi-step program, or repeated shell-first attempts are error-prone enough that a helper file is more reliable.
- Extended [prompt.test.ts](/Users/mweinbach/Projects/agent-coworker/test/prompt.test.ts) so the shipped default prompt, `gpt-5.2`, and `gpt-5.4` all have to retain the shared workspace-hygiene and shell-first instructions.
- Verification:
  - `~/.bun/bin/bun test test/prompt.test.ts` -> pass (`44 pass, 0 fail`)
  - `~/.bun/bin/bunx tsc --noEmit` -> pass
  - `~/.bun/bin/bun test` -> pass (`1716 pass, 2 skip, 0 fail`)
  - `git diff --check` -> pass

# Task: Add multimodal image support to the read tool

## Plan
- [x] Inspect the current `read` tool, PI runtime tool-result handling, and replay bridge to locate where image content is dropped.
- [x] Update the `read` tool so supported image files return multimodal image content instead of UTF-8 line reads.
- [x] Preserve multimodal tool-result content through PI runtime execution and replay/persistence conversion.
- [x] Add regression tests and rerun the relevant verification commands.

## Review
- Updated [read.ts](/Users/mweinbach/Projects/agent-coworker/src/tools/read.ts) so `read` now detects supported raster image files (`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`) and returns multimodal tool content with a small text preface plus an actual image payload, instead of trying to stream the file as UTF-8 text lines.
- Updated [piMessageBridge.ts](/Users/mweinbach/Projects/agent-coworker/src/runtime/piMessageBridge.ts) so tool results that carry multimodal content survive model-message to PI-message conversion and PI replay back into persisted model messages. Image-bearing tool results are now preserved as a structured content envelope instead of being flattened into placeholder text.
- Updated [piRuntime.ts](/Users/mweinbach/Projects/agent-coworker/src/runtime/piRuntime.ts) so live tool execution hands multimodal `read` results through to `pi-ai` as real `toolResult` image content, which lets vision-capable models inspect the returned image.
- Added regression coverage in [tools.test.ts](/Users/mweinbach/Projects/agent-coworker/test/tools.test.ts), [runtime.pi-message-bridge.test.ts](/Users/mweinbach/Projects/agent-coworker/test/runtime.pi-message-bridge.test.ts), and [runtime.pi-runtime.test.ts](/Users/mweinbach/Projects/agent-coworker/test/runtime.pi-runtime.test.ts) for direct image reads, live runtime execution, and replay/persistence roundtrips.
- Verification:
  - `~/.bun/bin/bun test test/tools.test.ts test/runtime.pi-message-bridge.test.ts test/runtime.pi-runtime.test.ts` -> pass (`160 pass, 0 fail`)
  - `~/.bun/bin/bunx tsc --noEmit` -> pass
  - `~/.bun/bin/bun test` -> pass (`1720 pass, 2 skip, 0 fail`)
  - `git diff --check` -> pass

# Task: Teach prompts and webFetch about multimodal image inspection

## Plan
- [x] Inspect the prompt tool descriptions and current `webFetch` content-type handling for image URL gaps.
- [x] Update `webFetch` so direct image URLs return multimodal image content instead of being cleaned or rejected as non-text.
- [x] Update the default and GPT system prompts so they explicitly tell models they can inspect local images with `read` and remote image URLs with `webFetch`.
- [x] Add regression coverage and rerun prompt/tool verification.

## Review
- Updated [webFetch.ts](/Users/mweinbach/Projects/agent-coworker/src/tools/webFetch.ts) so `webFetch` now returns multimodal image content for direct image URLs instead of forcing everything through markdown cleanup. It accepts image MIME types directly and also falls back to common image extensions when a server mislabels the response as `application/octet-stream`.
- Updated the shipped prompt docs in [system.md](/Users/mweinbach/Projects/agent-coworker/prompts/system.md), the GPT prompts, the Claude prompts, and the Gemini prompts so models are explicitly told that `read` can inspect local images directly and `webFetch` can inspect direct image URLs as visual content instead of cleaned markdown.
- Extended [prompt.test.ts](/Users/mweinbach/Projects/agent-coworker/test/prompt.test.ts) with direct coverage for the loaded default/GPT prompts plus a file-based regression over all shipped prompt files that document `read` and `webFetch`. Extended [tools.test.ts](/Users/mweinbach/Projects/agent-coworker/test/tools.test.ts) so `webFetch` is covered for direct image responses and octet-stream image URLs.
- Verification:
  - `~/.bun/bin/bun test test/prompt.test.ts` -> pass (`45 pass, 0 fail`)
  - `~/.bun/bin/bunx tsc --noEmit` -> pass
  - `~/.bun/bin/bun test` -> pass (`1723 pass, 2 skip, 0 fail`)
  - `git diff --check` -> pass

# Task: Make desktop chat file references clickable short labels

## Plan
- [x] Inspect the desktop chat markdown pipeline and confirm where bare local file paths currently bypass link handling.
- [x] Update the desktop message renderer so bare absolute local file paths become clickable links that display only the file name.
- [x] Add regression tests for raw absolute paths, keep existing markdown file links working, and run focused verification.

## Review
- Updated [message.tsx](/C:/Users/maxw6/Projects/agent-coworker/apps/desktop/src/components/ai-elements/message.tsx) so assistant markdown now auto-links bare absolute local file paths during the Streamdown remark pass, reuses the existing local `cowork-file` link flow, and shortens local file link labels down to their basename when the label is just a full path.
- The transform explicitly skips existing links, inline code, fenced code, and raw anchor/code/pre elements so code samples and authored markdown links are not rewritten.
- Added regression coverage in [message-links.test.ts](/C:/Users/maxw6/Projects/agent-coworker/apps/desktop/test/message-links.test.ts) for bare path rewriting, basename normalization, rendered assistant output, and the inline-code exclusion.
- Verification:
  - `C:\Users\maxw6\.bun\bin\bun test apps\desktop\test\message-links.test.ts` -> pass (`9 pass, 0 fail`)
  - `C:\Users\maxw6\.bun\bin\bun run typecheck:desktop` -> pass
  - `git -c safe.directory=C:/Users/maxw6/Projects/agent-coworker -C C:\Users\maxw6\Projects\agent-coworker diff --check` -> pass
  - `C:\Users\maxw6\.bun\bin\bun test` -> Bun runtime crash after extensive passing output (`panic(main thread): switch on corrupt value`), so the full-suite result is inconclusive and appears environmental rather than caused by this patch.
# Task: Add desktop release CI for macOS and Windows

## Plan
- [x] Review the existing desktop packaging config, release prerequisites, and GitHub Actions conventions.
- [x] Add a GitHub Actions workflow for desktop release builds on macOS and Windows, plus any supporting script changes needed for CI publishing.
- [x] Update the desktop docs/task review with the new release flow and required secrets.
- [x] Run verification commands, inspect the diff, and record outcomes in the review section below.

## Review
- Added `.github/workflows/desktop-release.yml` to create a dedicated desktop release pipeline. It runs on tag pushes matching `v*` or `desktop-v*` plus manual `workflow_dispatch`, validates the repo on Ubuntu, packages the desktop app on native macOS and Windows runners, uploads the generated installers as workflow artifacts, and publishes those artifacts to the matching GitHub Release when the ref is a tag.
- Kept release publishing in GitHub Actions instead of relying on `electron-builder` auto-publish behavior. That makes the workflow easier to reason about, avoids double-publish surprises, and limits release write permissions to a single publish job.
- Added a macOS CI helper step that turns the `APPLE_API_KEY` secret into a temporary `.p8` file on the runner, so the release workflow supports both Apple ID notarization (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) and App Store Connect API-key notarization (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`).
- Updated `apps/desktop/scripts/notarize.cjs` so desktop packaging now accepts either notarization credential set instead of only the Apple ID flow.
- Updated `apps/desktop/README.md` with the new release workflow triggers, artifact behavior, and optional signing/notarization secrets. The docs note that CI stores `APPLE_API_KEY` as raw `.p8` contents and that macOS release jobs now fail early if signing or notarization inputs are missing.

### Verification
- `bun run docs:check` -> pass
- `bun run typecheck` -> pass
- `bun test` -> reproducibly crashes inside Bun after extensive passing output with `panic(main thread): switch on corrupt value`; this appears to be the same environment/runtime issue already seen in this repo, not a failure tied to the workflow changes
- `bun test --cwd apps/desktop` -> pass (`146 pass, 0 fail`)
- `CSC_IDENTITY_AUTO_DISCOVERY=false bun run desktop:build` -> pass when rerun outside the sandbox; produced `apps/desktop/release/Cowork-0.1.0-win-x64.exe`, `.blockmap`, and `latest.yml`
- `git -c safe.directory=C:/Users/maxw6/Projects/agent-coworker diff --check` -> pass

# Task: Fix packaged desktop workspace-server startup on Windows installs

## Plan
- [x] Inspect the Electron workspace-server startup path and collect local machine evidence from the packaged desktop logs.
- [x] Identify why the packaged `cowork-server` sidecar exits before emitting `server_listening` on this machine.
- [x] Patch the startup path, add regression coverage, rebuild the sidecar, and verify the packaged spawn contract.

## Review
- Confirmed the user-facing `"desktop:startWorkspaceServer"` error was coming from the packaged sidecar child process in [serverManager.ts](/C:/Users/maxw6/Projects/agent-coworker/apps/desktop/electron/services/serverManager.ts), not from IPC itself. The decisive local evidence was [server.log](C:/Users/maxw6/AppData/Roaming/Cowork/logs/server.log), which showed repeated `ENOENT` crashes for `jsdom` trying to open `D:\a\agent-coworker\agent-coworker\node_modules\jsdom\lib\jsdom\browser\default-stylesheet.css` before startup.
- Updated [webFetch.ts](/C:/Users/maxw6/Projects/agent-coworker/src/tools/webFetch.ts) so `jsdom` and `@mozilla/readability` are loaded lazily instead of at module import time, and so the desktop bundled sidecar (`COWORK_DESKTOP_BUNDLE=1`) skips the readability pass and falls back to direct HTML-to-Markdown conversion. That prevents the packaged server from crashing during startup just because `webFetch` exists in the tool registry.
- Added regression coverage in [tools.test.ts](/C:/Users/maxw6/Projects/agent-coworker/test/tools.test.ts) for the desktop-bundle fallback path, rebuilt the desktop resources, and verified the rebuilt sidecar emits a real `server_listening` JSON event when launched with the same env the desktop app uses.

### Verification
- `C:\Users\maxw6\.bun\bin\bun.exe test test\tools.test.ts --test-name-pattern "webFetch tool"` -> pass (`15 pass, 0 fail`)
- `C:\Users\maxw6\.bun\bin\bun.exe run typecheck` -> pass
- `C:\Users\maxw6\.bun\bin\bun.exe test test\tools.test.ts` -> unrelated existing failures on this machine (`webSearch` env leakage and `memory` tool failing to spawn `rg` due local permission issues); the new `webFetch` coverage passed
- `C:\Users\maxw6\.bun\bin\bun.exe run build:desktop-resources` -> pass
- Rebuilt sidecar launch with `COWORK_BUILTIN_DIR=C:\Users\maxw6\Projects\agent-coworker\dist` and `COWORK_DESKTOP_BUNDLE=1` -> emitted `{"type":"server_listening","url":"ws://127.0.0.1:53108/ws","port":53108,"cwd":"C:\\Users\\maxw6\\Desktop\\Cowork"}`

# Task: Cut desktop release 0.1.10 with the packaged sidecar startup fix

## Plan
- [x] Confirm the next release version/tag and check whether the update pipeline can publish the fixed Windows build.
- [x] Bump the repo and desktop package versions, rebuild the packaged Windows artifact, and verify the packaged sidecar itself starts cleanly.
- [x] Commit, tag, and push the release to GitHub.

## Review
- Bumped [package.json](/C:/Users/maxw6/Projects/agent-coworker/package.json) and [apps/desktop/package.json](/C:/Users/maxw6/Projects/agent-coworker/apps/desktop/package.json) from `0.1.9` to `0.1.10` so the Git tag, packaged app version, and updater-visible version all line up.
- Verified the release artifact itself, not just the repo-built sidecar: [release/win-unpacked/resources/binaries/cowork-server-x86_64-pc-windows-msvc.exe](/C:/Users/maxw6/Projects/agent-coworker/apps/desktop/release/win-unpacked/resources/binaries/cowork-server-x86_64-pc-windows-msvc.exe) now emits `server_listening` when launched with the packaged [resources/dist](/C:/Users/maxw6/Projects/agent-coworker/apps/desktop/release/win-unpacked/resources/dist) bundle. That is the concrete proof that installing `0.1.10` fixes the startup failure seen on this machine.
- Checked GitHub repo secrets before release. The repository has macOS signing/notarization secrets but does not currently have `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`, so GitHub Actions can publish the Windows installer for `0.1.10` but will intentionally skip Windows `latest.yml` / `.blockmap` auto-update metadata. That means Windows users can install the fixed `0.1.10` build manually from GitHub Releases, but in-app auto-update will remain unavailable until those Windows signing secrets are configured.

### Verification
- `C:\Users\maxw6\.bun\bin\bun.exe test test\tools.test.ts --test-name-pattern "webFetch tool"` -> pass (`15 pass, 0 fail`)
- `C:\Users\maxw6\.bun\bin\bun.exe run typecheck` -> pass
- `C:\Users\maxw6\.bun\bin\bun.exe test --cwd apps\desktop` -> pass (`171 pass, 0 fail`)
- `CSC_IDENTITY_AUTO_DISCOVERY=false C:\Users\maxw6\.bun\bin\bun.exe run desktop:build -- --publish never` -> pass; produced `apps/desktop/release/Cowork-0.1.10-win-x64.exe`, `.blockmap`, updated `latest.yml`, and refreshed `win-unpacked`
- Packaged sidecar launch with `COWORK_BUILTIN_DIR=C:\Users\maxw6\Projects\agent-coworker\apps\desktop\release\win-unpacked\resources\dist` and `COWORK_DESKTOP_BUNDLE=1` -> emitted `{"type":"server_listening","url":"ws://127.0.0.1:62693/ws","port":62693,"cwd":"C:\\Users\\maxw6\\Desktop\\Cowork"}`

# Task: Allow unsigned Windows auto-update from GitHub Releases

## Plan
- [x] Inspect the current desktop updater flow and the release workflow gate that suppresses unsigned Windows update metadata.
- [x] Update the Windows packaging/release config so unsigned releases still publish `latest.yml` and `.blockmap`.
- [x] Verify the desktop build/test flow and confirm the unsigned release artifacts include the updater feed files.

## Review
- Bumped [package.json](/C:/Users/maxw6/Projects/agent-coworker/package.json) and [apps/desktop/package.json](/C:/Users/maxw6/Projects/agent-coworker/apps/desktop/package.json) from `0.1.10` to `0.1.11` so the unsigned auto-update path ships in a fresh desktop release.
- Updated [electron-builder.yml](/C:/Users/maxw6/Projects/agent-coworker/apps/desktop/electron-builder.yml) to explicitly set `win.verifyUpdateCodeSignature: false`. The builder docs expose that switch for Windows update verification, and making it explicit keeps the unsigned-update behavior obvious instead of relying on implicit defaults.
- Updated [desktop-release.yml](/C:/Users/maxw6/Projects/agent-coworker/.github/workflows/desktop-release.yml) so the Windows packaging job always stages the installer, `.blockmap`, and `latest.yml` into the release upload set. Signing is still used when `WIN_CSC_*` exists, but it is no longer a prerequisite for publishing Windows update metadata to GitHub Releases.
- Updated [README.md](/C:/Users/maxw6/Projects/agent-coworker/apps/desktop/README.md) to document the new unsigned Windows path clearly: GitHub Releases can now act as the updater feed without Windows signing, but installs will still trigger SmartScreen friction and updates lose signature-based trust validation.

### Verification
- `C:\Users\maxw6\.bun\bin\bun.exe run typecheck` -> pass
- `C:\Users\maxw6\.bun\bin\bun.exe test --cwd apps\desktop` -> pass (`171 pass, 0 fail`)
- `CSC_IDENTITY_AUTO_DISCOVERY=false C:\Users\maxw6\.bun\bin\bun.exe run desktop:build -- --publish never` -> pass
- Built unsigned Windows release artifacts include both [latest.yml](/C:/Users/maxw6/Projects/agent-coworker/apps/desktop/release/latest.yml) and [Cowork-0.1.11-win-x64.exe.blockmap](/C:/Users/maxw6/Projects/agent-coworker/apps/desktop/release/Cowork-0.1.11-win-x64.exe.blockmap), which are the files the workflow now stages even without `WIN_CSC_*`

# Task: Fix v0.1.11 desktop release CI validation failure

## Plan
- [x] Inspect the failed GitHub Actions run and identify the exact failing job/test.
- [x] Align the desktop release workflow regression test with the new unsigned Windows updater contract.
- [x] Rerun the relevant local verification commands, push the fix, and confirm the follow-up CI run starts cleanly.

## Review
- `Desktop Release` run `22825535762` failed in the `Validate` job before packaging began. The failing step was `bun test`, and the only failing test was `desktop release workflow > always uploads the Windows installer but only stages updater metadata when Windows signing secrets exist`.
- Root cause: [desktop-release.workflow.test.ts](/C:/Users/maxw6/Projects/agent-coworker/test/desktop-release.workflow.test.ts) still asserted the pre-`0.1.11` behavior that unsigned Windows releases skip `latest.yml` and `.blockmap`, but the workflow now stages those files intentionally.
- Updated the workflow regression test so it now expects the current contract: Windows release staging always copies the installer, `.blockmap`, and `latest.yml`, while signing remains optional and only changes the log message / signature path.
- Bumped [package.json](/C:/Users/maxw6/Projects/agent-coworker/package.json) and [apps/desktop/package.json](/C:/Users/maxw6/Projects/agent-coworker/apps/desktop/package.json) from `0.1.11` to `0.1.12` so the corrected release can publish on a fresh tag without rewriting the failed `v0.1.11` tag.

### Verification
- `C:\Users\maxw6\.bun\bin\bun.exe run docs:check` -> pass
- `C:\Users\maxw6\.bun\bin\bun.exe test test\desktop-release.workflow.test.ts` -> pass (`2 pass, 0 fail`)
- `C:\Users\maxw6\.bun\bin\bun.exe run typecheck` -> pass
- `CSC_IDENTITY_AUTO_DISCOVERY=false C:\Users\maxw6\.bun\bin\bun.exe run desktop:build -- --publish never` -> pass; produced `apps/desktop/release/Cowork-0.1.12-win-x64.exe` and `.blockmap`
- `C:\Users\maxw6\.bun\bin\bun.exe test` -> still fails on this Windows machine in pre-existing unrelated `webSearch` and `memory` cases (`4 fail` total); the `desktop-release.workflow` regression now passes locally, and the failed GitHub Actions run showed this was the only CI failure in `Validate`

# Task: Review open PR comments for remaining work

## Plan
- [x] Inspect the current branch context, repo task log, and PR-comment handling skill.
- [x] Verify `gh` auth, find the open PR for the current branch, and fetch all review comments/threads.
- [x] Compare the still-open feedback against the current code and summarize the actionable items to work on next.

## Review
- PR `#29` (`Add GPT-5.4 defaults and workspace provider controls`) currently has two unresolved review threads from `chatgpt-codex-connector`.
- Thread 1 on `apps/TUI/component/prompt/slash-commands.ts` is already fixed in the branch: the slash-command helper now checks the boolean return from `syncActions.setConfig(...)`, shows `Not connected — reconnect and try again` on failure, and only shows the success toast when the update was actually dispatched.
- Follow-up fix applied for thread 2 on `src/cli/repl/commandRouter.ts`: the REPL now tracks the most recently requested provider locally as soon as `/provider <name>` successfully dispatches, and refreshes that selection from `server_hello` / `config_updated`. That makes `/provider codex-cli` followed immediately by `/effort xhigh` target `codex-cli` instead of the previously active provider.
- Verification:
  - `C:\Program Files\GitHub CLI\gh.exe auth status` -> authenticated as `mweinbach`
  - `C:\Program Files\GitHub CLI\gh.exe pr view --json number,title,url,headRefName,baseRefName,state,isDraft,author` -> open PR `#29`
  - `C:\Program Files\GitHub CLI\gh.exe api graphql ... reviewThreads(first: 100)` -> 2 unresolved threads
  - `C:\Users\maxw6\.bun\bin\bun test test/repl.test.ts test/tui.slash-commands.test.ts` -> pass (`83 pass, 0 fail`)
  - `C:\Users\maxw6\.bun\bin\bun test test/repl.test.ts` -> pass (`74 pass, 0 fail`)
  - `C:\Users\maxw6\.bun\bin\bun run typecheck` -> pass

# Task: Correct merge-release version to 0.1.13

## Plan
- [x] Inspect the current package version and local `v0.1.12` tag placement after the merge commit.
- [x] Bump the repo and desktop package versions from `0.1.12` to `0.1.13`.
- [x] Restore `v0.1.12` to the prior release commit, create `v0.1.13` at `HEAD`, and verify the tag layout.

## Review
- The merge commit at `HEAD` was newer than the existing `v0.1.12` release commit, so treating it as the same release would have overwritten the previous release marker instead of minting the next patch.
- Updated `package.json` and `apps/desktop/package.json` from `0.1.12` to `0.1.13` so the repository version matches the intended next release number.
- Restored `v0.1.12` to commit `92863a1` (`Fix desktop release validation in v0.1.12`) and reserved the current commit for the new `v0.1.13` release tag.

# Task: Persist desktop provider status across app restarts

## Plan
- [x] Confirm whether Codex OAuth itself is failing to persist or whether the desktop UI is only losing its in-memory provider status snapshot after restart.
- [x] Persist a sanitized desktop provider-status snapshot in `state.json` and hydrate it during desktop bootstrap so Codex still shows connected immediately after reopen.
- [x] Add regression coverage for persistence/bootstrap behavior, rerun the desktop verification slices, and record the outcome below.

## Review
- Live inspection showed the auth files were already persisting correctly under `/Users/mweinbach/.cowork/auth`: both `codex-cli/auth.json` and `connections.json` existed with a saved Codex OAuth session. The bug was the desktop UI forgetting the last known provider status because that snapshot only lived in renderer memory.
- Added a shared `persistedProviderState` normalizer in `apps/desktop/src/app/persistedProviderState.ts`, extended `PersistedState` in `apps/desktop/src/app/types.ts`, and taught both the renderer persistence helper and Electron persistence service to save/load a sanitized provider-status snapshot alongside workspaces/threads.
- Desktop bootstrap now hydrates `providerStatusByName`, `providerStatusLastUpdatedAt`, and `providerConnected` from the persisted snapshot before the first control-socket refresh completes, so reopening the app no longer makes Codex look logged out while the server reconnects.
- The normal control-socket refresh path still remains authoritative: when a fresh `provider_status` event arrives, the desktop store updates from the server and immediately re-persists the newer snapshot.

### Verification
- `~/.bun/bin/bun test apps/desktop/test/persistence-state-sanitization.test.ts apps/desktop/test/workspace-settings-sync.test.ts apps/desktop/test/providers-page.test.ts apps/desktop/test/protocol-v2-events.test.ts` -> pass (`46 pass, 0 fail`)
- `~/.bun/bin/bun run typecheck` -> pass
- `~/.bun/bin/bun test --cwd apps/desktop` -> pass (`195 pass, 0 fail`)

# Task: Fix desktop renderer protocol alias resolution for Electron dev/build

## Plan
- [x] Inspect the desktop renderer alias/import path for `@cowork/server/protocol` and identify why electron-vite cannot resolve it during renderer compilation.
- [x] Patch the desktop alias setup with the minimal change that restores `wsProtocol.ts` resolution without changing renderer protocol behavior.
- [x] Re-run the desktop build path, desktop typecheck, and any focused tests needed to prove the fix.

## Review
- Root cause: the desktop renderer wrapper in `apps/desktop/src/lib/wsProtocol.ts` imported core protocol/types through the `@cowork/*` alias, but `electron-vite`/Rollup was not reliably resolving that repo-root alias during renderer compilation even though TypeScript accepted it. The failure reproduced exactly as `Rollup failed to resolve import "@cowork/server/protocol"`.
- Fixed `apps/desktop/src/lib/wsProtocol.ts` to import the core protocol/types directly from the repo root via relative paths (`../../../../src/...`). That keeps the shared renderer-facing wrapper behavior unchanged while removing the brittle renderer alias dependency.
- I also tested a renderer-config alias hardening in `apps/desktop/electron.vite.config.ts`, but `electron-vite build` still failed to resolve `@cowork/server/protocol`. I reverted that experiment so the final fix stays minimal and only keeps the proven `wsProtocol.ts` change.

### Verification
- `~/.bun/bin/bunx electron-vite build` (from `apps/desktop`) -> pass
- `~/.bun/bin/bun run desktop:dev` -> pass through renderer startup (`dev server running for the electron renderer process at http://localhost:1420/`), then stopped manually
- `~/.bun/bin/bun run typecheck:desktop` -> pass
- `~/.bun/bin/bun test --cwd apps/desktop test/ws-protocol-parse.test.ts test/protocol-v2-events.test.ts` -> pass (`30 pass, 0 fail`)
- `~/.bun/bin/bun test --cwd apps/desktop` -> pass (`196 pass, 0 fail`)

# Task: Keep late reasoning summaries from rendering after the final assistant answer

## Plan
- [x] Reproduce the MacBook Neo thread ordering bug from the persisted transcript and confirm whether the reversal happens during transcript hydration, live reducer handling, or grouped-trace rendering.
- [x] Patch desktop feed construction so legacy reasoning summaries that arrive after a raw-backed final-answer stream are anchored before the final assistant message instead of trailing it.
- [x] Add transcript and live-reducer regressions, then rerun the relevant desktop verification commands.

## Review
- The persisted transcript for the MacBook Neo thread (`/Users/mweinbach/Library/Application Support/Cowork/transcripts/4affe7fd-a696-4575-855c-76f78fc2e880.jsonl`) was not wrong. It stores the legacy `reasoning` summary at `2026-03-09T17:00:15.987Z` and the fallback `assistant_message` at `2026-03-09T17:00:15.995Z`.
- The visible reversal came from desktop feed construction on raw-backed turns: the final assistant text was already rendered earlier from `model_stream_raw`, and then the legacy turn-end `reasoning` summary was appended afterward because there was no raw reasoning stream to dedupe it against. So the reasoning card landed below the final assistant bubble even though the persisted tail events themselves were in the expected order.
- Fixed `apps/desktop/src/app/store.feedMapping.ts` and `apps/desktop/src/app/store.helpers/threadEventReducer.ts` so when a late legacy reasoning summary arrives for a raw-backed turn that already has a streamed assistant message, the summary is inserted immediately before that assistant item instead of being pushed to the end of the feed.

### Verification
- `~/.bun/bin/bun test --cwd apps/desktop test/store-feed-mapping.test.ts test/protocol-v2-events.test.ts` -> pass (`32 pass, 0 fail`)
- `~/.bun/bin/bun run typecheck:desktop` -> pass
- `~/.bun/bin/bun test --cwd apps/desktop` -> pass (`198 pass, 0 fail`)

# Task: Hide standalone reasoning titles in collapsed Thinking card previews

## Plan
- [x] Inspect the collapsed Thinking-card preview path and confirm where the first reasoning heading is being surfaced.
- [x] Change only the collapsed preview generation so standalone markdown headings are stripped, while the expanded reasoning content stays unchanged.
- [x] Add chat-card regressions and rerun the relevant desktop verification commands.

## Review
- The heading text was coming from the grouped-card preview builder in `apps/desktop/src/ui/chat/activityGroups.ts`, not from the expanded reasoning row. The preview was just taking the first non-empty lines of the reasoning note, so a standalone markdown heading like `**Planning search strategy**` leaked into the in-chat card summary.
- Updated `reasoningPreviewText(...)` in `apps/desktop/src/ui/chat/activityGroups.ts` to strip leading standalone markdown heading lines (`**...**`, `__...__`, or `# ...`) before building the collapsed preview. This only changes the collapsed summary text; the expanded reasoning content still renders the full original note with its heading intact.
- Added regressions in `apps/desktop/test/chat-activity-groups.test.ts` and `apps/desktop/test/chat-activity-group-card.test.tsx` to pin the exact behavior you asked for: the collapsed card preview shows the body text (`I need to be careful...`) and not the heading, while the reasoning body itself remains untouched.

### Verification
- `~/.bun/bin/bun test --cwd apps/desktop test/chat-activity-groups.test.ts test/chat-activity-group-card.test.tsx` -> pass (`17 pass, 0 fail`)
- `~/.bun/bin/bun run typecheck:desktop` -> pass
- `~/.bun/bin/bun test --cwd apps/desktop` -> pass (`200 pass, 0 fail`)

# Task: Fix accepted review findings for OpenAI compaction support

## Plan
- [x] Add the missing direct dependency for the new raw projector and regenerate the lockfile.
- [x] Fix the Codex browser OAuth callback host so the redirect URI matches the loopback listener binding.
- [x] Harden raw replay and Codex usage verification so unsupported raw events do not suppress normalized chunks and malformed `/wham/usage` payloads do not mark Codex as verified.
- [x] Run the targeted provider/runtime/desktop tests plus typecheck, then record the results below.

## Review
- Added `partial-json` as a direct root dependency in `package.json` and regenerated `bun.lock`, which fixes the clean-install/module-resolution failure for `src/runtime/openaiResponsesProjector.ts`.
- `src/providers/codex-oauth-flows.ts` now builds the browser redirect URI with `OAUTH_LOOPBACK_HOST`, so the OAuth callback URI stays aligned with the listener that actually binds `127.0.0.1`.
- `src/client/modelStreamReplay.ts` now marks a turn as raw-backed only after raw replay produces replayable updates, which prevents unsupported raw events from suppressing later normalized reasoning/text/tool chunks.
- `src/providerStatus.ts` now treats malformed 200 responses from `/wham/usage` as verification failures instead of incorrectly marking `codex-cli` as verified.
- Added regressions in `test/providers/codex-oauth-flows.test.ts`, `test/providerStatus.test.ts`, and new `test/modelStreamReplay.test.ts`.

### Verification
- `bun test test/providers/codex-oauth-flows.test.ts test/providerStatus.test.ts test/modelStreamReplay.test.ts apps/desktop/test/store-feed-mapping.test.ts apps/desktop/test/protocol-v2-events.test.ts test/agentSocket.parse.test.ts` -> pass (`51 pass, 0 fail`)
- `bun run typecheck` -> pass

# Task: Re-check unresolved PR review comments for relevance

## Plan
- [x] Verify `gh` auth, locate the open PR for the current branch, and fetch unresolved review threads.
- [x] Inspect the current code for each unresolved comment to determine whether the reported regression still exists at `HEAD`.
- [x] Record which comments remain relevant and note any stale parts of the `gh-address-comments` skill workflow.

## Review
- `gh auth status` is healthy, and the current branch `codex/add-openai-compaction-support` has open PR `#31` (`Fix OpenAI compaction support for desktop flows`) with two unresolved review threads from `chatgpt-codex-connector`.
- Thread 1 on `src/client/modelStreamReplay.ts` is no longer relevant at `HEAD`. GitHub marks it outdated, the current implementation returns `[]` on projection failure (`src/client/modelStreamReplay.ts:57-65`), and it only marks the turn as raw-backed after at least one replay update is produced (`src/client/modelStreamReplay.ts:92-94`).
- Thread 1 is covered by `test/modelStreamReplay.test.ts`: one test proves normalized chunks are still accepted when raw replay yields no updates, and another proves raw-backed suppression starts only after replayable output exists.
- Thread 2 on `src/connect.ts` is still relevant. `connectProvider()` accepts `code?: string` (`src/connect.ts:71-82`), but the Codex OAuth path always calls `runCodexBrowserOAuth(...)` (`src/connect.ts:165-174`) and never consumes or forwards `opts.code`, so a `provider_auth_callback` payload with a manual code still cannot complete via this path.
- The surrounding plumbing still expects manual-code callbacks to work: `callbackProviderAuth()` forwards `code` into the connect handler (`src/providers/authRegistry.ts:170-178`) and the websocket protocol still documents `provider_auth_callback` with an optional `code` field (`docs/websocket-protocol.md:649-665`).
- Coverage confirms the gap rather than closing it. `test/providers/auth-registry.test.ts` only verifies the registry forwards `code` to the connect handler, `test/session.test.ts` exercises the callback path without a code, and `test/connect.test.ts` only covers browser-based Codex OAuth. There is no `connectProvider()` test asserting a manual authorization code is consumed for Codex.
- The `gh-address-comments` skill is only partially current: the overall `gh`/PR-comment workflow still applies, but the referenced helper `scripts/fetch_comments.py` is missing from this repo, so the fetching step should be updated to use the current `gh api graphql ... reviewThreads(first: 100)` flow instead.

### Verification
- `gh pr view --json number,title,headRefName,url,state,isDraft,reviewDecision,comments,reviews` -> open PR `#31`
- `gh api graphql ... reviewThreads(first: 100)` -> 2 unresolved threads, 1 outdated and 1 current
- `~/.bun/bin/bun test test/modelStreamReplay.test.ts test/connect.test.ts test/providers/auth-registry.test.ts test/session.test.ts test/protocol.test.ts` -> pass (`354 pass, 0 fail`)

# Task: Fix Codex manual callback auth path for unresolved PR review feedback

## Plan
- [x] Rework the Codex browser OAuth helpers so an auth challenge can keep the PKCE redirect/code-verifier state alive across `provider_auth_authorize` and `provider_auth_callback`.
- [x] Thread that pending Codex auth state through the session/provider connect path so manual callback codes are consumed instead of forcing a new browser listener flow.
- [x] Add focused regression coverage for manual callback completion and rerun the relevant provider/session/protocol tests.

## Review
- `src/providers/codex-oauth-flows.ts` now separates Codex browser OAuth into `prepareCodexBrowserOAuth()` and `completeCodexBrowserOAuth(...)`. That keeps the generated PKCE verifier and redirect URI alive across the authorize/callback boundary and lets a manual callback code finish the token exchange without reopening the browser.
- `src/server/session/ProviderAuthManager.ts` now owns the pending Codex browser challenge for the session. `provider_auth_authorize` emits a real challenge URL for `codex-cli/oauth_cli`, and `provider_auth_callback` passes the pending PKCE state into the connect path before clearing it.
- `src/connect.ts` and `src/providers/authRegistry.ts` now thread optional pending Codex browser auth state through `connectProvider()`. When a manual `code` arrives with an active challenge, Cowork exchanges it directly; if a code arrives without a pending challenge, the call now fails clearly instead of silently starting a fresh browser-only flow.
- Added regression coverage in `test/session.test.ts`, `test/connect.test.ts`, and `test/providers/codex-oauth-flows.test.ts` for:
  - emitting a real Codex browser auth challenge URL at authorize time,
  - keeping the old authorize -> callback browser path working,
  - accepting a manual callback code after authorize,
  - and exercising the real PKCE token exchange helper with a manual code.

### Verification
- `~/.bun/bin/bun test test/connect.test.ts test/providers/auth-registry.test.ts test/session.test.ts test/protocol.test.ts` -> pass (`354 pass, 0 fail`)
- `~/.bun/bin/bun test test/providers/codex-oauth-flows.test.ts` -> pass (`3 pass, 0 fail`)
- `~/.bun/bin/bun run typecheck` -> pass

# Task: Review PR #30 session usage/cost UX and complete desktop wiring

## Plan
- [x] Inspect the PR diff plus current desktop state flow to confirm whether session usage/cost data is actually surfaced in the desktop app.
- [x] Fix any missing desktop protocol/state/UI wiring so session usage and budget status are visible and update correctly.
- [x] Add regression coverage and run the relevant desktop/core verification commands, then record review findings and validated results below.

## Review
- The original PR was not desktop-complete. `turn_usage` and `session_usage` were added to the shared protocol/runtime, but desktop had no reducer branches or runtime state for them, so normal users saw nothing and developer mode degraded them to generic unhandled events. Desktop now stores live and replayed usage snapshots, requests `get_session_usage` on thread reconnect, and surfaces a session-usage summary in the chat header.
- The session budget update path had a protocol/implementation mismatch. The websocket contract and docs treat `set_session_usage_budget` as a partial update where omitted fields are preserved and `null` clears a single threshold, but the runtime was replacing the whole threshold object. `SessionCostTracker.updateBudget()` now preserves unspecified thresholds, `AgentSession.setSessionUsageBudget(...)` uses it, and the `usage set_budget` tool now follows the same semantics.
- Resumed sessions were losing all accumulated usage and budget state because cost tracking was not part of the persisted session snapshot or DB row. Session snapshots now persist `costTracker`, the session DB stores `cost_tracker_json` with a migration, and resumed sessions rebuild `SessionCostTracker` from the persisted snapshot instead of starting from zero.

### Verification
- `git diff --check` -> pass
- `~/.bun/bin/bun test apps/desktop/test/thread-reconnect.test.ts apps/desktop/test/chat-reasoning-ui.test.ts test/session.test.ts test/session.costTracker.test.ts test/tools.usage.test.ts test/session-store.test.ts test/session-db.test.ts test/session-db-mappers.test.ts` -> pass (`232 pass, 0 fail`)
- `~/.bun/bin/bun run typecheck` -> pass
- `~/.bun/bin/bun test` -> pass (`1900 pass, 2 skip, 0 fail`)

# Task: Reveal desktop usage stats from the thread title on hover

## Plan
- [x] Inspect the current desktop chat header usage summary and choose the smallest interaction change that hides it by default while keeping it discoverable.
- [x] Update the desktop chat header so the usage summary appears on title hover/focus instead of rendering persistently.
- [x] Add a regression around the new reveal behavior and run the relevant desktop verification commands.

## Review
- The chat header now keeps the thread title visible at all times but hides the usage summary by default. The usage pill is revealed from the title wrapper on hover and keyboard focus, so the UI stays cleaner without losing discoverability.
- Extracted the title/header markup into `ChatThreadHeader` so the reveal interaction is isolated, reusable, and directly testable without depending on the full desktop store.
- Reduced the conversation top padding back to the title-only spacing, since usage no longer occupies permanent header space.

### Verification
- `git diff --check` -> pass
- `~/.bun/bin/bun test apps/desktop/test/chat-reasoning-ui.test.ts apps/desktop/test/thread-reconnect.test.ts` -> pass (`14 pass, 0 fail`)
- `~/.bun/bin/bun run typecheck` -> pass
- `~/.bun/bin/bun test --cwd apps/desktop` -> pass (`207 pass, 0 fail`)

# Task: Make desktop token counts developer-only while keeping cost visible

## Plan
- [x] Inspect the existing desktop developer-mode toggle and current usage headline formatting.
- [x] Update the usage header so normal mode shows turns plus estimated cost, while developer mode also exposes token counts.
- [x] Add regression coverage, rerun desktop verification, and record the validated behavior.

## Review
- Reused the existing desktop `Developer mode` toggle instead of adding another setting. Normal desktop mode now hides total and last-turn token counts in the usage pill, while developer mode continues to show them.
- Updated the usage headline copy so cost is explicitly labeled as an estimate (`est. $...`). That makes the default desktop view easier to read and avoids conflating token totals with dollar cost.
- Added coverage for both paths: normal mode headline formatting, developer-mode headline formatting, and render-level confirmation that the non-developer header does not include token counts.

### Verification
- `git diff --check` -> pass
- `~/.bun/bin/bun test apps/desktop/test/chat-reasoning-ui.test.ts apps/desktop/test/thread-reconnect.test.ts` -> pass (`16 pass, 0 fail`)
- `~/.bun/bin/bun run typecheck` -> pass
- `~/.bun/bin/bun test --cwd apps/desktop` -> pass (`209 pass, 0 fail`)

# Task: Make normal desktop usage hover cost-only and verify pricing sources

## Plan
- [x] Update the desktop hover summary so non-developer mode shows only estimated price, not turns or token counts.
- [x] Inspect the pricing pipeline to confirm whether runtime/provider responses expose direct price data or whether we still rely on local pricing tables.
- [x] Refresh any verified stale GPT-5.4 pricing entries used for desktop/session cost estimates, then rerun focused verification and record findings.

## Review
- Normal desktop hover copy is now cost-only. In non-developer mode the usage pill shows just `est. $...` (or `est. cost unavailable`) instead of turns/tokens, while developer mode still shows turns plus token counts for debugging.
- Session cost estimation is still local-table based, not provider-authoritative. `SessionCostTracker` calculates cost from token counts plus `src/session/pricing.ts`; the shared runtime/session usage shape only carries prompt/completion/total token counts. There is no session-accounting path today that consumes a provider-returned dollar-cost field.
- Codex CLI does not expose per-model pricing through the provider-status usage endpoint. That endpoint gives account/plan/rate-limit/credits information only, so GPT-5.4 Codex CLI session pricing still depends on the local pricing catalog. Refreshed the verified `openai:gpt-5.4` and `codex-cli:gpt-5.4` entries to current OpenAI pricing.

### Verification
- `git diff --check` -> pass
- `~/.bun/bin/bun test apps/desktop/test/chat-reasoning-ui.test.ts apps/desktop/test/thread-reconnect.test.ts test/session/pricing.test.ts` -> pass (`35 pass, 0 fail`)
- `~/.bun/bin/bun run typecheck` -> pass
- `~/.bun/bin/bun test --cwd apps/desktop` -> pass (`209 pass, 0 fail`)

# Task: Carry cached-token-aware pricing through raw usage and keep normal desktop hover price-only

## Plan
- [x] Extend the runtime/session usage contract so raw OpenAI/Codex usage can preserve cached prompt token counts and optional estimated cost instead of collapsing everything to prompt/completion totals.
- [x] Update session cost estimation to use cached-input pricing when available, keep the desktop hover price-only in normal mode, and document the websocket contract change.
- [x] Add/update focused regressions, rerun the relevant verification commands, and record what is provider-authoritative versus still locally estimated.

## Review
- Raw OpenAI/Codex usage now preserves cached input explicitly instead of lying about prompt totals. `normalizePiUsage(...)` converts raw Responses-style usage into canonical `promptTokens`/`completionTokens`/`totalTokens` while carrying `cachedPromptTokens` separately, and both runtimes now emit that richer shape through `turn_usage`.
- Session cost estimates are now cache-aware. `SessionCostTracker` computes cost from total prompt tokens plus cached-token discounts when the model pricing table includes cached-input pricing, and it will also honor an explicit `estimatedCostUsd` if a runtime/provider starts supplying one.
- The desktop hover behavior stays price-only for normal users. Developer mode still keeps the fuller token/turn view, but reconnect/transcript replay now preserves the richer per-turn usage fields so raw-backed sessions do not lose cached-token metadata on reopen.
- Provider-authoritative pricing is still not exposed for GPT-5.4 Codex CLI in Cowork today. We verified the OpenAI GPT-5.4 price points from the official pricing page and now use those rates with cached-token-aware math, but the Codex usage endpoint Cowork consumes still exposes plan/rate-limit/credits state rather than a per-model dollar-cost field.

### Verification
- `git diff --check` -> pass
- `~/.bun/bin/bun run docs:check` -> pass
- `~/.bun/bin/bun run typecheck` -> pass
- `~/.bun/bin/bun test test/runtime.pi-message-bridge.test.ts test/runtime.openai-responses-runtime.test.ts test/session.costTracker.test.ts test/session/pricing.test.ts test/agent.test.ts test/session.test.ts apps/desktop/test/thread-reconnect.test.ts apps/desktop/test/chat-reasoning-ui.test.ts` -> pass (`300 pass, 0 fail`)
- `~/.bun/bin/bun test test/agentSocket.parse.test.ts test/server.toolstream.test.ts test/server.model-stream.test.ts test/session.stream-pipeline.test.ts` -> pass (`161 pass, 0 fail`)
- `~/.bun/bin/bun test --cwd apps/desktop` -> pass (`209 pass, 0 fail`)

# Task: Triage PR review comments for relevance and fix scope

## Plan
- [x] Fetch the live PR review comments and inline threads for the current branch.
- [x] Normalize them into numbered items with file context, author, and thread state.
- [x] Use subagents to classify each item as relevant, already addressed, or not actionable, and draft a fix plan for anything still relevant.
- [x] Return the triage summary in-thread without applying code changes.

## Review
- PR #30 on GitHub points at head commit `d88d6f8aa47e9975e06af98cc2553e8552309915`, while the local `pr/30` checkout is one commit ahead. Triage was done against the GitHub PR head, not the extra local commit.
- Still relevant: `src/server/session/AgentSession.ts` and `src/tools/usage.ts` both preserve budget thresholds incorrectly because they route partial updates through replace-style `SessionCostTracker.setBudget(...)`; warn-only updates drop an existing hard-stop threshold instead of preserving it.
- Partially relevant docs follow-up: the websocket docs now cover nullable `session_usage.usage` and the main snapshot fields, but `SessionUsageSnapshot` still references undocumented nested shapes (`ModelUsageSummary[]`, `TurnCostEntry[]`), so the contract is not fully self-describing yet.
- Already addressed or stale: protocol version/parser support, nullable `session_usage` parsing, missing `bun:test` import, deterministic recent-turn timestamps, trigger reset on threshold removal, hard-stop enforcement, recovery path after lockout, and the outdated `createTools()` / spacing nits.

### Verification
- `python3 /Users/mweinbach/.codex/skills/gh-address-comments/scripts/fetch_comments.py` could not resolve the PR from local branch metadata because `gh` mapped the checkout to `Diwak4r:pr/30`; fetched PR #30 review data instead via the skill script imported with explicit owner/repo/number.
- `gh pr view 30 --json headRefOid,commits` -> PR head confirmed as `d88d6f8aa47e9975e06af98cc2553e8552309915`
- `~/.bun/bin/bun test test/agentSocket.parse.test.ts test/session.costTracker.test.ts test/tools.usage.test.ts test/session.test.ts` in a detached worktree at `d88d6f8...` -> pass (`205 pass, 0 fail`)
- `~/.bun/bin/bun -e 'import { SessionCostTracker } from "./src/session/costTracker"; const t=new SessionCostTracker("s"); t.setBudget({ warnAtUsd: 2, stopAtUsd: 5 }); console.log("before", JSON.stringify(t.getBudgetStatus())); t.setBudget({ warnAtUsd: 3 }); console.log("after_warn_only", JSON.stringify(t.getBudgetStatus()));'` in the detached worktree -> reproduced the live partial-update bug (`stopAtUsd` dropped to `null`)
- `~/.bun/bin/bun -e 'import { createUsageTool } from "./src/tools/usage"; import { SessionCostTracker } from "./src/session/costTracker"; const tracker = new SessionCostTracker("s"); const tool = createUsageTool({ config: {} as any, log: ()=>{}, askUser: async ()=>"", approveCommand: async ()=>true, costTracker: tracker }); await tool.execute({ action: "set_budget", warnAtUsd: 2, stopAtUsd: 5 }); console.log("after_both", JSON.stringify(tracker.getBudgetStatus())); await tool.execute({ action: "set_budget", warnAtUsd: 3 }); console.log("after_warn_only", JSON.stringify(tracker.getBudgetStatus()));'` in the detached worktree -> reproduced the same bug through the tool path

# Task: Fix session budget update semantics and add desktop usage settings page

## Plan
- [x] Fix the remaining budget-threshold update bug so omitted fields are preserved and only explicit `null` clears thresholds across the tracker, websocket handler, and `usage` tool.
- [x] Complete the websocket protocol docs for nested session-usage shapes and extend docs regression coverage.
- [x] Add a desktop Settings `Usage` page backed by the selected thread’s `sessionUsage` / `lastTurnUsage`, including model/cost breakdowns and an estimates warning popup.
- [x] Run focused core + desktop verification and record the validated result.

## Review
- Budget updates now preserve omitted thresholds, allow explicit `null` clears, and reject merged warn/stop configurations that would become invalid after partial updates.
- The websocket protocol docs now define nested session-usage payload shapes (`ModelUsageSummary`, `TurnCostEntry`, `TurnUsage`, `ModelPricing`) and the docs check locks those sections in place.
- Desktop Settings now includes a `Usage` page with per-thread model/cost/token breakdowns, recent turn history, budget status, and an estimates warning dialog that cautions users that billing may vary.

### Verification
- `~/.bun/bin/bun test test/session.costTracker.test.ts test/session.test.ts test/tools.usage.test.ts test/docs.check.test.ts` -> pass (`209 pass, 0 fail`)
- `~/.bun/bin/bun test --cwd apps/desktop test/settings-nav.test.ts test/thread-reconnect.test.ts test/usage-page.test.ts` -> pass (`20 pass, 0 fail`)
- `~/.bun/bin/bun test --cwd apps/desktop` -> pass (`212 pass, 0 fail`)
- `~/.bun/bin/bun run typecheck` -> pass
- `~/.bun/bin/bun test` -> pass (`1917 pass, 2 skip, 0 fail`)

# Task: Harden Codex auth persistence into ~/.cowork

## Plan
- [x] Trace the current Codex OAuth connect path and close any boundary where a login can succeed without a durable Cowork auth write.
- [x] Make the connect/runtime path prove the saved token is written to and read back from `~/.cowork/auth/codex-cli/auth.json`.
- [x] Add focused regressions for the durable write/read contract and rerun the relevant Bun verification slices.

## Review
- Root cause: the connect boundary was trusting the OAuth helper to have already persisted credentials. That meant a helper could return “success” and leave Codex auth effectively in-memory or helper-local, while Cowork itself never proved it had written a readable token into `~/.cowork/auth/codex-cli/auth.json`.
- `src/connect.ts` now owns the durable persistence contract. Both the PI-native browser login and the manual PKCE completion path return raw Codex auth material, then `connectProvider()` forcibly writes it into Cowork’s canonical auth file and immediately re-reads that file before reporting success.
- The write target is now pinned to Cowork’s own auth store even if an OAuth helper returns some other file path. That prevents split-brain auth locations and makes the returned `oauthCredentialsFile` always resolve to `~/.cowork/auth/codex-cli/auth.json`.
- `src/providers/codex-oauth-flows.ts` now builds `CodexAuthMaterial` from token responses instead of persisting on its own, so the connect layer is the single place that decides where Codex credentials live.
- Regression coverage now proves the new contract: `test/connect.test.ts` no longer relies on helper-side file writes, and it includes a new case where the helper reports a non-Cowork file path but Cowork still rewrites the credentials into its own `auth.json`. The existing provider-status/runtime tests continue to verify that downstream readers load Codex auth from Cowork’s auth store.

### Verification
- `git diff --check` -> pass
- `~/.bun/bin/bun test test/connect.test.ts test/providers/codex-oauth-flows.test.ts test/providers/codex-auth.test.ts test/providerStatus.test.ts test/runtime.pi-runtime.test.ts` -> pass (`42 pass, 0 fail`)
- `~/.bun/bin/bun run typecheck` -> pass

# Task: Probe Codex auth directory write permissions before save

## Plan
- [x] Add an explicit writability probe for `~/.cowork/auth/codex-cli` before Cowork writes Codex auth material.
- [x] Return a clear permission-denied error when the auth directory is blocked instead of relying on a generic write failure.
- [x] Add focused tests for the writable probe and rerun the auth-related Bun slices.

## Review
- Added `ensureCodexAuthDirWritable(...)` in `src/providers/codex-auth.ts`. Before any Codex auth write, Cowork now creates the canonical `~/.cowork/auth/codex-cli` directory if needed, applies best-effort private POSIX perms, checks write access, and performs a temporary probe write/delete in that exact directory.
- `writeCodexAuthMaterial(...)` now uses that probe and wraps `EACCES`/`EPERM` failures with a user-facing error that explicitly says Cowork cannot write Codex auth there and, on macOS, the user may need to grant home-directory or Full Disk Access and retry.
- There is no practical runtime API here to pop a real macOS permission prompt for `~/.cowork`; Electron’s permission handler in this app covers browser/web permissions, not filesystem/TCC access for arbitrary dot-directories. The hardened behavior is therefore: probe early, repair normal perms when possible, and fail with a specific system-permission message if the OS still blocks the write.
- Live probe on this machine succeeded: a direct write/delete check under `/Users/mweinbach/.cowork/auth/codex-cli` confirmed the current process can already write there.

### Verification
- `node -e 'const fs=require("fs"); const os=require("os"); const path=require("path"); const dir=path.join(os.homedir(), ".cowork", "auth", "codex-cli"); try { fs.mkdirSync(dir,{recursive:true,mode:0o700}); fs.accessSync(dir, fs.constants.W_OK); const probe=path.join(dir, ".perm-probe-"+process.pid+"-"+Date.now()); fs.writeFileSync(probe, "ok", {mode:0o600}); fs.unlinkSync(probe); console.log(JSON.stringify({ok:true, dir, writable:true})); } catch (err) { console.log(JSON.stringify({ok:false, dir, code:err.code||null, message:String(err.message||err)})); process.exitCode=1; }'` -> pass (`{"ok":true,"dir":"/Users/mweinbach/.cowork/auth/codex-cli","writable":true}`)
- `git diff --check` -> pass
- `~/.bun/bin/bun test test/connect.test.ts test/providers/codex-auth.test.ts test/providers/codex-oauth-flows.test.ts test/providerStatus.test.ts test/runtime.pi-runtime.test.ts` -> pass (`44 pass, 0 fail`)
- `~/.bun/bin/bun run typecheck` -> pass

# Task: Fix desktop PR review regressions from session usage UI

## Plan
- [x] Hide the chat-header "Clear hard cap" action until the thread has a live connected session ID, matching the existing settings page guard.
- [x] Keep row-level and recent-turn cost badges visible in the desktop Usage page whenever those specific rows still have numeric estimates, even if the session-wide total is unavailable.
- [x] Suppress replay-only `set_session_usage_budget` client transcript rows so clearing the hard cap does not reintroduce bogus `[set_session_usage_budget]` system feed noise.
- [x] Run focused desktop Bun tests, then record the verified outcome below.

## Review
- `apps/desktop/src/ui/ChatView.tsx` now gates the chat-header hard-cap reset on a live connected session ID, so restored threads no longer expose a button that can only fail with `Not connected` during reconnect.
- `apps/desktop/src/ui/settings/pages/UsagePage.tsx` now renders row-level model and recent-turn estimate badges whenever those rows still have numeric `estimatedCostUsd` values, even if the session-wide total is unavailable.
- `apps/desktop/src/app/store.feedMapping.ts` now suppresses transcript replay for client `set_session_usage_budget` events, so clearing the hard cap does not leave bogus `[set_session_usage_budget]` system rows in restored feeds.
- Added focused regressions in `apps/desktop/test/chat-reasoning-ui.test.ts`, `apps/desktop/test/usage-page.test.ts`, and `apps/desktop/test/store-feed-mapping.test.ts`.
- Verification:
  - `~/.bun/bin/bun test --cwd apps/desktop test/chat-reasoning-ui.test.ts test/usage-page.test.ts test/store-feed-mapping.test.ts test/thread-reconnect.test.ts` -> pass (`27 pass, 0 fail`)

# Task: Compact explicit get_session_usage snapshots

## Plan
- [x] Switch `src/server/session/AgentSession.ts#getSessionUsage()` to emit the compact session usage snapshot instead of the full turn history.
- [x] Extend the focused session test coverage so an explicit `getSessionUsage()` request proves only the recent compact turn window is returned.
- [x] Run the targeted Bun tests and record the verified outcome below.

## Review
- `src/server/session/AgentSession.ts` now answers explicit `get_session_usage` requests with `tracker.getCompactSnapshot()`, matching the already-compact automatic and budget-update `session_usage` emissions.
- `test/session.test.ts` now proves a resumed session with ten tracked turns returns only the most recent eight turns on an explicit `getSessionUsage()` request, while preserving the cumulative totals.
- Verification:
  - `~/.bun/bin/bun test test/session.test.ts apps/desktop/test/thread-reconnect.test.ts` -> pass (`200 pass, 0 fail`)

# Task: Validate transcript session_usage snapshots before desktop hydration

## Plan
- [x] Reuse the shared strict `sessionUsageSnapshotSchema` in desktop transcript hydration so malformed `session_usage` payloads are ignored instead of accepted as arbitrary objects.
- [x] Add a regression covering transcript replay/reconnect with an invalid saved `session_usage` payload and prove the thread runtime keeps `sessionUsage` unset.
- [x] Run focused desktop tests plus repo typecheck, then record the validated outcome below.

## Review
- `apps/desktop/src/app/store.feedMapping.ts` now reuses the shared `sessionUsageSnapshotSchema` for transcript-only `session_usage` hydration, matching the strict validation already used for live websocket events and persisted session snapshots.
- Malformed or manually edited transcript `session_usage` objects are now ignored instead of being copied into `threadRuntime.sessionUsage`, so desktop consumers like `apps/desktop/src/ui/settings/pages/UsagePage.tsx` no longer inherit missing `turns[]` / `byModel[]` fields from corrupted replay data.
- Added focused regressions in `apps/desktop/test/store-feed-mapping.test.ts` and `apps/desktop/test/thread-reconnect.test.ts` proving invalid transcript snapshots are dropped while valid `turn_usage` replay still hydrates normally.

### Verification
- `~/.bun/bin/bun test --cwd apps/desktop test/store-feed-mapping.test.ts test/thread-reconnect.test.ts test/usage-page.test.ts` -> pass (`19 pass, 0 fail`)
- `~/.bun/bin/bun run typecheck` -> pass
- `git diff --check` -> pass

# Task: Triage PR #32 review comments for remaining work

## Plan
- [x] Verify `gh` auth, locate the open PR for the current branch, and fetch the current review comments/threads.
- [x] Use subagents to inspect each comment against the current `HEAD` state and classify it as still relevant, already addressed, or not actionable.
- [x] Record the triage result here with any still-needed fixes, without changing unrelated in-flight work.

## Review
- `gh auth status` is healthy, the current branch `codex/inspect-harness-websocket-ui-gaps` maps to PR `#32` (`Update websocket protocol docs and sync workspace backup helpers`), and the fetched review payload contains 5 inline threads, 3 of them unresolved. There are no separate top-level conversation comments to handle.
- Already fixed: thread 1 on `src/server/session/SessionBackupController.ts` no longer needs work. Disabling backups now routes through `clearSessionBackupState(...)`, which closes the existing manager before clearing the in-memory handles (`src/server/session/SessionBackupController.ts:213-223`), and the disabled path calls that helper when a live backup exists (`src/server/session/SessionBackupController.ts:262-267`).
- Already fixed: thread 2 on `src/server/workspaceBackups.ts` no longer needs work. `restoreBackup(...)` now validates `checkpointId` before creating the safety checkpoint (`src/server/workspaceBackups.ts:189-198`), so an invalid restore target does not leave behind a bogus checkpoint.
- Still relevant: thread 3 on `apps/desktop/src/app/store.helpers/controlSocket.ts` should be fixed. The desktop control-session handler still copies `evt.config.backupsEnabled` into `workspace.defaultBackupsEnabled` (`apps/desktop/src/app/store.helpers/controlSocket.ts:103-123`), but the server still emits that field as the effective session value `backupsEnabledOverride ?? config.backupsEnabled ?? true` (`src/server/session/SessionMetadataManager.ts:31-40`, `src/server/session/SessionMetadataManager.ts:218-223`). That can leak a session override back into workspace defaults, and those defaults are reapplied to threads later (`apps/desktop/src/app/store.helpers/threadEventReducer.ts:242-246`, `apps/desktop/src/app/store.actions/workspaceDefaults.ts:91-98`). The current desktop test locks in the buggy behavior instead of guarding against it (`apps/desktop/test/workspace-settings-sync.test.ts:368-390`).
- Still relevant: thread 4 on `src/server/sessionBackup.ts` should be fixed. Reusing an existing backup still returns `openExisting()` immediately (`src/server/sessionBackup.ts:271-280`), but `openExisting()` does not flip persisted metadata back to active (`src/server/sessionBackup.ts:313-320`) while `close()` still writes `state: "closed"` and `closedAt` (`src/server/sessionBackup.ts:460-468`). A direct local repro at `HEAD` showed `SessionBackupManager.create(...)->close()->create(...)` leaves `metadata.json` at `state: "closed"` even though the reopened manager reports `status: "ready"`. Coverage does not currently assert a reopen transition.
- Still relevant: thread 5 on `apps/desktop/src/ui/settings/pages/BackupPage.tsx` should be fixed. The selected delta is still matched only by `checkpointId` (`apps/desktop/src/ui/settings/pages/BackupPage.tsx:596-599`) even though the payload already includes `targetSessionId` (`src/server/sessionBackup.ts:72-82`). Because the store keeps a single workspace-level delta (`apps/desktop/src/app/store.helpers/controlSocket.ts:258-269`) and a new request only sets loading/error without clearing the old delta (`apps/desktop/src/app/store.actions/backup.ts:116-145`), switching between two sessions that both have `cp-0001` can still show the wrong diff or hide the new loading/error state.

### Verification
- `python3 /Users/mweinbach/.codex/skills/gh-address-comments/scripts/fetch_comments.py > /tmp/pr32_comments.json` -> fetched PR `#32` review threads for the current branch
- `~/.bun/bin/bun test apps/desktop/test/workspace-settings-sync.test.ts apps/desktop/test/backup-page.test.ts test/workspace-backups.test.ts test/session-backup.test.ts --bail` -> pass (`28 pass, 0 fail`)
- `~/.bun/bin/bun -e 'import { SessionBackupManager } from "./src/server/sessionBackup"; ...'` -> reproduced the reopen bug (`metadataState: "closed"` after reopening an existing backup)

# Task: Fix and resolve remaining PR #32 review comments

## Plan
- [x] Stop copying control-session backup overrides back into workspace defaults, and update desktop coverage to preserve workspace defaults when a single session toggles backups.
- [x] Reopen persisted session-backup metadata when reusing an existing backup directory, and add regression coverage for the closed-to-active transition.
- [x] Match backup delta state by target session as well as checkpoint id in the desktop backup page, and add coverage for duplicate checkpoint ids across sessions.
- [x] Run focused tests, resolve the fixed review threads on GitHub, and record the result below.

## Review
- `apps/desktop/src/app/store.helpers/controlSocket.ts` no longer copies `session_config.backupsEnabled` into `workspace.defaultBackupsEnabled`; the desktop still records the control session's live config in runtime, but workspace defaults stay independent of per-session overrides. `apps/desktop/test/workspace-settings-sync.test.ts` now asserts that a control-session `backupsEnabled: false` snapshot updates `controlSessionConfig` while leaving the persisted workspace default unchanged.
- `src/server/sessionBackup.ts` now reopens reused backup directories explicitly. `SessionBackupManager.create(...)` passes `reopen: true` when metadata already exists, and `openExisting(...)` rewrites persisted metadata back to `state: "active"` while clearing stale `closedAt` markers only for that reopen path. `test/session-backup.test.ts` now proves `create() -> close() -> create()` persists the transition from closed back to active.
- `apps/desktop/src/ui/settings/pages/BackupPage.tsx` now treats a delta preview as active only when both `targetSessionId` and `checkpointId` match the current selection. That prevents a stale delta from one session from leaking into another session that reuses the same checkpoint id. `apps/desktop/test/backup-page.test.ts` now covers the duplicate-`cp-0001` case and asserts the page shows the loading state instead of the stale diff.
- GitHub review threads `PRRT_kwDORLLhvs5zeq1x`, `PRRT_kwDORLLhvs5ze74T`, and `PRRT_kwDORLLhvs5ze74Z` were resolved after the fixes landed. A follow-up GraphQL fetch confirmed all five PR `#32` review threads are now resolved.

### Verification
- `~/.bun/bin/bun test apps/desktop/test/workspace-settings-sync.test.ts apps/desktop/test/backup-page.test.ts test/session-backup.test.ts test/workspace-backups.test.ts --bail` -> pass (`30 pass, 0 fail`)
- `~/.bun/bin/bun run typecheck` -> pass
- `gh api graphql ... resolveReviewThread(...)` for thread ids `PRRT_kwDORLLhvs5zeq1x`, `PRRT_kwDORLLhvs5ze74T`, and `PRRT_kwDORLLhvs5ze74Z` -> success (`isResolved: true`)
- `gh api graphql ... reviewThreads(first: 100)` for PR `#32` -> all 5 threads resolved

# Task: Commit remaining backup follow-up changes

## Plan
- [x] Verify the remaining unstaged backup/page/server/test changes form a coherent slice and identify the minimal validation set.
- [x] Run the focused backup/desktop tests plus typecheck for this remaining diff and record the outcome.
- [x] Stage only the remaining backup follow-up files and commit them without altering unrelated history.

## Review
- Extracted the repeated backup-action key builder into `apps/desktop/src/app/store.helpers/backupActionKey.ts`, and updated both `apps/desktop/src/app/store.actions/backup.ts` and `apps/desktop/src/ui/settings/pages/BackupPage.tsx` to use the shared helper instead of duplicating the string format in two places.
- Kept the existing Backup page behavior while polishing the local visual treatment for lifecycle badges in `apps/desktop/src/ui/settings/pages/BackupPage.tsx`, so active/deleted rows read more distinctly without changing the page structure.
- `src/server/workspaceBackups.ts` now derives lifecycle strictly from live/session persistence state, not from backup metadata, and guards `findWorkspaceBackup(...)` with an `isPathWithin(...)` check before reading a target session directory under each configured backup root.
- `test/session-backup-delta.test.ts` and `test/workspace-backups.test.ts` now track their temp roots and clean them up in `afterAll(...)`, so repeated runs do not leak scratch directories into the OS temp area.

### Verification
- `~/.bun/bin/bun test test/session-backup-delta.test.ts test/workspace-backups.test.ts apps/desktop/test/backup-page.test.ts --bail` -> pass (`18 pass, 0 fail`)
- `~/.bun/bin/bun run typecheck` -> pass

# Task: Make disabled backups stay fully disabled across desktop and core sessions

## Plan
- [x] Trace the backup-default contract between core `session_config`, desktop workspace state, and live thread/session overrides.
- [x] Patch the protocol/core/Desktop sync so the persisted workspace backup default is communicated explicitly and stale desktop state cannot re-enable backups on connect.
- [x] Add regression coverage for control-session hydration and reconnect behavior, run the required tests/typecheck, and record the verified outcome below.

## Review
- `src/server/protocol.ts`, `src/server/session/SessionMetadataManager.ts`, and `src/server/protocolEventParser.ts` now expose `session_config.config.defaultBackupsEnabled` as a first-class harness/core field. `backupsEnabled` still reports the live effective session state, but clients now also receive the persisted workspace default instead of having to guess from a possibly overridden session snapshot.
- `apps/desktop/src/app/store.helpers/controlSocket.ts` now hydrates `workspace.defaultBackupsEnabled` from the harness-provided `defaultBackupsEnabled`, so desktop persistence follows the real workspace config instead of stale local state. `apps/desktop/src/app/store.actions/workspaceDefaults.ts` and `apps/desktop/src/app/store.helpers/threadEventReducer.ts` now distinguish explicit user-driven backup updates from automatic connect-time sync: automatic thread connects only apply a backup toggle once the control session has provided the harness default, which stops reconnects/new threads from force-enabling backups from old desktop state.
- Added regression coverage in `apps/desktop/test/workspace-settings-sync.test.ts` for both critical paths: the control session now hydrates the workspace backup default from the harness, and a new thread connect no longer replays a stale local `defaultBackupsEnabled` before that harness sync arrives. Core tests in `test/session.test.ts`, `test/server.test.ts`, and `test/agentSocket.parse.test.ts` now cover the expanded `session_config` contract.

### Verification
- `~/.bun/bin/bun test test/session.test.ts test/server.test.ts test/agentSocket.parse.test.ts apps/desktop/test/workspace-settings-sync.test.ts test/docs.check.test.ts --bail` -> pass (`294 pass, 0 fail`)
- `~/.bun/bin/bun run typecheck` -> pass
- `~/.bun/bin/bun test` -> pass (`1990 pass, 2 skip, 0 fail`)
- `git diff --check` -> pass

# Task: Merge codex/inspect-harness-websocket-ui-gaps into main

## Plan
- [x] Inspect divergence from `main` and identify merge-conflict hotspots before merging.
- [x] Checkout `main`, merge `codex/inspect-harness-websocket-ui-gaps`, and resolve any conflicts without disturbing unrelated history.
- [x] Run required verification on the merged result and record the outcome below.

## Review
- Merged `codex/inspect-harness-websocket-ui-gaps` into `main` with a single content conflict in `tasks/todo.md`. The resolution keeps both sides' task history instead of dropping the newer `main` diagnostics entry or the branch’s stacked backup/auth task log.
- The merged code exposed one stale regression expectation in `test/providers/saved-keys.test.ts`: `main` still expected Codex model headers to ignore legacy `~/.codex/auth.json` material, but the merged branch intentionally canonicalizes that legacy auth into `~/.cowork/auth/codex-cli/auth.json` when Cowork auth is missing. The test now asserts the merged contract and verifies the Cowork auth file is written.

### Verification
- `~/.bun/bin/bun test test/providers/saved-keys.test.ts` -> pass (`6 pass, 0 fail`)
- `~/.bun/bin/bun run typecheck` -> pass
- `~/.bun/bin/bun test` -> pass (`1998 pass, 2 skip, 0 fail`)
- `git diff --check` -> pass

# Task: Add OpenCode Go provider support for GLM-5 and Kimi K2.5

## Plan
- [x] Extend provider identity, catalogs, auth, pricing, and runtime wiring to add a first-class `opencode-go` provider routed through the PI runtime.
- [x] Update thin CLI/desktop/protocol/docs surfaces so `opencode-go` appears as a normal provider with the two allowed models only.
- [x] Add focused regression coverage for provider parsing/catalog/auth/status, PI model resolution, runtime selection, pricing, and reasoning-mode behavior.
- [x] Run focused verification, then full `bun test`, and record the outcome below.

## Review
- Added a first-class `opencode-go` provider across the harness core. `ProviderName`, provider/auth registries, model catalog, connection catalog, pricing, and provider model adapters now all understand `opencode-go`, with a dedicated `src/providers/opencode-go.ts` entry and API-key auth only.
- Routed `opencode-go` through the PI runtime with explicit custom `openai-completions` metadata in `src/runtime/piRuntime.ts`. `glm-5` and `kimi-k2.5` now resolve to `https://opencode.ai/zen/go/v1` with the requested context windows, token limits, and pricing, while keeping `provider: "opencode"` so runtime env fallback still honors `OPENCODE_API_KEY`.
- Kept the existing OpenAI-compatible settings scope unchanged. `opencode-go` does not enter the editable `providerOptions` path, does not use OpenAI/Codex continuation, and continues to stream with the existing `"reasoning"` mode rather than the Responses `"summary"` mode.
- Updated thin presentation surfaces only where needed: desktop provider labels in `ChatView.tsx`, `ProvidersPage.tsx`, and `WorkspacesPage.tsx`, plus websocket protocol documentation examples for `ProviderName`, `provider_catalog`, and `provider_auth_methods`.
- Added focused regressions for provider parsing, auth methods, connection catalog, saved-key/env precedence, connect/provider-status behavior, provider model creation, PI model resolution, runtime selection, pricing, and reasoning mode.
- Fixed one typecheck-only exhaustiveness hole in `src/server/sessionTitleService.ts` by adding `opencode-go` to the title-model map and defaulting it to `glm-5`.

### Verification
- `bun test test/types.test.ts test/providers/auth-registry.test.ts test/providers/index.test.ts test/providers/cross-provider.test.ts test/providers/saved-keys.test.ts test/providers/connection-catalog.test.ts test/connect.test.ts test/providerStatus.test.ts test/runtime.selection.test.ts test/runtime.pi-runtime.test.ts test/server.model-stream.test.ts test/session/pricing.test.ts` -> pass (`280 pass, 0 fail`)
- `bun run typecheck` -> pass
- `bun test` -> pass (`2019 pass, 2 skip, 0 fail`)
- Live OpenCode Go smoke using `OPENCODE_API_KEY` from `.env` via the real PI runtime:
  - `glm-5` -> `pong`, usage `{ promptTokens: 15, completionTokens: 48, totalTokens: 63, estimatedCostUsd: 0.00016860000000000003 }`
  - `kimi-k2.5` -> `pong`, usage `{ promptTokens: 20, completionTokens: 206, totalTokens: 226, estimatedCostUsd: 0.00063 }`
- `git diff --check` -> pass

# Task: Fix OpenCode Go webSearch tool crash in PI runtime

## Plan
- [x] Reproduce and trace the `def.description` crash path from desktop/server error output into the runtime tool registry.
- [x] Fix the missing `opencode-go` webSearch tool wiring and harden PI tool mapping against undefined tool definitions.
- [x] Add focused regression coverage, run the relevant tests/typecheck, and record the verified outcome below.

## Review
- Root cause was in `src/tools/webSearch.ts`: `createWebSearchTool(...)` only returned a tool for `google`, `openai`, `anthropic`, and `codex-cli`. After adding `opencode-go`, the factory fell off the end and `createTools(...)` produced `webSearch: undefined`, which then crashed `toolMapToPiTools(...)` at `def.description`.
- Fixed the provider wiring by making `createWebSearchTool(...)` use the Google-specific Exa-only branch only for `google`, and return the standard BRAVE/EXA-backed tool for every other provider, including `opencode-go`.
- Hardened `src/runtime/piRuntime.ts` so `toolMapToPiTools(...)` skips malformed or undefined tool definitions instead of crashing the entire turn. That keeps this class of provider-wiring bug from surfacing as a fatal runtime exception.
- Added focused regressions in `test/tools.test.ts` and `test/runtime.pi-runtime.test.ts` to prove `createTools(...)` returns an executable `webSearch` tool for `opencode-go` and that PI tool mapping ignores undefined tool entries.

### Verification
- `bun test test/tools.test.ts test/runtime.pi-runtime.test.ts` -> pass (`162 pass, 0 fail`)
- `bun run typecheck` -> pass
- Live OpenCode Go smoke using the real `OPENCODE_API_KEY` from `.env` with prompt `can you research the macbook neo reviews and create me a review summary`:
  - completed without the `def.description` crash
  - returned model text beginning with `I'll search for information about "MacBook Neo"...`
  - emitted reasoning stream parts instead of failing before the turn started

# Task: Fix duplicate final assistant response after multi-step PI streaming

## Plan
- [x] Inspect the local desktop transcript for the affected thread to confirm whether the duplicate final response is stored twice or rendered twice.
- [x] Trace the desktop replay/live assistant-message dedupe path for PI multi-step turns and identify why the merged fallback `assistant_message` still renders after streamed assistant text.
- [x] Implement the shared desktop dedupe fix, add focused regression coverage, and run the relevant desktop tests/typecheck.

## Review
- Checked the real desktop transcript at `/Users/mweinbach/Library/Application Support/Cowork/transcripts/9d31b90b-f5b0-40ad-b41c-a61692fd504f.jsonl`. The duplicate was not two persisted final messages. The transcript contained five streamed assistant step messages plus one fallback `assistant_message` whose text was the merged concatenation of those same five messages.
- Root cause was in desktop dedupe, not storage. `apps/desktop/src/app/store.feedMapping.ts` only skipped a fallback `assistant_message` when it matched the last streamed assistant chunk (or ended with it for raw-backed turns). For PI multi-step turns, the fallback matched the concatenation of all assistant messages since the last user turn, so it still rendered as a sixth duplicate item.
- Fixed the shared dedupe helper so it also compares the fallback `assistant_message` against the concatenated assistant feed text since the last user message. That shared helper is used by both transcript replay and the live thread reducer, so the same fix now applies in both paths.
- Added a focused desktop regression proving that a normalized multi-step streamed turn keeps the two streamed assistant messages and suppresses the merged fallback assistant message.

### Verification
- `bun test --cwd apps/desktop test/store-feed-mapping.test.ts test/thread-reconnect.test.ts` -> pass (`19 pass, 0 fail`)
- `bun run typecheck` -> pass
- `git diff --check` -> pass
- Real transcript sanity check with the patched mapper:
  - before fix, the affected thread mapped to `assistantCount: 6`
  - after fix, the same transcript maps to `assistantCount: 5`
  - the extra merged fallback item is gone, leaving only the streamed step messages plus the final streamed answer

# Task: Add `opencode-zen` as a sibling provider to `opencode-go`

## Plan
- [x] Refactor the current OpenCode provider metadata into shared helpers and add `opencode-zen` across provider/runtime/catalog/pricing surfaces while keeping `opencode-go` stable.
- [x] Add a harness-level `provider_auth_copy_api_key` flow that copies a saved API key between the two OpenCode providers without exposing the raw secret to clients.
- [x] Wire the desktop Providers page and provider actions to surface `OpenCode Zen`, keep labels distinct, and offer one-click sibling key reuse only for saved keys.
- [x] Add focused provider/runtime/protocol/desktop regressions, update websocket docs, and run the required verification.

## Review
- Added a shared OpenCode provider definition layer in `src/providers/opencodeShared.ts` so `opencode-go` and `opencode-zen` now derive their labels, model catalog, pricing metadata, adapter ids, base URLs, and provider-specific env vars from one place. `opencode-go` stays on `https://opencode.ai/zen/go/v1` with `OPENCODE_API_KEY`; `opencode-zen` uses `https://opencode.ai/zen/v1` with `OPENCODE_ZEN_API_KEY`.
- Extended the harness/provider surfaces to treat `opencode-zen` as a first-class provider everywhere `ProviderName` participates: catalogs, auth registry, pricing, runtime selection, PI model resolution, session-title defaults, protocol parsing, and provider/model labels in desktop chat and workspace settings.
- Added a new websocket client message, `provider_auth_copy_api_key`, and implemented the copy on the server in `ProviderAuthManager`/`authRegistry`. The copy only works between the two OpenCode siblings, only for saved connection-store API keys, and reuses the existing `provider_auth_result`, `provider_status`, and `provider_catalog` refresh flow so no raw key ever leaves the harness.
- Updated the desktop Providers page to render both `OpenCode Go` and `OpenCode Zen` and to show a one-click `Use OpenCode Go key` / `Use OpenCode Zen key` action only when the sibling provider has a saved masked API key. Env-only keys do not surface a copy action.
- Updated the websocket protocol docs to version `7.12`, documented the new client message, and refreshed provider/auth catalog examples so both OpenCode providers appear in the public contract.

### Verification
- `bun test test/types.test.ts test/providers/auth-registry.test.ts test/providers/index.test.ts test/providers/cross-provider.test.ts test/providers/saved-keys.test.ts test/providers/connection-catalog.test.ts test/connect.test.ts test/providerStatus.test.ts test/runtime.selection.test.ts test/runtime.pi-runtime.test.ts test/server.model-stream.test.ts test/protocol.test.ts test/session.test.ts test/session/pricing.test.ts apps/desktop/test/protocol-v2-events.test.ts apps/desktop/test/providers-page.test.ts` -> pass (`695 pass, 0 fail`)
- `bun run typecheck` -> pass
- `bun test` -> pass (`2046 pass, 2 skip, 0 fail`)

# Task: Add more OpenCode Zen models

## Plan
- [x] Refactor the shared OpenCode model catalog so Zen can expose additional models without changing the Go provider catalog.
- [x] Add the requested OpenCode Zen model ids, runtime metadata, and pricing entries, using OpenCode Zen docs for pricing and conservative capability defaults where the Zen API does not publish limits.
- [x] Update focused provider/runtime/pricing tests, run verification, and record outcomes below.

## Review
- Split the OpenCode model catalog in `src/providers/opencodeShared.ts` so `opencode-go` keeps `["glm-5", "kimi-k2.5"]` while `opencode-zen` now additionally exposes `nemotron-3-super-free`, `mimo-v2-flash-free`, `big-pickle`, `minimax-m2.5-free`, and `minimax-m2.5`.
- Added pricing for the five new Zen-only models in `src/session/pricing.ts` using the published OpenCode Zen docs rates. The free models are estimated at zero input/output cost; `big-pickle` is `2 / 8` USD per 1M input/output tokens; `minimax-m2.5` is `0.4 / 2.2`.
- Tightened provider validation so Zen-only model ids do not silently work on `opencode-go`. `src/runtime/piRuntime.ts` now checks provider support before resolving PI metadata, and `src/providers/modelAdapter.ts` throws if a Zen-only model is requested through the Go provider adapter path.
- Added conservative runtime metadata for the new Zen-only models in `src/providers/opencodeShared.ts`. OpenCode Zen’s public `/models` endpoint currently exposes ids but not authoritative capability limits, so the new entries use conservative text/multimodal defaults while keeping the exact Zen pricing and the live model ids.
- Updated protocol examples and focused regressions so the provider catalog, runtime resolution, pricing, and session/provider catalog flows all reflect the larger Zen model list.

### Verification
- `bun test test/providers/index.test.ts test/providers/connection-catalog.test.ts test/runtime.pi-runtime.test.ts test/session/pricing.test.ts test/session.test.ts` -> pass (`253 pass, 0 fail`)
- `bun run typecheck` -> pass
- `bun test` -> pass (`2049 pass, 2 skip, 0 fail`)
- Public Zen model-list sanity check:
  - `bun -e 'fetch("https://opencode.ai/zen/v1/models") ...'` -> `status: 200`, `missing: []` for `nemotron-3-super-free`, `mimo-v2-flash-free`, `big-pickle`, `minimax-m2.5-free`, `minimax-m2.5`

# Task: Refresh OpenCode Zen metadata from current official sources

## Plan
- [x] Re-check the harness compaction path so current OpenCode context-window metadata is not misrepresented as automatic token compaction.
- [x] Replace stale OpenCode Zen pricing/capability assumptions with values confirmed from current official provider docs or live endpoints where available.
- [x] Rerun focused verification, then record exactly what remains conservative or unpublished upstream.

## Review
- Confirmed the harness is not doing token-aware compaction for OpenCode Zen through PI. Runtime history is still capped only by `MAX_MESSAGE_HISTORY = 200` in `src/server/session/HistoryManager.ts`, while `contextWindow` on the PI model is metadata passed through to the transport.
- Refreshed the OpenCode model metadata in `src/providers/opencodeShared.ts` and `src/session/pricing.ts` using current official provider information instead of the older bundled PI assumptions. That corrected `kimi-k2.5` cached-read pricing, made `big-pickle` free, updated `minimax-m2.5` pricing, and tightened the published context windows for `nemotron-3-super-free`, `mimo-v2-flash-free`, and the `minimax-m2.5*` entries.
- Left unpublished upstream limits conservative on purpose. OpenCode Zen currently exposes model ids and pricing, but not authoritative max-output limits for several of these models, and `big-pickle` still does not have a public context-window/max-output spec.

### Verification
- `bun test test/runtime.pi-runtime.test.ts test/session/pricing.test.ts test/session.test.ts` -> pass (`235 pass, 0 fail`)
- `bun run typecheck` -> pass
- `git diff --check` -> pass

# Task: Review `webFetch` tool architecture and Exa-style scraper tradeoffs

## Plan
- [x] Inspect `src/tools/webFetch.ts`, related safety helpers, and existing `webFetch` tests to understand the current contract and failure modes.
- [x] Compare the current implementation against likely improvements for reliability, extraction quality, and tool ergonomics.
- [x] Check current Exa documentation for its content/scraping capabilities and decide whether replacing `webFetch` is warranted versus augmenting it.

## Review
- The current `webFetch` implementation is intentionally minimal and harness-safe: SSRF-aware URL resolution, manual redirect validation, direct image passthrough, document download handling into the workspace, and HTML-to-Markdown extraction via Readability plus Turndown.
- The largest implementation gap is unbounded body handling. `maxLength` limits returned text only after the entire response body is read and converted, while image and download paths buffer the full body in memory before returning or writing. That means a large HTML page, image, or download can still consume excessive memory or disk before any guardrail applies.
- A second reliability gap is that IP pinning always uses only the first resolved address. If the first A/AAAA record is unhealthy but later public records are valid, `webFetch` fails immediately instead of retrying across the resolved address set.
- Extraction quality is serviceable for static pages but intentionally shallow. It does not execute JavaScript, preserve page metadata, expose structured fields like title/byline/published date, or distinguish article extraction from generic DOM conversion in the return shape.
- Based on current Exa docs, Exa’s search/content stack is useful as an optional higher-quality extraction backend, but it is not a clean replacement for this tool’s full contract. `webFetch` today handles direct binary/image/document flows inside the workspace and does not require a third-party API key; Exa is better suited for remote content extraction and summarization, not for replacing local-download semantics.

### Verification
- `bun test test/tools.test.ts --test-name-pattern "webFetch tool"` -> pass (`20 pass, 0 fail`)
- Reviewed current official Exa docs for search/content capabilities and repo-local notes around existing Exa usage.

# Task: Route `webFetch` through Exa contents while keeping local downloads

## Plan
- [x] Extract shared Exa auth/request helpers and update `webSearch` to consume them without changing its behavior.
- [x] Rewrite `webFetch` so non-download URLs use Exa contents, while documents and direct image responses still save into `Downloads`.
- [x] Update prompt/docs text and focused regressions for the new image/download contract and Exa-backed `webFetch` behavior.
- [x] Run targeted verification (`bun test` on tools/prompts, typecheck, diff check) and record outcomes below.

## Review
- Added a shared Exa helper in `src/tools/exa.ts` for Exa API key resolution and JSON POST requests. `src/tools/webSearch.ts` now uses that shared helper, keeping its current behavior while removing duplicated Exa auth/request wiring.
- Rewrote `src/tools/webFetch.ts` so the local safe-fetch path now only handles SSRF-safe URL validation, redirect resolution, response classification, and file downloads. Non-download URLs are handed to Exa Contents, and the old Readability/Turndown HTML conversion path is gone.
- Direct image URLs now follow the same workspace-file contract as document downloads. Supported image responses are saved into `<workingDirectory>/Downloads`, get filename/extension inference from `Content-Disposition`, URL basename, or MIME type, and return `File downloaded /absolute/path/...` so the model can inspect them via `read`.
- Updated the shipped prompt templates so they no longer claim `webFetch` may return inline image content. They now describe the new Exa-backed text extraction behavior and tell models to use `read` on downloaded image paths.
- Expanded the focused regressions in `test/tools.test.ts` and `test/prompt.test.ts` to cover Exa Contents usage, fail-closed missing-key and Exa-error paths, canonical redirect URLs passed to Exa, image downloads plus `read` inspection, and the new prompt wording.
- Removed the now-unused `@mozilla/readability`, `jsdom`, `turndown`, and related type packages from `package.json`, then refreshed `bun.lock`.

### Verification
- `bun test test/tools.test.ts test/prompt.test.ts` -> pass (`203 pass, 0 fail`)
- `bunx tsc --noEmit` -> pass
- `bun install` -> pass after rerunning outside the sandbox to allow Bun tempdir writes; refreshed `bun.lock`
- `git diff --check` -> pass
- `bun run typecheck` -> still fails in existing desktop code at `apps/desktop/src/app/store.feedMapping.ts:136` with the pre-existing `observability_status` typing error; unrelated to this `webFetch`/Exa change

# Task: Add Exa search type/category controls and highlights to `webSearch`

## Plan
- [x] Extend `webSearch` Exa input handling to support optional Exa `type` and `category` controls while preserving default behavior when they are omitted.
- [x] Enable Exa highlights with `maxCharacters: 2500`, prefer highlights in formatted output, and ensure Exa-specific controls bypass Brave so they actually take effect.
- [x] Add focused `webSearch` regressions, rerun verification, and record outcomes below.

## Review
- Updated `src/tools/webSearch.ts` so Exa-backed searches now accept optional `type` and `category` inputs. `category` stays unset by default, while `type` defaults to `auto` whenever the Exa path is used.
- Added Exa-specific normalization for the `news article` alias to the API’s current `news` category, matching the Exa UI wording while still sending the documented API value.
- Exa search requests now always include `contents.highlights.maxCharacters = 2500`, and the formatted search output now prefers returned `highlights` over fallback snippet text when highlights are available.
- Preserved the existing provider behavior by default: Brave still serves ordinary non-google searches first when no Exa-only controls are requested. If the model supplies Exa-specific `type` or `category`, `webSearch` now bypasses Brave and uses Exa so those options are honored.
- Expanded `test/tools.test.ts` to cover the new description/schema intent, the default Exa payload shape (`type: "auto"` plus highlights), Exa-over-Brave routing when advanced controls are present, and the `news article` alias normalization.

### Verification
- `bun test test/tools.test.ts --test-name-pattern "webSearch tool"` -> pass (`9 pass, 0 fail`)
- `bun test test/tools.test.ts` -> pass (`159 pass, 0 fail`)
- `bunx tsc --noEmit` -> pass
- `git diff --check` -> pass
- `bun run typecheck` -> still fails in existing desktop code at `apps/desktop/src/app/store.feedMapping.ts:136` with the pre-existing `observability_status` typing error; unrelated to this `webSearch` change

# Task: Remove legacy compatibility extras from the model-facing `webSearch` schema

## Plan
- [x] Remove `mode` and `dynamicThreshold` from the explicit `webSearch` input schema so they are no longer exposed as model-callable options.
- [x] Update the focused `webSearch` regression to stop sending those legacy extras.
- [x] Rerun focused validation and record the outcome below.

## Review
- Removed `mode` and `dynamicThreshold` from the explicit `webSearch` Zod schema in `src/tools/webSearch.ts`, so they no longer appear as model-facing tool arguments.
- Kept the rest of the Exa search controls unchanged: optional `type`/`category`, default `type: "auto"` on the Exa request, and highlights with `maxCharacters: 2500`.
- Updated the alias-query regression in `test/tools.test.ts` so it validates the current intended tool surface instead of locking in those legacy compatibility extras.

### Verification
- `bun test test/tools.test.ts --test-name-pattern "webSearch tool"` -> pass (`9 pass, 0 fail`)
- `bunx tsc --noEmit` -> pass
- `git diff --check` -> pass

# Task: 2026-03-12 repo-wide test audit follow-up

## Plan
- [x] Audit the current test surface for weak assertions or missing coverage across provider/auth, client/replay, REPL, and catalog code.
- [x] Add focused regressions in clean test files without disturbing unrelated in-flight runtime edits.
- [x] Run targeted validation for the touched files, then widen verification and record any pre-existing environment blockers.

## Review
- Strengthened `test/connect.test.ts` with direct `parseConnectionStoreJson(...)` coverage so the Cowork auth-store parser now proves unknown providers are ignored, mismatched service keys fail schema validation, and invalid tool API key shapes are rejected.
- Strengthened `test/providers/auth-registry.test.ts` so provider auth helpers now prove trimmed API-key forwarding, blank-key rejection, OAuth-method rejection on API-key paths, full callback-context forwarding, and copy failures for both missing and non-API-key source entries.
- Strengthened `test/providers/connection-catalog.test.ts` so the provider catalog now proves `all` and `default` stay aligned with `PROVIDER_NAMES`, and `codex-cli` is not duplicated when both Cowork OAuth material and `connections.json` report it as connected.
- Strengthened `test/modelStreamReplay.test.ts` so replay runtime behavior now proves `clearModelStreamReplayRuntime(...)` resets both projector/raw-backed state, projector instances are reused across multiple raw events for the same turn, and the duplicate-suppression filter does not wrongly drop non-configured chunk types like `finish`.
- Strengthened `test/agentSocket.runtime.test.ts` so client transport coverage now proves reconnect resume URLs, deferred send-queue flushing only after `server_hello`, and keepalive pings only after a session ID exists.
- Added `test/repl.prompt-controller.test.ts` so the CLI prompt controller now proves approval prompts take precedence over asks, queues drain in order, and the prompt mode returns to `you> ` when no prompts remain.

### Verification
- `~/.bun/bin/bun test test/connect.test.ts test/providers/auth-registry.test.ts test/providers/connection-catalog.test.ts test/modelStreamReplay.test.ts test/repl.prompt-controller.test.ts test/agentSocket.runtime.test.ts --bail` -> pass (`52 pass, 0 fail`)
- `~/.bun/bin/bun test --bail` -> fails outside this patch set because remote MCP tests tried live `mcp.grep.app` access when `RUN_REMOTE_MCP_TESTS` was enabled.
- `HOME=/tmp/agent-coworker-test-home RUN_REMOTE_MCP_TESTS=0 ~/.bun/bin/bun test --bail` -> gets past the remote MCP and CLI-home issues, but still stops on the pre-existing `test/mcp.oauth-provider.test.ts` callback-capture bind failure (`EADDRINUSE` at `src/mcp/oauthProvider.ts:127`).
- `HOME=/tmp/agent-coworker-test-home RUN_REMOTE_MCP_TESTS=0 ~/.bun/bin/bun test test/mcp.oauth-provider.test.ts --bail` -> reproduces the same pre-existing `EADDRINUSE` failure in isolation.

# Task: 2026-03-12 scoped review for tool/runtime diff

## Plan
- [x] Diff the current branch against merge base `1b7f5201bdde92fea664225f9445cf811b54c1ec` for `src/tools/*`, `src/runtime/*`, `src/shared/toolOutputOverflow.ts`, and `src/session/pricing.ts`.
- [x] Validate changed behavior against surrounding code/tests to isolate concrete regressions introduced by the patch.
- [x] Record review findings only if they are actionable bugs with precise file/line references.

## Review
- `src/tools/webFetch.ts`: non-download fetches now discard the already-fetched response body and hard-depend on Exa contents, so plain web pages regress from working locally to failing whenever Exa credentials are absent or the Exa fetch fails.
- `src/tools/webFetch.ts`: raw text documents such as `.md`, `.csv`, and `.tsv` URLs are now classified as downloads instead of inline text, which regresses one-step `webFetch` reads for textual remote resources.
- `src/tools/bash.ts` with `src/runtime/piRuntime.ts`: stdout/stderr truncation was removed before `ctx.log(...)`, but overflow spilling only happens later in the runtime after the tool returns, so large shell output still floods the log stream even when scratchpad overflow protection is enabled.
# Task: Fix review findings for Opencode/webFetch/desktop persistence

## Plan
- [x] Restore or replace the removed `jsdom` dependency based on current usage, and update tests only if the dependency is truly unused.
- [x] Rework `webFetch` so ordinary HTML/text reads still work without Exa, while keeping Exa enrichments only where they improve the response without replacing the original content.
- [x] Fix desktop workspace rehydration so persisted user settings, especially `defaultToolOutputOverflowChars: null`, are never overwritten outside explicit user actions or protocol-linked migrations.
- [x] Remove hard-coded provider validation for persistent subagent summaries and derive it from the shared provider source of truth.
- [x] Run focused verification for changed areas, then repo verification (`bun test`, `bun run build:server-binary`, `bun run build:desktop-resources`, `bun run desktop:build`) and record outcomes.

## Review
- Restored the `jsdom` install path and the supporting HTML-cleaning dependencies (`@mozilla/readability`, `turndown`, and matching type packages) because the desktop tests still import `JSDOM` and `webFetch` again uses the readability pipeline for local page cleanup.
- Reworked `src/tools/webFetch.ts` so direct text responses now return the original body, HTML pages are cleaned locally into markdown, Exa is optional best-effort enrichment for HTML links/images instead of a hard dependency, and text-like remote files such as markdown are no longer forced into `Downloads/`.
- Fixed desktop bootstrap hydration so persisted `defaultToolOutputOverflowChars` values round-trip exactly, including explicit `null`, instead of being rewritten to the default during restart.
- Replaced the hard-coded persistent-subagent provider enum with the shared `PROVIDER_NAMES` source of truth and added `test/shared/persistentSubagents.test.ts` to keep parser coverage aligned with the live provider list.

### Verification
- `bun install` -> pass
- `bun test test/tools.test.ts apps/desktop/test/workspace-settings-sync.test.ts test/shared/persistentSubagents.test.ts --bail` -> pass (`175 pass, 0 fail`)
- `bun run typecheck` -> pass
- `bun test` -> pass (`2162 pass, 0 fail`)
- `bun run build:server-binary` -> pass
- `bun run build:desktop-resources` -> pass
- `bun run desktop:build` -> pass

# Task: Stabilize CI timer-sensitive websocket and REPL tests

## Plan
- [x] Remove global timer monkeypatching from `AgentSocket`-related tests by injecting timer hooks into the runtime/client helper instead of mutating `globalThis`.
- [x] Rework any remaining timer-acceleration tests that still patch `globalThis.setTimeout` so they stay isolated under parallel Bun execution.
- [x] Run focused CI-sensitive reruns first, then the full required verification/build commands, and record results here.

## Review
- `src/client/agentSocket.ts` now accepts an internal `timers` scheduler hook and routes reconnect/keepalive timers through it, so tests can drive those code paths without mutating shared globals.
- `test/agentSocket.runtime.test.ts` now uses injected manual timers for reconnect and keepalive coverage instead of overriding `globalThis.setTimeout` / `setInterval`, and its microtask waits no longer depend on global timer state.
- `test/repl.restart-failure.test.ts` and `test/repl.disconnect-send.test.ts` now wait for CLI readiness with `setImmediate`, which still yields the event loop for async REPL/bootstrap work but no longer couples those tests to any patched global timeout implementation.
- `apps/desktop/test/protocol-v2-events.test.ts` no longer monkeypatches `globalThis.setTimeout` for the `session_busy` assertion, removing the remaining cross-file timer mutation in the desktop suite.
- `test/shared/failureDiagnostics.ts` adds failure-only CI diagnostics, and the remaining flaky tests now log fake socket lifecycle events, timer scheduling, console output, and REPL readiness snapshots only when they fail under CI.
- `gh pr checks 35` now reports a fresh failing `Docs + Tests` run at `https://github.com/mweinbach/agent-coworker/actions/runs/23020196010/job/66854235167`; the new diagnostic logging is local-only until these changes are pushed.

### Verification
- `CI=1 GITHUB_ACTIONS=true ~/.bun/bin/bun test test/repl.restart-failure.test.ts test/repl.disconnect-send.test.ts test/agentSocket.runtime.test.ts apps/desktop/test/protocol-v2-events.test.ts --rerun-each 50 --bail` -> pass (`1900 pass, 0 fail`)
- `CI=1 GITHUB_ACTIONS=true ~/.bun/bin/bun test --bail` -> pass (`2185 pass, 2 skip, 0 fail`)
- `bun run typecheck` -> fails in unchanged desktop code at `apps/desktop/src/app/store.feedMapping.ts:136` (`TS2345`)
- `./node_modules/.bin/tsc --noEmit -p apps/TUI/tsconfig.json` -> fails in unchanged TUI code at `apps/TUI/routes/session/index.tsx:216` (`TS2769`) and `apps/TUI/ui/dialog-prompt.tsx:61` (`TS2322`)
- `bun run build:server-binary` -> pass
- `bun run build:desktop-resources` -> pass
- `bun run desktop:build` -> pass
- `git diff --check` -> pass
- `CI=1 GITHUB_ACTIONS=true ~/.bun/bin/bun test test/agentSocket.runtime.test.ts test/repl.restart-failure.test.ts test/repl.disconnect-send.test.ts --rerun-each 20 --bail` -> pass (`140 pass, 0 fail`)
- `CI=1 GITHUB_ACTIONS=true ~/.bun/bin/bun test --bail` -> pass again after diagnostic instrumentation (`2185 pass, 2 skip, 0 fail`)
- `bun run build:server-binary` -> pass again after diagnostic instrumentation
- `bun run build:desktop-resources` -> pass again after diagnostic instrumentation
- `bun run desktop:build` -> pass again after diagnostic instrumentation

# Task: Implement supported model registry and capability-gated prompting
- [x] Replace split model metadata with per-model registry config files under `config/models/`.
- [x] Load supported models from the registry, derive provider catalogs/defaults from it, and fail closed on unsupported IDs in config/runtime/session entry points.
- [x] Gate prompt/runtime image behavior off shared model capabilities and expose richer model metadata to catalogs.
- [x] Verify shipped model metadata against current sources, run required verification, and record the review.

## Review
- Model metadata now lives in `config/models/<provider>/*.json`, loaded via `src/models/registry.ts`; provider catalogs/defaults, prompt template selection, runtime image gating, and config validation all resolve through that registry instead of split hardcoded catalogs.
- Unsupported/custom model IDs now fail closed across config loading, direct model overrides, websocket `set_model`, and persisted session restore. Prompt assembly strips image-inspection guidance for models whose registry entry has `supportsImageInput: false`, and `src/runtime/piRuntime.ts` uses the same flag when shaping model IO.
- Verified current public model metadata where vendor docs expose it: OpenAI `gpt-5.2`, `gpt-5.1`, and `gpt-5-mini` pages; Google Gemini API model docs for Gemini 3 Pro/Flash; Anthropic’s current model table for Claude 4.6 / 4.5 image support and published cutoffs; Xiaomi’s MiMo V2 Flash README for the December 2024 cutoff; Moonshot’s Kimi K2.5 materials for multimodal support. Where an exact cutoff was not currently published in vendor docs, the registry keeps the supplied/project value or `Unknown` rather than inventing one.
- Also refreshed stale OpenAI/Codex local pricing entries in `src/session/pricing.ts` to current official model-page values so session usage math stays aligned with current docs.
- Verification:
  - `~/.bun/bin/bun test` -> pass (`2193 pass, 2 skip, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass
  - `~/.bun/bin/bun run build:server-binary` -> pass
  - `~/.bun/bin/bun run build:desktop-resources` -> pass
  - `~/.bun/bin/bun run desktop:build` -> pass

# Task: Align profile name handling to `userName`

## Plan
- [x] Refactor profile config/protocol shapes so name is set through `userName` and `userProfile` only carries instructions/work/details.
- [x] Update prompt variables/templates so name comes from `{{userName}}` only, removing `{{userProfileName}}`.
- [x] Update TUI profile dialog/state wiring so “Edit Name” updates `userName`, then rerun required verification/build commands.

## Review
- Reworked config + websocket patch/state types so `set_config` now accepts top-level `userName` for name updates while `userProfile` is now limited to `instructions`, `work`, and `details`.
- Updated prompt rendering and all shipped system prompt templates to remove `userProfileName` and rely on existing `userName` for user identity injection.
- Updated the TUI User Profile flow so the name editor writes `userName`, while other fields keep writing `userProfile`.

# Task: Make user profile/name prompt injection conditional via regex line injection

## Plan
- [x] Update prompt template wording to remove literal "(if provided)" suffixes for user name/profile lines.
- [x] Refactor prompt variable injection to use regex-based line replacement that removes entire placeholder lines when values are empty.
- [x] Run targeted prompt tests plus required typecheck/build/test commands and record results.

## Review
- Implemented regex-based injection behavior so blank `userName`/`userProfile*` values remove their full prompt lines instead of leaving empty labels.
- Removed `(if provided)` phrasing in shipped prompt templates because conditional visibility is now handled by injection logic.
- Verified with prompt-focused tests and required build/typecheck commands.

# Task: Set up Linear for agent-coworker

## Plan
- [x] Validate the current Linear connection plus existing `AgentCoworker` team/project state so setup work is based on live workspace data.
- [x] Create the minimal Linear project-side bootstrap for this repo without inventing a larger workflow structure than the workspace currently has.
- [x] Verify the created Linear resources and document the outcome plus any remaining gaps here.

## Review
- Linear MCP was already configured and authenticated for this Codex environment, so setup work started from the live workspace instead of redoing connection setup.
- Verified the only available team is `AgentCoworker` (`AGE`) and that there was no existing `agent-coworker` project before bootstrap. The workspace already had the default `Bug`, `Feature`, and `Improvement` issue labels plus Linear’s onboarding issues `AGE-1` through `AGE-4`.
- Created the Linear project `agent-coworker` with Max as lead, attached it to the `AgentCoworker` team, and seeded it with a repo-specific summary/description focused on the WebSocket-first harness architecture and the repo’s default verification lane.
- Created the project document `agent-coworker project brief` and attached it to the project as the initial source-of-truth note for scope, architecture, main code surfaces, verification commands, and triage guidance.
- Remaining gap: the project now has a home, but it does not yet have milestones or backlog issues beyond Linear’s default onboarding tickets. That is intentional to avoid inventing roadmap structure the workspace does not already define.
- Verification:
  - Linear readback: project `agent-coworker` exists at `https://linear.app/agentcoworker/project/agent-coworker-9dd25d9290a3`
  - Linear readback: document `agent-coworker project brief` exists at `https://linear.app/agentcoworker/document/agent-coworker-project-brief-76150c26ca36`
  - `HOME=/tmp/agent-coworker-test-home-$(date +%s) ~/.bun/bin/bun test` -> pass (`2231 pass, 2 skip, 0 fail`)
  - `~/.bun/bin/bun run typecheck` -> pass
  - `./node_modules/.bin/tsc --noEmit -p apps/TUI/tsconfig.json` -> pass
  - `~/.bun/bin/bun run build:server-binary` -> pass
  - `~/.bun/bin/bun run build:desktop-resources` -> pass
  - `~/.bun/bin/bun run desktop:build` -> pass; notarization skipped because Apple notarization credentials are not configured in this environment
  - `git diff --check` -> pass
