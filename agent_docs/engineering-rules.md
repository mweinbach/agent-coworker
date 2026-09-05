# Engineering Rules

Durable rules distilled from past user corrections. Load this file for PR work, multi-step features, and bug fixes. When the user corrects you, distill the pattern into a rule and add it here.

## Workflow

- Plan non-trivial tasks (3+ steps or architectural decisions) before implementing. If evidence invalidates the approach, pause the affected action, revise the plan, and continue authorized work.
- Use subagents for independent research, exploration, and verification when delegation can save time or improve quality; one bounded task per subagent. Continue independent work while results are pending, avoid repeating their investigation, and integrate results before dependent work is complete. If the tools fail or are unavailable, continue directly rather than repeatedly retrying unchanged delegation.
- Bug reports: just fix them. Point at logs, errors, failing tests, then resolve. No hand-holding, no context switching required from the user — including failing CI.
- Prefer the elegant solution over the hacky one for non-trivial changes; skip this for simple, obvious fixes.
- Simplicity first; find root causes, no temporary fixes; touch only what's necessary.
- Task management: maintain a checkable plan using an available planning tool or an in-context checklist. Check it yourself against the user's requirements and known constraints before implementing; this is not a user-approval step. Mark items complete as you go and summarize meaningful progress. Ask only when an unresolved decision materially changes scope, risk, or the requested result; continue independent work while waiting and preserve explicit approval gates. Existing approval for the same action and scope remains valid unless the user changes it.

## PR Review Workflow

- Re-fetch unresolved review threads and verify each comment against current `HEAD` before editing — don't assume an open thread is still real.
- After fixing locally, reply on each addressed GitHub thread and resolve it in the same pass.
- Re-scan the latest SHA for both unresolved threads AND newer top-level review bodies before declaring PR feedback handled.
- When the user asks for subagent verification, spawn one targeted subagent per reported issue before editing — never batch.
- When the user explicitly stops automation or delegation, delete the automation, stop delegated work, and finish in the current primary thread without spawning or resuming agents.
- Before claiming a comment is fixed, re-check the exact current branch path it points at.
- Inspect the latest GitHub Actions run when babysitting a PR; flaky lanes (e.g. remote MCP smoke) can still be the real blocker after comments resolve.
  - References: `.github/workflows/ci.yml` (main lane), plus `desktop-release.yml`, `cowork-server-release.yml`, `win-sandbox-release.yml`
- For ordinary PR feedback handling, use one independent review pass plus one verification pass. Reopen review only for new changes, unresolved findings, failed checks, or newly discovered material risk. Once findings are fixed and CI is green, perform the next action already authorized by the user; merge only when merging is authorized. An explicitly requested exhaustive audit or a managed task's required review rounds can have a different review scope.

## Scope & Plan Discipline

- Apply the execution and skill-precedence rules in `AGENTS.md`. For Astra-specific guidance, see [astra.md](astra.md). A skill's preferred format, model, or workflow does not override an explicit user request or authorize a different task.
- Before blocking on a skill requirement, complete independent authorized preparation. If the requirement still applies, link the exact `SKILL.md`, quote the relevant instruction, and explain the concrete remaining decision. Preserve enforced security boundaries and explicit approval gates.
- For screenshot-driven visual bugs, identify the exact affected control before changing adjacent app chrome or behavior.
- Keep Task mode explicit and separate from standard chat: never auto-promote chats into tasks, auto-wrap chats in task state, or expose task-owned sessions in ordinary chat listings. (See `repo-contracts.md` → Task mode.)
- When the user narrows a contract, apply that exact direction; don't preserve broader backward-compat assumptions.
- When the user excludes an artifact type for delivery, remove it from the final output and any PR metadata instead of keeping it as optional context.
- When the user excludes screenshots or recordings from a PR, keep the PR body text-only and summarize verification in prose.
- When the user expands scope mid-task ("include the failures you found"), treat every surfaced error as in-scope.
- When cleaning unrelated local diffs, never revert adjacent user-wanted changes without confirming intent. Preserve those changes and continue in an isolated worktree when a revert is unnecessary; do not treat a dirty checkout alone as a reason to stop.
- Carry user-added requirements (commit trailers, contract changes) forward into the plan and the eventual commit message.
- Keep internal orchestration model names out of commits and project documentation.
- When the user requests commit-and-push cadence, commit each verified logical slice with a Conventional Commit and push it before starting the next slice.
- When the user explicitly accepts a change ("delete the workflow"), execute that — don't keep refining the prior approach.
- Confirm the active branch is rebased on current `origin/main` before stacking multi-commit work; if `main` moved mid-feature, rebase before more branch work.
- When the user says a surface is "retired" or "archived", do the full deletion in one pass: code, tests, docs, entrypoints, now-unused deps. No dormant compatibility shells.
- When the user asks to push a new build for this repo, treat it as a version bump plus release tag unless they explicitly ask for a no-op CI trigger.

## Verification Before Done

- Keep tests meaningful and necessary: do not add implementation-mirroring tests for reversible, low-impact changes. Run appropriate tests and required checks once per unchanged slice; broaden or repeat only for new changes, failures, or unresolved concerns.
- Verify the requested outcome before marking a task complete. Apply the canonical verification lane and its read-only/instruction-only applicability rules in the root `AGENTS.md`; report any remaining evidence gaps instead of claiming unverified behavior works.
- When the canonical lane requires tests, run the full project test command, not just specific tests: cross-file Bun module mocks can pass in isolation and still fail in the full suite.
  - References: `scripts/run_tests.ts`, `packages/harness/src/check_docs.ts`
- For desktop UI changes, verify the affected behavior in the live running app using the tool preference and evidence requirements in `desktop-ui.md` → Electron tooling. Tests alone are not proof.
- For Expo mobile changes, run an explicit Metro bundle path (e.g. `expo export`) — `run:ios`/`run:android` success alone misses repo-root import and Babel/plugin drift. (See `mobile-ui.md`.)
- For mobile navigation and accessibility changes, render real iOS and Android component/router trees; source-string assertions are not proof. Commit deterministic platform snapshots when simulators are unavailable, and never claim manual VoiceOver/TalkBack coverage that was not run.
- Before creating a GitHub release from a local tag, confirm the tag has been pushed to `origin`.
- Treat Bun's default 5-second test timeout as a profiling signal, not a value to raise globally. Remove synchronous whole-heap or blocking cleanup work from normal lifecycle paths, explicitly release native resources, and split parameterized integration scenarios into independently reported tests without dropping recovery coverage.
- When a repair flow opens Settings from a creation-readiness alert, invalidate and rerun the preflight after the underlying provider status changes; do not leave a cached blocked result visible after authentication succeeds.
