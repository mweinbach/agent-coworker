# Engineering overhaul

This is the decision and verification record for the September 2026 whole-app
review. The goal is reliable behavior and simpler ownership, not a lower line
count at the expense of safeguards. Decisions below concern the current code,
not the older proposals in `audit-code-bloat.md`.

## Baseline and scope

- Base commit: `6564e4e5f4d6b11ef7dc19b27fc7bbab9c39cbfa`.
- Working branch: `codex/reliability-overhaul`, isolated from `feat/workflows`.
- Baseline: all **719 test files passed** through `bun run test`.
- Root/harness/desktop and mobile typechecks passed. Biome check/lint and
  `bun run docs:check` passed.
- Review includes execution, providers, tools, protocol, persistence, desktop,
  mobile/native adapters, automation, integrations, artifacts, CLI, delivery,
  telemetry, supporting tests, configuration, prompts, and documentation.
- Existing tests passing is not evidence that a newly identified race is safe.
  Every behavior fix must first reproduce the failure in a focused regression.

## Architecture decision

**Keep the WebSocket-first foundation.** The harness owns operations, durable
state, permissions, and model/tool execution. Desktop, web, mobile, and CLI are
clients. Keep typed request validation, occurrence-stable event identity,
opt-in backups, isolated auth homes, and native sandbox boundaries.

**Rewrite lifecycle and mutation paths where ownership is unclear.** A request
must have one owner, a bounded lifetime, an honest terminal result, and cleanup
that cannot cancel or overwrite a newer request. Serialize read-modify-write
operations at the resource they mutate, not at an unrelated UI button.

**Delete proved-dead or misleading machinery.** Static-analysis candidates are
leads, not permission to delete dynamic entrypoints, mobile consumers, safety
checks, or compatibility contracts. Prefer removing an unnecessary concept to
moving its conditionals into another file.

## Work plan

- [x] Isolate the checkout and establish the green baseline.
- [x] Assign all source areas to independent subsystem reviews.
- [ ] Complete the piece-by-piece decision ledger and current-code evidence.
- [ ] Repair execution, cancellation, concurrent mutation, and persistence.
- [ ] Repair client recovery, search, creation, and editor handoff journeys.
- [ ] Repair mobile startup, offline ownership, and failure acknowledgments.
- [ ] Remove unsupported/dead surfaces and correct delivery prerequisites.
- [ ] Run exact-tree integration, UI/native/build, and independent review gates.
- [ ] Record final verification and platform limits.

## Initial implementation decisions

These decisions are based on inspected code and deterministic reproductions.
This table is expanded and its implementation state updated as each subsystem
finishes review; it is not a claim that unfinished work is complete.

| Piece | Decision | Reason and required outcome |
| --- | --- | --- |
| Agent/run-turn orchestration | Keep foundation; rewrite resource lifetime | MCP connections must close after setup errors and cancellation must not strand cleanup. |
| Native model stream adapters | Rewrite terminal-state handling | Incomplete or truncated responses must never execute partial tool arguments as completed calls; retain known usage and partial text. |
| Shared JSON-RPC client | Rewrite connection ownership | Closing, replacing, or failing a handshake must settle the correct readiness promise; stale connections cannot activate new ones. |
| Server turn admission | Rewrite admission transition | Concurrent requests must not overwrite the active turn or acknowledge the wrong submission. |
| Session persistence/checkpoints | Keep storage; rewrite pending-generation handling | A retry of an older checkpoint must not erase a newer change with the same reason label. |
| Streaming projection and journaling | Keep protocol; repair identity and retry ownership | Simultaneous calls and resumed messages remain distinct; idle means writes actually finished. |
| File write/edit tools | Rewrite guarded mutation | Concurrent edits must preserve both changes, failures must preserve the original file, and path validation must remain effective through commit. |
| Process and read/fetch cancellation | Rewrite operation lifetime | Pre-aborted work must not start; cancellation and timeouts cover bodies/streams, not only startup or response headers. |
| Permission and sandbox foundation | Keep | Do not trade safety for simpler-looking code; optimize repeated discovery only within a validated operation. |
| Provider catalog/cache | Rewrite discovery orchestration | One provider cannot hang the whole catalog; caches must belong to the actual endpoint and auth status must agree across surfaces. |
| Auth/config/override stores | Keep formats; rewrite mutation ownership | Concurrent credential or plugin changes must not silently overwrite one another. |
| MCP discovery/cache | Rewrite shared-load ownership | One workspace load must have one connection owner; preserve OAuth registration and discover all tool pages. |
| Backup snapshots/restores | Keep opt-in feature; rewrite destructive transitions | Failed restore must preserve recoverable data; reject symlink escapes and serialize checkpoint numbering. |
| Command templates | Rewrite one-pass expansion | User text containing dollar signs or placeholder-looking strings stays literal. |
| Desktop shell and component system | Keep | Existing semantic tokens and shared components are useful; fix interaction failures rather than replace the visual system. |
| Desktop selection/readiness/search | Rewrite stale-state and query behavior | Cancellation must permit retry, changed targets invalidate readiness, and search must include results outside the first page or collapsed groups. |
| Desktop editors and settings | Keep surfaces; repair acknowledgment/ownership | Failed saves retain drafts; changing workspace cannot apply one project's draft to another. |
| Electron process/window services | Keep architecture; rewrite startup ownership | Reserve starts before async work, cancel superseded starts, and retain final window bounds. |
| Expo/RN mobile foundation | Keep | Share the typed harness protocol; repair lifecycle/cache boundaries rather than fork business logic. |
| Mobile offline persistence | Rewrite hydration and write scheduling | Old cache cannot overwrite fresh server state; cache work is bounded and must not run on every streamed update. |
| Native iOS launch | Rewrite scene lifecycle integration | The native app must launch on the installed SDK/runtime, not merely compile. |
| Task review and agent admission | Rewrite terminal/admission checks | An errored reviewer cannot pass; resumed child runs obey concurrency limits and cannot replace an in-flight run. |
| Telemetry consent lifecycle | Rewrite async initialization ownership | A disabled integration cannot be resurrected by an older pending SDK load. |
| Test runner and quality gates | Keep; extend behavior coverage | Preserve per-file isolation and deterministic fixtures; cover the actual failure paths rather than source-string assertions. |
| Release/bootstrap prerequisites | Repair | Full-suite entrypoints must install the locked mobile dependencies just as CI does. |

## Verification policy

Use `bun run test`, not bare `bun test`. Before committing an integration
checkpoint, run the full suite, strict typechecks, Biome check/lint, and docs
checks. Run focused regressions before and after each fix. Verify desktop
behavior in the running app and the collaborative browser, and run an explicit
Metro bundle for mobile changes. Distinguish compiled, launched, and manually
exercised states; do not imply that a platform was tested when it was not.

No release publication or changes to personal app state are part of this work.
