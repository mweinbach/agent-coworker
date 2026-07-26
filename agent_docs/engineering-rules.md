# Engineering Rules

Durable rules distilled from past user corrections. Load this file for PR work, multi-step features, and bug fixes. When the user corrects you, distill the pattern into a rule and add it here.

## Workflow

- Plan non-trivial tasks (3+ steps or architectural decisions) before implementing; if something goes sideways, stop and re-plan instead of pushing forward.
- Use subagents for research, exploration, and parallel analysis to keep the main context clean; one task per subagent.
- Bug reports: just fix them. Point at logs, errors, failing tests, then resolve. No hand-holding, no context switching required from the user — including failing CI.
- Prefer the elegant solution over the hacky one for non-trivial changes; skip this for simple, obvious fixes.
- Simplicity first; find root causes, no temporary fixes; touch only what's necessary.
- Task management: write a plan with checkable items (todo/tasks tool), verify the plan before implementing, mark items complete as you go, summarize changes at each step.

## PR Review Workflow

- Re-fetch unresolved review threads and verify each comment against current `HEAD` before editing — don't assume an open thread is still real.
- After fixing locally, reply on each addressed GitHub thread and resolve it in the same pass.
- Re-scan the latest SHA for both unresolved threads AND newer top-level review bodies before declaring PR feedback handled.
- When the user asks for subagent verification, spawn one targeted subagent per reported issue before editing — never batch.
- When the user explicitly stops automation or delegation, delete the automation, stop delegated work, and finish in the current primary thread without spawning or resuming agents.
- Before claiming a comment is fixed, re-check the exact current branch path it points at.
- Inspect the latest GitHub Actions run when babysitting a PR; flaky lanes (e.g. remote MCP smoke) can still be the real blocker after comments resolve.
  - References: `.github/workflows/ci.yml` (main lane), plus `desktop-release.yml`, `cowork-server-release.yml`, `win-sandbox-release.yml`
- Cap review at one independent pass plus one verification pass; once findings are fixed and CI is green, merge instead of repeatedly re-reviewing unchanged code.

## Scope & Plan Discipline

- For screenshot-driven visual bugs, identify the exact affected control before changing adjacent app chrome or behavior.
- Keep Task mode explicit and separate from standard chat: never auto-promote chats into tasks, auto-wrap chats in task state, or expose task-owned sessions in ordinary chat listings. (See `repo-contracts.md` → Task mode.)
- When the user narrows a contract, apply that exact direction; don't preserve broader backward-compat assumptions.
- When the user excludes an artifact type for delivery, remove it from the final output and any PR metadata instead of keeping it as optional context.
- When the user excludes screenshots or recordings from a PR, keep the PR body text-only and summarize verification in prose.
- When the user expands scope mid-task ("include the failures you found"), treat every surfaced error as in-scope.
- When cleaning unrelated local diffs, never revert adjacent user-wanted changes without confirming intent.
- Carry user-added requirements (commit trailers, contract changes) forward into the plan and the eventual commit message.
- When the user requests commit-and-push cadence, commit each verified logical slice with a Conventional Commit and push it before starting the next slice.
- When the user explicitly accepts a change ("delete the workflow"), execute that — don't keep refining the prior approach.
- Confirm the active branch is rebased on current `origin/main` before stacking multi-commit work; if `main` moved mid-feature, rebase before more branch work.
- When the user says a surface is "retired" or "archived", do the full deletion in one pass: code, tests, docs, entrypoints, now-unused deps. No dormant compatibility shells.
- When the user asks to push a new build for this repo, treat it as a version bump plus release tag unless they explicitly ask for a no-op CI trigger.

## Verification Before Done

- Never mark a task complete without proving it works: run tests, check logs, demonstrate correctness.
- Run the same lane CI runs (`bun run test` plus `bun run typecheck` and `bun run docs:check`); cross-file Bun module mocks can pass in isolation and still fail in the full suite. Always run the full project test command, not just specific tests.
  - References: `scripts/run_tests.ts`, `packages/harness/src/check_docs.ts`
- For desktop UI changes, verify the live running app via the Playwright/CDP workflow with `COWORK_ELECTRON_REMOTE_DEBUG=1`. Tests alone are not proof. (See `desktop-ui.md` → Electron tooling.)
- For Expo mobile changes, run an explicit Metro bundle path (e.g. `expo export`) — `run:ios`/`run:android` success alone misses repo-root import and Babel/plugin drift. (See `mobile-ui.md`.)
- For mobile navigation and accessibility changes, render real iOS and Android component/router trees; source-string assertions are not proof. Commit deterministic platform snapshots when simulators are unavailable, and never claim manual VoiceOver/TalkBack coverage that was not run.
- Before creating a GitHub release from a local tag, confirm the tag has been pushed to `origin`.
- Before committing, always run `bun run check`, `bun run test`, `bun run lint`.
- Treat Bun's default 5-second test timeout as a profiling signal, not a value to raise globally. Remove synchronous whole-heap or blocking cleanup work from normal lifecycle paths, explicitly release native resources, and split parameterized integration scenarios into independently reported tests without dropping recovery coverage.
- When a repair flow opens Settings from a creation-readiness alert, invalidate and rerun the preflight after the underlying provider status changes; do not leave a cached blocked result visible after authentication succeeds.
