# Platform Abstraction Plan (Windows / macOS / Linux)

> Produced 2026-07-06 by a 40-agent audit of HEAD `b2a4453f`: 583 unique platform-conditional findings → 253 adversarially verified hazards (1 critical, 30 high, 113 medium, 109 low) → 83 divergence clusters → the design below, revised per a staff-level critique (verdict: revise → revisions folded in as "Critique amendments").
> Status: **Phases 0-5 substantially implemented** (branch feat/platform-abstraction, 2026-07-07): Phase 0 (.gitattributes LF pin, platform-boundary ratchet), Phase 1 (host/pathString/text/paths/env/exec + barrel), Phase 2 (pwsh -EncodedCommand transport, per-dialect approval, prompt single-sourcing, sandbox env allowlist, exec.which bash lanes), Phase 3 (read/edit CRLF contract, glob/grep/ripgrep normalization, portable execFileCompat fixtures), Phase 4 (proc.ts tree-kill + graceful-shutdown primitives, fs.ts atomic primitives; bash timeout now tree-kills), Phase 5 (case-fold metadata/credential security, home()/MCP childEnv, sandbox scratch parity + probe memoization + denial tables). Deferred to follow-ups: the server/shutdown JSON-RPC route + desktop graceful-kill migration (rows 26-27, needs live Electron verification), fs/proc adoption at the P1 long-tail call sites (rows 19-35 remainder), and Phase 6 (CI matrix flip — the execFileCompat fixture blocker is now cleared; the native Windows-sandbox enforcement lane still needs a UAC-install run before merge). Full raw findings live in the session audit output; the actionable subset is this document.

## Why the ping-pong happens (root-cause summary)

The repo does not have *a* platform problem; it has the same five problems re-implemented N times each:

1. **N implementations per concern.** 5 executable resolvers, 5 home-dir precedence rules, 5 lock implementations, 5 tree-fingerprint hashers, 4 graceful-kill escalations, 3 atomic-write strategies, 3 scratch-root definitions, 14 hand-synced copies of Windows shell prose. A platform fix lands in one copy; the others keep the old behavior, and the next fix "for the other OS" lands in a different copy.
2. **The model is used as the platform-compat layer.** Prompts tell the model "on Windows use PowerShell syntax / use `py -3`" — while the runtime simultaneously injects a bundled-Python PATH prelude that `py -3` bypasses. Quoting differences then leak into every generated command instead of being handled once in the transport.
3. **Windows PowerShell transport re-parses the command.** `pwsh -Command <string>` gives Windows three parse layers (Bun spawn quoting → PowerShell CLI parse → -Command re-parse) vs one on POSIX (`bash -lc`). Whole classes of commands (`git commit -m "..."`) corrupt Windows-only.
4. **Signals/processes assume POSIX everywhere.** Graceful shutdown, kill-tree, PID liveness all pinned to SIGTERM semantics; on Windows every kill is `TerminateProcess`, so cleanup paths (snapshot flush!) are dead code and grandchildren orphan on every bash-tool timeout.
5. **CI only fully tests Linux.** Windows/macOS run curated smoke lists, so a fix for one OS is structurally unverifiable against the others. Tests that would fail get `skipIf(win32)` — 10+ suites encode the divergence instead of fixing it.

## The one rule this plan enforces

> For every platform-sensitive concern there is exactly **one** implementation, and it lives under `src/platform/`. Platform branching happens **inside** that module. Callers never read `process.platform`. Every platform-branching function takes `platform?: NodeJS.Platform` so all branches are unit-testable on every host. A ratchet test bans new violations and only counts down.

## Critique amendments (fold these into the design below — they override where they conflict)

The adversarial review confirmed the diagnosis and migration map, but flagged these **blocking revisions**:

1. **Case-folding containment must split by fail direction.** Fold deny-side checks (`crossesProtectedMetadata` — over-blocking is safe) on win32+darwin; but accept-side checks (`isInside` feeding sandbox writable roots) must NOT case-fold on darwin unless realpath/inode identity confirms sameness — case-sensitive APFS exists and folding there *widens* the sandbox.
2. **`paths.canonicalize` engine must be decided up front.** Bun 1.3.14 has no `fs.promises.realpath.native`; only the sync native exists. Pick sync-native under both signatures (accepting event-loop cost) or a normalization step, and state it before Phase 1.
3. **`-EncodedCommand` needs a size fallback + explicit exit-code contract.** UTF-16LE+base64 is ~2.67× expansion against the 32,767-char CreateProcess ceiling → scripts over ~11 KB must fall back to a `-File` temp script. Golden tests must pin the `exit $LASTEXITCODE` behavior for both native-last and cmdlet-last scripts, including PowerShell 5.1 (no `??`).
4. **`terminateGracefully` needs `requestShutdown?: () => Promise<void>` in its opts** (callers wire the JSON-RPC `server/shutdown` call), and stdin-EOF sentinel requires pipe stdin (current spawns use `stdin: "ignore"`). Honest win32 primary kill mechanism is `taskkill /T /F` (no Job Object API in pure Bun); the sandboxed lane already gets Job-Object kill via the helper.
5. **Resequence: the CRLF read/edit fix moves to Phase 1.** It is the single critical, agent-visible bug (every multi-line edit fails on CRLF checkouts) and does not depend on the shell transport work.

Plus notable NITs adopted: stdin-EOF shutdown watcher is **opt-in per entrypoint** (headless `bun run serve < /dev/null` must not exit at boot); add `Bun.which`, `process.arch`, and direct `path.win32/posix` selection to the ratchet's banned-token list; approval dialect tables extend a **shared** dialect-neutral base (PowerShell aliases `rm`/`del`/`ri` count as destructive); `.gitattributes` flip needs `eol=crlf` exceptions for `.bat`/`.cmd` and `-text` for CRLF test fixtures, and the renormalize commit must be coordinated with open branches; add a loopback/dual-stack (`::1` + `127.0.0.1`) seam or explicit out-of-scope note; differential tests asserting `pathString.*` ≡ `node:path.win32/posix` on generated inputs; trim `whichAll`, `openNoFollow` TOCTOU re-check, and `isHiddenEntry` FILE_ATTRIBUTE_HIDDEN (needs a spawn — not free) unless a consumer materializes.

---

# Appendix A — Confirmed critical/high hazards (31 of 253; mediums/lows tracked in the migration map)

- **[critical]** src/tools/edit.ts:58 — Exact substring match (content.includes(oldString)) with no CRLF tolerance: on Windows checkouts (core.autocrlf=true → CRLF working-tree files) any multi-line oldString the model copies from read output contains bare \n (read strips \r), so it can never match and every multi-line edit fails with 'oldString not found'. The identical call succeeds on macOS/Linux. Secondary: when a single-line-anchored edit with a multi-line newString does succeed, Bun.write at line 83 splices LF lines into a CRLF file, corrupting it with mixed line endings.
  - fix: platform.text.replaceRespectingEol(content, oldString, newString, { replaceAll }) — detect the file's dominant EOL, normalize both haystack and needle to LF for matching, apply the replacement, then re-emit the file's original EOL on write
- **[high]** src/server/runtime/ServerRuntime.ts:626 — Conversation import homedir resolves as opts.homedir ?? env.HOME ?? process.cwd(). HOME is normally unset on Windows, so external-conversation discovery (~/.claude/projects, ~/.codex) silently probes under the workspace cwd and finds nothing — the recently shipped import feature is a no-op on Windows headless/CLI servers.
  - fix: platform.paths.home() (single home resolver; at minimum os.homedir() fallback instead of process.cwd())
- **[high]** src/mcp/index.ts:256 — StdioClientTransport receives the config-file env verbatim; the MCP SDK only applies getDefaultEnvironment() when env is undefined, so any stdio MCP server configured with env vars spawns on Windows without SystemRoot/PATH/APPDATA — winsock init and command resolution fail — while POSIX children usually limp along. Fix-for-one-OS bait.
  - fix: platform.env.childEnv(overrides) — merge overrides onto the platform-safe default child environment before handing to the transport
- **[high]** src/tools/bash.ts:30 — SANDBOX_ENV_ALLOWLIST includes HOME, TEMP, TMP, USERNAME, SystemRoot but omits USERPROFILE, HOMEDRIVE/HOMEPATH, APPDATA, LOCALAPPDATA, ProgramData, ProgramFiles. minimalSandboxEnv (used at bash.ts:387 for every sandboxed run) therefore strips the Windows profile env, so sandboxed git/gh/npm/pip cannot find config, credentials, or caches — commands that work fine in the same sandbox on macOS/Linux.
  - fix: platform.env.sandboxAllowlist() returning a per-platform base allowlist owned by src/platform
- **[high]** src/utils/approval.ts:21 — DANGEROUS_PATTERNS and REVIEW_PATTERNS (lines 21-46) recognize only POSIX toolchain destructive commands (rm -rf, dd of=, mkfs, find -delete, chmod -R, truncate). On Windows the bash tool runs PowerShell, so the native destructive vocabulary the prompts explicitly steer models toward — Remove-Item -Recurse -Force, rd /s /q, del /s /q, Clear-Content, Format-Volume, Remove-Item on device paths — classifies as safe_auto_approved and never surfaces an approval prompt. The human-in-the-loop UX gate, a mainline safety feature, is effectively absent on Windows for exactly the command dialect Windows sessions are told to use; it is doubly exposed because the Windows sandbox backend is the one most often unavailable (helper not installed), leaving the prompt as the only gate on the unsandboxed fallback path.
  - fix: platform.approval.classifyCommand(command, platform) in src/platform — per-shell pattern sets (POSIX + PowerShell/cmd equivalents) owned next to the shell-selection code in src/platform/shell.ts so a new shell dialect cannot ship without its destructive-pattern table
- **[high]** src/coworkRuntime/ensureReady.ts:482 — renderCoworkRuntimeInstructions() injects 'Use bundled Python at `<absolute path>`' into the system prompt while the Shell Execution Policy (src/prompt.ts:565), the bash tool description (src/tools/bash.ts:434), and all prompt templates simultaneously say 'On Windows, prefer py -3 or python'. The py launcher resolves via the Windows registry and completely bypasses the PATH prelude that buildPlatformShellCommandWithRuntimePrelude sets up, so a Windows model obeying the more prominent 'py -3' rule executes system Python without the bundled runtime's installed packages — skill deliverables (spreadsheet/doc/pdf Python scripts) fail with missing-module errors on Windows only, while macOS/Linux models following the same prompts happen to get the right interpreter via PATH. Two contradictory instructions coexist in one prompt.
  - fix: platform.runtime.pythonInvocation(env, platform) — a single function returning the canonical interpreter invocation (bundled absolute path, or bare `python` guaranteed by the PATH prelude), consumed by renderCoworkRuntimeInstructions, the shell-policy prompt section, and harness platformCommands so all three emit the same answer; delete the 'py -3' prose everywhere
- **[high]** src/utils/execFileCompat.ts:74 — Timeout/abort/overflow termination for the core bash tool kills only the direct child via proc.kill(SIGTERM) — no detached/process-group spawn, no negative-pid group kill on POSIX, no Job Object or taskkill /T on Windows. A timed-out 'pwsh -Command' / 'bash -lc' wrapper dies but its grandchildren (npm, builds, dev servers) keep running; on Windows the SIGTERM is TerminateProcess so the wrapper cannot even forward the signal, guaranteeing the orphan tree. Every bash-tool timeout leaks differently per platform.
  - fix: platform.proc.killTree(pid, { graceSignal: 'SIGTERM', graceMs }) — POSIX: spawn detached + kill(-pgid); Windows: Job Object handle or taskkill /PID /T /F. execFileCompat should spawn via platform.proc so the tree handle exists at kill time.
- **[high]** src/server/index.ts:307 — Server graceful shutdown (server.stop(), analytics flush, child cleanup, session-snapshot flush) is wired exclusively to SIGINT/SIGTERM/SIGHUP handlers plus process.on('exit'). On Windows every parent (webDesktopService.ts:664, serverManager.ts:625 via getServerTerminationSignal) terminates the server with TerminateProcess, which runs no signal handler and no 'exit' hook — so the entire cleanup path never executes on Windows. docs/bundling-guide.md:311 advertises 'send SIGTERM ... it flushes pending session snapshots' as the embedding contract, and there is no JSON-RPC shutdown route to substitute; the contract is POSIX-only.
  - fix: platform.proc.onShutdownRequest(handler) paired with a signal-free shutdown channel that works on Windows: a 'server/shutdown' JSON-RPC method or stdin-EOF sentinel, with parents calling platform.proc.terminateGracefully() which uses that channel before hard kill.
- **[high]** src/server/webDesktopService.ts:659 — gracefulKill() sends a default child.kill(), waits 3s, then escalates (SIGKILL on POSIX, default kill again on win32). On Windows the first kill() is already TerminateProcess, so the workspace server gets zero graceful window and never flushes session snapshots or stops its own children (runtime bootstrap, MCP servers); the 3s wait and the escalation are dead code on win32. No process-tree kill on any platform, so the server's grandchildren leak.
  - fix: platform.proc.terminateGracefully(child, { graceMs: 3000 }) built on the shutdown-request channel + platform.proc.killTree() for escalation.
- **[high]** apps/desktop/electron/services/serverManager.ts:615 — Desktop gracefulKill: kill(getServerTerminationSignal()) then SIGKILL after 3s (+1s wait). serverPlatform.ts:18 returns undefined on win32, so both phases are TerminateProcess on Windows — the packaged sidecar server is always hard-killed with no chance to flush snapshots, and no tree kill means bun-server grandchildren (MCP servers, runtime bootstrap) survive an app quit. Third independent implementation of the same escalation, with a different grace window than the other two.
  - fix: platform.proc.terminateGracefully(child, { graceMs }) — one shared escalation with a Windows-functional graceful phase, plus platform.proc.killTree() for the SIGKILL step.
- **[high]** src/utils/paths.ts:12 — isPathInside uses path.relative, which is case-insensitive on win32 (Node folds the common prefix) but case-sensitive on darwin — on macOS's default case-insensitive APFS, containment and credential-deny checks (permissions.ts credentialReadDenyDirs) miss a differently-cased spelling of the same directory; the canonicalization feeding it (permissions.ts canonicalizeExistingPrefixSync, JS fs.realpathSync) does not case-normalize, so a cased path like /Users/x/.cowork/AUTH can evade the deny on macOS.
  - fix: platform.paths.isInside(parent, child) — one containment predicate that case-folds per the platform's filesystem semantics (win32 AND darwin) after platform.paths.canonicalize()
- **[high]** src/tools/read.ts:120 — readline with crlfDelay: Infinity silently strips \r, so the model always sees LF-normalized lines regardless of the file's true bytes. On its own this is fine for display, but it is the producing half of the edit.ts failure: read and edit disagree about the file's real content, and the divergence is invisible until an edit fails on a Windows/CRLF checkout. Must be fixed as one contract with edit, not by emitting raw \r (which would degrade model ergonomics on every platform).
  - fix: platform.text.detectEol(filePath|content) + keep read LF-normalized as the documented canonical view, with edit calling platform.text.replaceRespectingEol so both tools share one EOL contract owned by src/platform
- **[high]** src/utils/paths.ts:52 — pathCrossesProtectedMetadata compares path segments against ['.git','.cowork'] case-sensitively, but Windows (NTFS) and default macOS (APFS) are case-insensitive: a not-yet-existing target like '.GIT/hooks/pre-commit' passes the guard (canonicalization only fixes casing for existing prefixes). Both the sandbox policy layer (policy.ts imports PROTECTED_METADATA_DIR_NAMES) and the write/edit file tools inherit the bypass, defeating the documented privilege-escalation protection on two of three platforms.
  - fix: platform.paths.crossesProtectedMetadata() using platform.paths.segmentEquals() that case-folds on win32/darwin
- **[high]** src/platform/sandbox/windows.ts:41 — The Windows backend maps 'no-project-write' to helper mode 'read-only' with zero scratch roots, while bwrap.ts:102 and seatbelt.ts:136 deliberately grant /tmp-family scratch via tmpScratchRoots, and policy.ts documents 'They still get temp scratch space'. Read-only roles (reviewer/explorer/research subagents) can compile/diff/stage transient files on macOS/Linux but get no writable temp on Windows — the same role behaves differently per OS.
  - fix: platform.sandbox.scratchRoots(platform) as the single scratch source, passed to the helper as writable roots
- **[high]** src/platform/shell.ts:48 — The entire model-authored command is passed as one argv element to `pwsh -Command`, so on Windows it crosses three parse layers (Bun spawn quoting for CreateProcess, PowerShell's native CLI parser, then -Command script re-parse) versus one bash parse on POSIX. Commands with embedded double quotes, trailing backslash-before-quote, `$`, or backticks are corrupted Windows-only (classic case: git commit -m "..."); execFileCompat (src/utils/execFileCompat.ts:58) spawns with default quoting and no verbatim-args handling. This is the core agent bash tool, so mainline command execution silently diverges per platform.
  - fix: platform.shell.run() should pass the payload without re-parse on Windows — pwsh -EncodedCommand (Base64 UTF-16LE) or piping the script via stdin with -File/-Command - — so both platforms get exactly one shell interpretation
- **[high]** test/fixtures/execFileCompatChild.ts:7 — sh() maps to ['cmd','/c',script] on Windows but every script is POSIX-dialect (';' chaining, sleep, 'yes | head -c', $VAR expansion). Proven by running: 6 of 10 tests fail on this Windows host (exit-code, timeout/abort timing, maxBuffer, env-expansion assertions all wrong under cmd.exe), so the parent suite test/execFileCompat.test.ts:23 (asserts child exit 0) fails too. The exec-compat layer's Windows contract — which backs codex resolver probes and harness runners — is not just unverified, its test is broken on Windows and hidden because the file is absent from the Windows CI smoke list.
  - fix: Build fixture commands via buildPlatformShellExecutionPlan from src/platform/shell.ts (pwsh dialect on win32), or replace shell one-liners with portable `bun -e` child scripts; expose as platform.shell.run(script) so tests and production share one dialect selection.
- **[high]** test/ci.workflow.test.ts:51 — The CI contract test locks in that the full `bun test` suite runs only on the Linux lane; Windows and macOS lanes execute hand-curated smoke file lists (lines 76-85, 92-95). Every test not on those lists (including the provably-failing execFileCompat suite) is never executed on Windows/macOS, so platform regressions in non-smoke code land silently — the structural enabler of the fix-one-OS-break-the-other cycle.
  - fix: Make host-branching modules accept an injected platform (the pattern src/platform/shell.ts already uses) so the full suite is host-agnostic, then run `bun test` on all three CI lanes instead of curated smoke lists.
- **[high]** test/permissions.test.ts:297 — All eight symlink-escape enforcement tests (297, 362, 404, 429, 504, 517, 552, 594) early-return on win32, leaving read/write/credential symlink-escape protection in src/permissions completely unverified on Windows — even though test/session/agentSession.core.test.ts:192 and apps/desktop/test/ipc-security.test.ts:114 prove the identical scenario is testable with privilege-free junctions. A Windows-only canonicalization regression in this security boundary would ship undetected.
  - fix: Shared test helper symlinkOrJunction() (junction on win32, dir symlink elsewhere) backed by a single platform.paths.canonicalize() in production; delete the early returns.
- **[high]** test/execFileCompat.test.ts:23 — Parent harness spawns a child `bun test` on the broken fixture and asserts exit 0; on Windows it fails (verified by execution), and on POSIX it only ever validates /bin/sh semantics — Windows termination, exit-code mapping, and maxBuffer behavior of src/utils/execFileCompat.ts go unproven everywhere.
  - fix: Same as the fixture: route through platform.shell.run() / buildPlatformShellExecutionPlan, then add the file to the windows-smoke lane.
- **[high]** apps/mobile/src/cowork-shared/types.ts:3 — Hand-copied PROVIDER_NAMES has already drifted: root src/types.ts:16 includes 'minimax', the mobile copy does not. Mobile's jsonrpcControlSchemas.ts builds providerNameSchema from this enum and applies it at 10+ parse sites (provider catalog id, session provider fields), so any desktop configured with minimax makes mobile control-RPC zod parsing reject valid server payloads — provider settings and session snapshots break on every platform pairing with that desktop.
  - fix: Import ProviderName/PROVIDER_NAMES from a single shared workspace package consumed by both server and mobile (same pattern as packages/harness) instead of a hand copy; short term, add 'minimax' plus a bun test asserting deep-equality between src/types.ts PROVIDER_NAMES and the mobile export.
- **[high]** apps/mobile/src/cowork-shared/jsonrpcControlSchemas.ts:1 — ~1500-line hand-copied fork of src/shared/jsonrpcControlSchemas.ts, verified drifted: the original has 38 occurrences of agentProfiles/skillImprovementScope/sourceHash/agent_profiles_catalog markers, the mobile copy has 1. Nine mobile files (controlRpc.ts, providerStore, workspaceStore, mcpStore, backupStore, memoryStore, skillsStore, offlineCache, useWorkspaceConfigQuery) validate live server payloads against the stale fork, and test/jsonrpc.control-schemas.test.ts:5 imports the MOBILE copy, so the root suite locks in the drift instead of guarding against it.
  - fix: Replace the fork with the canonical src/shared/jsonrpcControlSchemas.ts via a shared workspace package (Metro already watches the workspace root); until then, point test/jsonrpc.control-schemas.test.ts at the original and add a parity test that both modules export identical schema shapes.
- **[high]** apps/mobile/src/features/relay/secureTransportClient.ts:786 — isRepinRequiredError (and isFatalSessionError at 782) classify transport failures by regex-matching human-readable message strings from three divergent sources: Android Kotlin throws the literal 'Pinned HTTPS certificate mismatch.' (CoworkPinnedHttpsModule.kt:215), iOS cancels the auth challenge (CoworkPinnedHttpsModule.swift:159) yielding a locale-dependent NSURLError localizedDescription that matches neither pattern set on non-English devices, and Bun tests produce ECONNREFUSED-style codes. iOS pin-mismatch (a security event) is misrouted through generic reconnect instead of re-pair UX, and any wording change in either native module silently rewires the state machine.
  - fix: Define a shared error-code contract: both native modules reject/emit Expo CodedExceptions with stable machine codes (e.g. ERR_PIN_MISMATCH, ERR_CONN_REFUSED, ERR_TLS_HANDSHAKE) and the JS client switches on error.code instead of regex-matching localized message text.
- **[high]** apps/mobile/modules/cowork-pinned-https/ios/CoworkPinnedHttpsModule.swift:159 — iOS pin-mismatch handling calls completionHandler(.cancelAuthenticationChallenge, nil), surfacing only a generic locale-dependent NSURLErrorCancelled description to JS. The Android twin throws a machine-matchable literal, so the two platforms report the identical security event in incompatible vocabularies; secureTransportClient's isRepinRequiredError never sees the 'certificate mismatch' sentinel on iOS.
  - fix: Record the pin failure in the URLSession delegate and reject the request/stream with the same stable coded error the Android module produces (shared ERR_PIN_MISMATCH constant), rather than relying on NSURLSession's localized cancellation message.
- **[high]** apps/mobile/modules/cowork-pinned-https/android/src/main/java/co/weinbach/cowork/mobile/pinnedhttps/CoworkPinnedHttpsModule.kt:215 — Android pinning throws CertificateException("Pinned HTTPS certificate mismatch.") — a load-bearing literal that secureTransportClient.ts:788 regex-matches to trigger re-pair UX. The string is a cross-file, cross-language API with no shared constant or test pinning it; renaming it (or the iOS module never producing it, which it doesn't) silently changes reconnect behavior per platform.
  - fix: Promote the sentinel to a shared error-code contract (stable code field like ERR_PIN_MISMATCH emitted identically by both native modules) consumed by the JS classifier; add a test asserting the code constant matches what isRepinRequiredError expects.
- **[high]** apps/mobile/src/cowork-shared/openaiCompatibleOptions.ts:23 — OPENAI_REASONING_EFFORT_VALUES is ['none','low','medium','high','xhigh'] while the canonical src/shared/openaiCompatibleOptions.ts:22 has moved to include 'minimal' and 'light' (plus DEFAULT_OPENAI_REASONING_EFFORT_VALUES). Mobile settings validation and effort pickers reject or mis-render reasoning-effort levels the desktop server now legitimately emits and accepts.
  - fix: Consume src/shared/openaiCompatibleOptions.ts through the single shared workspace package instead of a copy; interim, sync the value lists and add a cross-copy equality test.
- **[high]** src/platform/shell.ts:42 — Windows-only: the win32 execution plan (lines 42-54) invokes pwsh with powershell.exe 5.1 as fallback using identical args but pins no output encoding (no [Console]::OutputEncoding/$OutputEncoding prelude; zero repo-wide hits for OutputEncoding/chcp). pwsh emits UTF-8 to redirected stdout while 5.1 emits OEM/ANSI-codepage bytes, and every downstream consumer decodes as UTF-8 — so on stock Windows (no pwsh in-box) any non-ASCII bash-tool output (localized errors, accented filenames from Get-ChildItem) is mojibake. macOS/Linux unaffected.
  - fix: Prepend a one-line encoding prelude to the -Command string in this single factory (buildPlatformShellExecutionPlan or buildPlatformShellCommandWithRuntimePrelude): [Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; — every consumer (bash tool, harness verification) inherits it.
- **[high]** src/utils/execFileCompat.ts:126 — Windows-only in practice: the single shared decode point does Buffer.concat(...).toString("utf8") unconditionally, so OEM/ANSI bytes from the powershell.exe 5.1 lane and Windows-native tools/Python become U+FFFD replacement characters before reaching the model. Compounding it, the maxBuffer cap at line 111 (chunk.subarray(0, maxBuffer - total)) slices the byte stream mid-UTF-8-sequence, so even pure-UTF-8 capped output ends in a mangled code point.
  - fix: Add an optional encoding to ExecFileCompatOptions (or return raw bytes and decode at call sites via a shared decodeChildOutput helper using TextDecoder with the caller-declared encoding), and trim the final buffer to a UTF-8 code-point boundary before decoding when the maxBuffer cap truncates.
- **[high]** .gitattributes:1 — File does not exist at repo root; git check-attr returns 'unspecified' for text/eol on every path and this autocrlf=true Windows checkout shows i/lf w/crlf for all text files. Working-tree bytes of every checked-in file vary by contributor git config: Windows checkouts get CRLF, macOS/Linux get LF. This is the verified single upstream cause of the Biome format failure, byte-divergent source fingerprints, build-host-dependent packaged resources, and five scattered hand-rolled CRLF normalizers (scripts/winSandboxPrebuilt.ts:49 comment explicitly documents the gap).
  - fix: Add a root .gitattributes with '* text=auto eol=lf' plus binary exceptions (*.png, *.ico, *.icns, *.exe, *.node, *.dmg, *.zip binary), then run 'git add --renormalize .' in a single renormalize commit. This is the unified policy that makes all downstream per-site normalizers redundant.
- **[high]** biome.json:34 — Windows breaks: formatter enforces "lineEnding": "lf" while git materializes CRLF on autocrlf=true checkouts. Verified live on this checkout — bunx biome format reports a whole-file format error for every file checked (2/2 files errored with full-file CRLF diffs), so bun run format/lint/check fails wholesale on Windows while passing on Linux CI. format:write rewrites to LF and git re-converts on next checkout, cycling forever.
  - fix: Keep Biome's lineEnding=lf and align git to it via the root .gitattributes ('* text=auto eol=lf' + renormalize commit) so checkout bytes match the formatter policy on every platform. No biome.json change needed.
- **[high]** apps/desktop/electron-builder.yml:56 — Windows: forceCodeSigning:false (line 55) + verifyUpdateCodeSignature:true, while CI signing is conditional on WIN_CSC_LINK secret presence (desktop-release.yml:197-203). Users who installed a signed build have electron-updater reject any later unsigned release (publisherName from the cert baked into app-update.yml no longer matches); unsigned installs skip verification entirely. Auto-update installability depends on which side of the signed/unsigned flip a user first installed. Git history confirms the ping-pong: 0fc37f22 set verifyUpdateCodeSignature:false, dd877a73 flipped it true + forceCodeSigning:true, cb14d631 relaxed forceCodeSigning to false.
  - fix: Pick one contract and enforce it end-to-end: set win.forceCodeSigning:true and make the Windows CI lane hard-fail on missing WIN_CSC_LINK/WIN_CSC_KEY_PASSWORD for tag builds (mirror the macOS 'Validate macOS signing and notarization inputs' gate at desktop-release.yml:148-191), so verifyUpdateCodeSignature:true is always satisfiable.
- **[high]** .github/workflows/desktop-release.yml:201 — Windows: the 'Configure Windows signing' step logs 'building unsigned release artifacts' and proceeds when signing secrets are absent, while the macOS lane hard-fails (lines 148-191) — opposite failure policies for the same delivery guarantee. test/desktop-release.workflow.test.ts:109 asserts 'Unsigned Windows production releases are forbidden' must NOT appear, pinning the removal of a stricter gate that dd877a73 had introduced.
  - fix: Replace the conditional with a fail-fast validation step identical in policy to the macOS gate: exit 1 when WIN_CSC_LINK/WIN_CSC_KEY_PASSWORD are missing on tag-triggered runs (optionally allow unsigned only for workflow_dispatch dry runs), and update the workflow test to pin the strict policy instead of the permissive one.

---

# Unified Platform Abstraction Layer for `agent-coworker`

**Status:** design for approval — grounded in the current tree (`src/platform/shell.ts`, `src/platform/sandbox/*`, `src/tools/bash.ts`, `src/utils/{paths,workspacePath,execFileCompat}.ts`, `packages/harness/src/platformCommands.ts` all re-read at HEAD `b2a4453f`).

**Problem being solved:** ~240 `process.platform` reads across 90 files, five executable resolvers, three atomic-write strategies, five home-dir precedences, 14 hand-synced copies of shell-dialect prose, and a test suite that runs fully on Linux only. Every Windows fix regresses macOS and vice versa because each concern has N implementations and the fix lands in one.

**The rule this design enforces (the single choke-point rule):**

> For every platform-sensitive concern there is exactly **one** implementation, and it lives under `src/platform/`. Platform branching happens **inside** that module. Callers never read `process.platform` / `os.platform()`; they call the module. Every platform-branching function accepts `platform?: NodeJS.Platform` (defaulting to the host) so **all branches are unit-testable on every host** — the pattern `buildPlatformShellExecutionPlan` already uses.

The two existing abstractions — `src/platform/shell.ts` and `src/platform/sandbox/` — are **extended in place**, not replaced. `packages/harness/src/platformCommands.ts` becomes a thin re-export. `src/utils/{atomicFile,execFileCompat,subprocess,paths,workspacePath}.ts` become deprecated re-export shims during migration and are deleted once `knip` shows zero consumers.

---

## 1. Target module layout under `src/platform/`

```
src/platform/
  index.ts        barrel: export * as paths / pathString / env / exec / proc /
                  shell / fs / text / approval / archive / os / sandbox, + host exports
  host.ts         platform identity (the ONE sanctioned process.platform read)
  pathString.ts   pure string path ops — browser-safe, zero node:* imports
  text.ts         EOL + encoding contract — deliberately platform-independent
  paths.ts        filesystem-aware path semantics (canonicalize, containment, home)
  env.ts          env-var case semantics, PATH building, child-env defaults
  exec.ts         executable resolution (which/PATHEXT/shims) — no spawning
  proc.ts         process lifecycle (run, spawn, kill tree, graceful shutdown, liveness)
  shell.ts        EXISTS — extended (transport, prompt guidance, canned commands)
  fs.ts           atomic replace, locks, retries, symlinks, tree fingerprints
  approval.ts     destructive-command classification per shell dialect
  archive.ts      zip/tar extraction and creation (pure-JS-first)
  os.ts           opening URLs in the host OS
  sandbox/        EXISTS — extended (scratch roots, backend parity, bundle verify)
test/helpers/platform.ts   test-side helpers built ON the layer (pinHome,
                           symlinkOrJunction, expectPrivateMode, platformMatrix)
```

Dependency order (acyclic, top may import bottom): `host` → `pathString` → `text` → `paths` → `env` → `exec` → `proc` → `shell` → `approval`/`archive`/`os` → `sandbox`.

Import style for consumers: `import * as platform from "../platform"` then `platform.paths.isInside(...)` — or named imports from the submodule. Existing named imports from `shell.ts` and `sandbox` keep working (barrel is additive).

---

### 1.1 `host.ts`

```ts
export type PlatformId = NodeJS.Platform;
/** The only sanctioned read of process.platform outside default parameters. */
export function hostPlatform(): NodeJS.Platform;
export type DesktopPlatform = "windows" | "macos" | "linux" | "other";
/** Single raw→normalized vocabulary mapping (replaces the two byte-identical copies
    in apps/desktop/src/lib/desktopPlatform.ts and windowChrome/platformChrome.ts). */
export function toDesktopPlatform(platform?: NodeJS.Platform): DesktopPlatform;
```

Data tables keyed by `PlatformId` (e.g. provider support gates) may live in their own domain modules, but they must obtain the id from `hostPlatform()` and use **one** vocabulary — this kills the `'windows'`-vs-`'win32'` Antigravity dual gate.

### 1.2 `pathString.ts` — browser-safe path strings (renderer + mobile + server share it)

No `node:path`/`node:fs` imports. **Platform is a required parameter — no default.** The `runtimePlatform() → "linux"` fallback in `src/utils/workspacePath.ts:2` is the documented trap; renderers must thread the server-reported platform.

```ts
export type PathStyle = "win32" | "posix";
export function styleFor(platform: NodeJS.Platform): PathStyle;

export function resolve(p: string, style: PathStyle, cwd?: string): string;
// win32: drive-relative ("C:foo"), rooted ("\foo"), UNC, and \\?\ verbatim prefixes handled
//   (fixes workspacePath.ts:52 mis-parsing \\?\C:\ as UNC server "?"); posix: lexical resolve.
export function normalizeSeparators(p: string, style: PathStyle): string;
export function toPosix(p: string): string;             // "\" → "/" only for win32-shaped input
export function join(style: PathStyle, ...parts: string[]): string;
export function dirname(p: string, style: PathStyle): string;  // win32: never yields drive-relative "C:"
export function basename(p: string): string;            // both separator families
export function isAbsolute(p: string, style: PathStyle): boolean;
export function samePath(a: string, b: string, style: PathStyle): boolean;
// win32: case-folded + separator-normalized + trailing-sep-stripped; posix: exact.
export function canonicalKeyLexical(p: string, style: PathStyle): string;  // the map/Set key form
export function fromFileUrl(url: string, style: PathStyle): string;
export function toFileUrl(p: string, style: PathStyle): string;
// win32: UNC hosts only for win32 style (fixes DesktopMarkdown.tsx:660 emitting \\host\ on POSIX).
export function localPathPattern(kind: "posix" | "win32" | "any"): RegExp;
// One source for the redaction + auto-link regex family (5 drifted copies today).
export function normalizeZipPath(p: string): string;    // backslash→slash, dot-segment squash
```

`src/utils/workspacePath.ts` becomes `canonicalWorkspacePath = (d, pl) => pathString.canonicalKeyLexical(resolve(d, styleFor(pl)), styleFor(pl))` re-exports, then is deleted. Renderer imports it via repo-root relative path (per the desktop engineering rule; electron-vite bundles it fine because it has zero node imports).

### 1.3 `text.ts` — the EOL/encoding contract (platform-independent by design)

This module has no platform branches; it exists so line endings and encodings are decided **once** instead of at 20 call sites.

```ts
export type Eol = "\n" | "\r\n";
export function detectEol(content: string): Eol;                       // dominant EOL, default "\n"
export function normalizeLineEndings(s: string): string;               // \r\n and lone \r → \n
export function normalizeLineEndingsBytes(b: Uint8Array): Uint8Array;  // byte-safe (from winSandboxPrebuilt.ts:51)
export function restoreEol(s: string, eol: Eol): string;

export function replaceRespectingEol(
  content: string, oldString: string, newString: string,
  opts?: { replaceAll?: boolean },
): { ok: true; content: string; replacements: number }
 | { ok: false; reason: "not_found" | "not_unique" };
// THE read/edit contract: match on LF-normalized haystack+needle, apply, re-emit the file's
// original dominant EOL. Fixes the CRITICAL edit.ts:58 failure (every multi-line edit fails on
// CRLF checkouts) without corrupting files to mixed EOL and without changing read's LF view.

export function decodeTextBuffer(bytes: Uint8Array, opts?: { fatal?: boolean }):
  { text: string; encoding: "utf-8" | "utf-16le" | "utf-16be"; hadBom: boolean };
// BOM sniff (EF BB BF / FF FE / FE FF), strip, decode. One helper for read.ts, the 8 existing
// ad-hoc BOM strippers, and ArtifactPreviewService.

export function decodeChildOutput(bytes: Uint8Array, opts?: { encoding?: string }): string;
// Never splits a UTF-8 code point at a maxBuffer truncation boundary (execFileCompat.ts:111 bug).

export function splitLines(text: string): string[];                    // LF / CRLF / lone CR
export function subscribeLines(stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void, opts?: { encoding?: string }): Promise<void>;
// Promoted from src/utils/subprocess.ts — the one stream-to-lines primitive.
```

### 1.4 `paths.ts` — filesystem-aware path semantics

```ts
export type CaseSensitivity = "sensitive" | "insensitive";
export function fsCaseSensitivity(platform?: NodeJS.Platform): CaseSensitivity;
// win32: insensitive. darwin: insensitive (default APFS — today nothing case-folds darwin, which
// is why '.GIT/hooks' bypasses the metadata guard there). linux: sensitive.

export function canonicalize(p: string): Promise<string>;
export function canonicalizeSync(p: string): string;
// Promoted from src/utils/paths.ts canonicalizePathForBoundaryCheck{,Sync}. BOTH use the NATIVE
// realpath engine (fs.realpathSync.native / the async native equivalent) with the
// longest-existing-prefix walk — the sync/async and permissions.ts variants collapse into this
// one, so canonical forms string-match everywhere.
// win32: resolves subst/mapped drives + on-disk casing; darwin: /tmp→/private/tmp firmlinks;
// linux: symlinks. Replaces the string-alias hack canonicalTmpAlias (policy.ts:333).

export function canonicalKey(p: string, platform?: NodeJS.Platform): string;
// canonicalizeSync + case-fold when fsCaseSensitivity is "insensitive" + strip trailing sep.
// THE key for Maps/Sets/locks (repl stateStore, workspaceRoots, pairing lock, workspace context).

export function samePath(a: string, b: string, platform?: NodeJS.Platform): boolean;
export function isInside(parent: string, child: string,
  opts?: { platform?: NodeJS.Platform; allowEqual?: boolean }): boolean;
// path.relative over canonicalized inputs, case-folded per fsCaseSensitivity; drive/UNC crossing
// → outside; "..foo" children handled. Replaces BOTH families (path.relative copies and the
// case-sensitive startsWith(root + sep) copies), including policy.ts:302 inside the sandbox.
export function assertWithinRoots(roots: string[], target: string): string; // throws; returns canonical
// One implementation for the server (webDesktopRoutes.ts:51) and desktop (validation.ts:77) twins.

export function crossesProtectedMetadata(base: string, target: string,
  platform?: NodeJS.Platform): boolean;
// Segment compare case-folded on win32 AND darwin — closes the '.GIT'/'.Cowork' bypass.
export { PROTECTED_METADATA_DIR_NAMES } from re-home;

export function isAbsoluteAnyPlatform(p: string): boolean;       // foreign-recorded paths (imports)
export function isFullyQualified(p: string, platform?: NodeJS.Platform): boolean;
// win32: rejects drive-relative "C:foo" and rootless "\foo" (config.ts:411); posix: isAbsolute.

export function toPosixRelative(from: string, to: string): string;   // the 10x split(sep).join("/") idiom
export function fromPosixRelative(root: string, rel: string): string;

export function home(env?: NodeJS.ProcessEnv): string;
// ONE precedence, everywhere: os.homedir(), overridable only via the explicit test/embedding
// lever COWORK_HOME_OVERRIDE. Deliberately NOT HOME-first on Windows: a Git-Bash HOME must never
// split auth from config again (CLAUDE.md scar tissue). POSIX behavior unchanged (os.homedir()
// reads $HOME). resolveAuthHomeDir keeps a one-time legacy-location read + warning for migration.
export function coworkHome(env?: NodeJS.ProcessEnv): string;         // join(home(env), ".cowork")
export function coworkPaths(env?: NodeJS.ProcessEnv): {
  root: string; authDir: string; codexAuthDir: string;   // codexAuthDir kills the 8-site assembly
  runtimeDir: string; binDir: string; skillsDir: string; chatsDir: string; configDir: string;
};
export function expandHome(p: string, opts?: { home?: string }): string;
// "~/x" only; "~user/x" throws (never silently mis-expand as $HOME/user).
export function displayPath(p: string, opts?: { home?: string }): string;
// Human UI ONLY (abbreviates home as ~). Model-visible text always uses absolute paths.

export function validateFileName(name: string): { ok: true } | { ok: false; reason: string };
export function sanitizeFileName(name: string, opts?: { replacement?: string }): string;
// One PORTABLE rule set applied on ALL platforms: both separator families, NUL, ":", trailing
// dots/spaces, reserved device names (CON, NUL, PRN, AUX, COM1-9, LPT1-9), length cap.
export function timestampSegment(date?: Date): string;              // filename-safe ISO, no ":"

export function findGitRoot(startDir: string): Promise<string | null>;
export function findGitRootSync(startDir: string): string | null;   // drive/UNC-root loop-safe

export function normalizeGlobPattern(pattern: string, platform?: NodeJS.Platform): string;
// Backslash→slash ONLY when host is win32 or the pattern is win32-shaped; preserves POSIX
// fast-glob escapes like "\*" (fixes glob.ts:38 destroying them).
export function splitAbsoluteGlob(pattern: string, platform?: NodeJS.Platform):
  { root: string; rest: string } | null;                             // drive-qualified root on win32
```

### 1.5 `env.ts`

```ts
export function getEnv(env: Record<string, string | undefined>, name: string,
  platform?: NodeJS.Platform): string | undefined;
// win32: case-insensitive scan; POSIX: exact key only (env IS case-sensitive there — fixes the
// 7 copies that are case-insensitive on Linux too).
export function findEnvKey(env, name, platform?): string | undefined;  // preserved spelling ("Path")
export function setEnv(env, name, value, platform?): void;             // writes existing spelling on win32
export function pathDelimiter(platform?: NodeJS.Platform): ";" | ":";
export function readPathValue(env, platform?): string;                 // getEnv(env, "PATH") ?? ""
export function splitPathValue(value: string, platform?): string[];    // quote-aware on win32
export function dedupePathDirs(dirs: string[], platform?): string[];   // shell.ts private, exported
export function mergePathDirs(env, dirs: string[],
  opts: { position: "prepend" | "append"; platform?: NodeJS.Platform }): Record<string, string>;
export function runtimePathDirs(runtime: { bin?: string; node?: string; python?: string;
  git?: string; popplerBin?: string }, platform?): string[];
// THE single answer to the Scripts-dir question: <python>/Scripts is added win32-only.
// Consumed by BOTH the shell.ts string prelude and coworkRuntime buildRuntimeEnv (they disagree today).

export function defaultChildEnv(platform?, base?: NodeJS.ProcessEnv): Record<string, string>;
// win32: guarantees SystemRoot, windir, COMSPEC, PATH, PATHEXT, USERPROFILE, HOMEDRIVE/HOMEPATH,
// APPDATA, LOCALAPPDATA, ProgramData, ProgramFiles(+x86), TEMP/TMP, NUMBER_OF_PROCESSORS.
// posix: PATH, HOME, LANG/LC_*, TERM, SHELL, USER, TMPDIR.
export function childEnv(overrides: Record<string, string | undefined>,
  platform?): Record<string, string>;
// defaultChildEnv + overrides with win32 case-aware key merging. Fixes the MCP stdio bug
// (mcp/index.ts:256: configured env replaces instead of merging → children lose SystemRoot).

export function sandboxEnvAllowlist(platform?): ReadonlySet<string>;
// Base list + win32 additions: USERPROFILE, HOMEDRIVE, HOMEPATH, APPDATA, LOCALAPPDATA,
// ProgramData, ProgramFiles(+x86), PYTHONUTF8, PYTHONIOENCODING. Fixes sandboxed git/gh/npm
// losing their config/credential dirs on Windows (bash.ts:30).
export function minimalSandboxEnv(source?: NodeJS.ProcessEnv,
  platform?): Record<string, string>;   // moved from bash.ts; preserves inherited key spelling
```

### 1.6 `exec.ts` — executable resolution (no spawning; injectable `exists` for tests)

```ts
export type ExecutableKind = "native" | "batch-shim" | "powershell-script" | "script";
export function executableCandidates(name: string,
  opts?: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }): string[];
// win32: PATHEXT-derived ordered extensions (default ".COM;.EXE;.BAT;.CMD"); posix: [name].
// Replaces the hardcoded list in bash.ts:246 and the private copy in codexAppServerResolver.ts:292.
export function which(name: string, opts?: { env?; cwd?: string; platform?;
  exists?: (p: string) => boolean; skipDirs?: string[] }): string | null;
// The ONE resolver: case-insensitive PATH key, quote-aware PATH split, PATHEXT on win32,
// absolute-candidate passthrough. skipDirs covers the codex node_modules/.bin rule.
export function whichAll(name: string, opts?): string[];
export function classifyExecutable(p: string, platform?): ExecutableKind;   // .cmd/.bat → batch-shim
export function resolveSpawn(fileOrName: string, args: string[], opts?): {
  file: string; args: string[]; kind: ExecutableKind;
};
// THE shim-aware pre-spawn step: batch shims are wrapped as `cmd.exe /d /s /c` with
// BatBadBut-safe quoting; args containing cmd metacharacters that cannot be safely quoted
// produce a typed error instead of silent mangling. Native binaries pass through untouched.
// posix: identity. Fixes rg.cmd / codex.cmd / gh.cmd shims failing under shell-less Bun.spawn.
export function binaryName(base: string, platform?): string;   // "rg" → "rg.exe" (managed installs)
```

### 1.7 `proc.ts` — process lifecycle

```ts
export type RunResult = { stdout: string; stderr: string; exitCode: number; errorCode?: string };
export type CloseInfo = { reason: "exited" | "terminated"; code: number | null };

export function run(file: string, args: string[], opts?: ExecFileCompatOptions & {
  resolve?: boolean;                 // route through exec.resolveSpawn (shim-aware)
  encoding?: string;                 // decoded via text.decodeChildOutput
}): Promise<RunResult>;
// execFileCompat becomes this module's engine (utils/execFileCompat.ts re-exports during
// migration). Children are spawned in their own process GROUP on posix (detached) and attached
// to a Job Object on win32 where available, so a tree handle exists at kill time. Timeout/abort/
// overflow now kill the TREE (fixes orphaned npm/dev-server grandchildren on every bash timeout).
// Same errorCode contract as today (TIMEOUT/124, ABORT_ERR/130, ENOENT, MAXBUFFER).

export interface ChildHandle {  // absorbs StreamingSubprocess (utils/subprocess.ts)
  pid: number; exited: Promise<CloseInfo>;
  stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>;
  kill(signal?: NodeJS.Signals): void;
  killTree(): Promise<void>;
  terminateGracefully(opts?: { graceMs?: number }): Promise<CloseInfo>;
}
export function spawnStreaming(file: string, args: string[], opts?): ChildHandle;

export function isAlive(pid: number): boolean;
// ONE documented policy for all four lock/job probes: ESRCH → dead; EPERM → alive; ANY other
// error (win32 OpenProcess EINVAL etc.) → alive (conservative, never steal).

export function killTree(target: number | ChildHandle, opts?): Promise<void>;
// posix: kill(-pgid) (children were spawned detached); win32: Job Object close, else
// `taskkill /PID <pid> /T /F`.

export function terminateGracefully(handle: ChildHandle,
  opts: { graceMs?: number }): Promise<CloseInfo>;
// posix: SIGTERM → wait graceMs → killTree. win32: signal-free shutdown request (stdin-EOF
// sentinel, or the child's `server/shutdown` RPC when the caller wires it) → wait → killTree.
// Replaces the 4 divergent escalation copies; on Windows there is finally a real graceful phase
// instead of two identical TerminateProcess calls.

export function registerShutdownSignals(handler: () => Promise<void> | void): () => void;
// posix: SIGINT/SIGTERM/SIGHUP; win32: SIGINT + stdin-EOF watcher. Returns unregister.
export function onShutdownRequest(handler: () => Promise<void> | void): () => void;  // child side
```

**WebSocket-first note:** the Windows-functional shutdown requires a `server/shutdown` JSON-RPC method (route under `src/server/jsonrpc/routes/`, registered in `routes/index.ts`, documented in `docs/websocket-protocol.md`). `docs/bundling-guide.md`'s "send SIGTERM to flush snapshots" contract becomes "call `server/shutdown` (or close stdin); SIGTERM also works on POSIX."

### 1.8 `shell.ts` — extended (existing exports preserved)

```ts
// EXISTING (kept): PlatformShellExecutionStep, quotePosixShellValue,
// quotePowerShellSingleQuotedValue, buildPlatformShellExecutionPlan,
// buildPlatformShellCommandWithRuntimePrelude.

export type ShellDialect = "posix" | "powershell";
export function shellDialect(platform?: NodeJS.Platform): ShellDialect;
export function quoteShellValue(value: string, dialect: ShellDialect): string;
// One entry point; the PowerShell path also neutralizes U+2018/U+2019 smart quotes.

export type PlatformShellExecutionStep = {
  file: string; args: string[];
  displayCommand?: string;   // NEW: original script for logs (win32 args are now opaque base64)
};

// CHANGED BEHAVIOR (same signature):
export function buildPlatformShellExecutionPlan(platform, command, opts?): PlatformShellExecutionStep[];
// win32: pwsh → powershell.exe, args = [-NoProfile, -NonInteractive, -ExecutionPolicy, Bypass,
//   -EncodedCommand, base64(utf16le(prelude + "; " + command))]. EncodedCommand removes the
//   PowerShell CLI re-parse layer — embedded quotes/backticks/$ survive byte-exact, closing the
//   3-parse-layers hazard (shell.ts:48). The module-owned prelude pins encoding on BOTH pwsh and
//   5.1: [Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8;
//   $env:PYTHONUTF8='1'. Exit code propagated with a trailing `exit $LASTEXITCODE` guard.
// posix: $SHELL honored ONLY when its basename is sh-compatible (bash/zsh/sh/dash/ksh); fish/
//   nushell start at /bin/bash instead (their non-ENOENT failures never reach today's fallback).
//   Still `-lc` (login shell) — see profile policy below.

export function encodingPrelude(platform?): string;         // exported for tests; "" on posix

export function promptGuidance(opts?: { platform?: NodeJS.Platform;
  executor?: "cowork" | "codex" | "external" }): string;
// Renders the HOST's dialect guidance only (3-6 lines), for the system prompt's
// {{shellExecutionPolicy}} variable AND the bash tool description. Returns "" when
// executor === "codex" (Codex owns its own shell — stops the contradictory double-instructions).

export function pythonInvocation(env?: NodeJS.ProcessEnv, platform?): {
  command: string;      // e.g. "python" (win32, guaranteed by the PATH prelude) or "python3"
  display: string;      // the exact string to render into prompts/harness commands
};
// COWORK_RUNTIME_PYTHON's absolute path when the managed runtime is present; otherwise bare
// "python"/"python3". NEVER `py -3` (registry-resolved, bypasses the runtime PATH prelude).

export interface PlatformCommands {  // absorbs packages/harness/src/platformCommands.ts
  runPythonScript(scriptPath: string): string;    // uses pythonInvocation, never py -3
  printWorkingDirectory(): string;                // (Get-Location).Path | pwd
  listDirectory(dirPath?: string): string;        // Get-ChildItem -Force | ls -la
  countLines(filePath: string): string;           // Measure-Object -Line (-Encoding UTF8) | wc -l
}
export function commands(platform?: NodeJS.Platform): PlatformCommands;
```

**Documented profile policy (one paragraph, in the module docstring):** the contract is "user-installed tool PATH must be visible to agent commands." POSIX achieves it with login shells (`-lc`) because GUI/daemon launches strip PATH on macOS. Windows achieves it with `-NoProfile` because user/machine PATH comes from the registry and is already in the inherited environment; PowerShell profiles are not needed for PATH and are a common source of startup noise. This asymmetry is intentional and now written down — it stops being re-"fixed" in either direction.

`packages/harness/src/platformCommands.ts` becomes `export { commands as createHarnessPlatformCommands } ...` (it already imports from `../../../src/platform/shell`, so no packaging change).

### 1.9 `fs.ts`

```ts
export function writeFileAtomic(filePath: string, data: string | Uint8Array,
  opts?: { mode?: number; fsync?: boolean }): Promise<void>;
// temp-in-same-dir + rename-over. win32: EPERM/EACCES/EBUSY retry with backoff (absorbs
// src/utils/atomicFile.ts — the ONE strategy; delete-first and copyFile-over stances are retired).
export function replaceFileAtomic(sourcePath: string, destPath: string): Promise<void>;
// rename-over with win32 retry; EXDEV → copy+fsync+rename fallback. Never delete-first
// (no zero-file window — fixes coworkRuntime/install.ts:28).
export function replaceExecutableAtomic(sourcePath: string, destPath: string):
  Promise<{ finalPath: string }>;
// win32: rename the RUNNING exe aside (dest.old-<pid>), rename new into place, best-effort
// cleanup of aside files; posix: plain rename. Lets the codex resolver and ripgrep converge on
// ONE promoted path on all platforms (un-forks the darwin-vs-win32 pinned tests).
export function moveWithFallback(src: string, dest: string): Promise<void>;
// EXDEV → copy+rm; win32 lock codes → bounded retry then a TYPED lock error (never blanket-catch).
export function removeWithRetry(p: string, opts?: { recursive?: boolean }): Promise<void>;
// win32: EPERM/EBUSY/ENOTEMPTY bounded retries; posix: plain rm. The two test-only rm loops and
// the swallowed auth.json delete converge here.
export function removeDirBestEffort(p: string): Promise<void>;
// Cleanup-path semantics: win32 transient codes are ignorable (mutationGuard.ts:34 fix).

export interface LockHandle { release(): Promise<void>; heartbeat(): Promise<void>; }
export function acquireLockDir(lockPath: string, opts?: { staleMs?: number;
  heartbeatMs?: number; signal?: AbortSignal }): Promise<LockHandle>;
// mkdir-based. Contention = EEXIST PLUS win32 transient EPERM/EACCES (retried). Stale break
// gated on proc.isAlive(owner) with the single documented policy; heartbeat rewrites owner.json
// (never utimes — coarse-mtime filesystems). Replaces all five lock implementations.

export function copyTree(src: string, dest: string, opts?: {
  symlinks?: "dereference" | "skip" | "preserve"; onSkip?: (p: string) => void }): Promise<void>;
// Default: dereference with cycle guard (the strategy the deleted artifactRuntime migration
// converged on). "preserve" on win32 emits junctions for dirs and a typed EPERM error for file
// symlinks (advising Developer Mode); "skip" always calls onSkip (loud, not silent).
export function symlink(target: string, linkPath: string,
  opts?: { type?: "file" | "dir" }): Promise<void>;
// win32: dir → junction fallback (privilege-free); file → typed error when unprivileged.
export function openNoFollow(p: string): Promise<number>;
// posix: O_NOFOLLOW; win32: reparse-point rejection via lstat + post-open identity re-check.

export function hardenPrivateDir(p: string): Promise<void>;
export function hardenPrivateFile(p: string): Promise<void>;
// posix: 0o700 / 0o600. win32: owner-only DACL via icacls (Phase 1 ships an explicit documented
// no-op + debug log so the gap is visible, real DACL in a follow-up).

export function fingerprintTree(root: string, opts?: { normalizeEol?: boolean;
  ignore?: string[]; onCaseCollision?: "error" | "ignore" }): Promise<{ hash: string; fileCount: number }>;
// Deterministic: code-unit (byte) sort — NEVER localeCompare; POSIX-relative entry paths;
// optional CRLF normalization (text.normalizeLineEndingsBytes); case-fold collision detection per
// paths.fsCaseSensitivity. Replaces all five walk-sort-hash implementations.

export function isHiddenEntry(name: string, absPath?: string,
  platform?): boolean | Promise<boolean>;
// dot-prefix and "~$" everywhere; win32 additionally FILE_ATTRIBUTE_HIDDEN when absPath given.
```

### 1.10 `approval.ts`

```ts
export type CommandRisk = "safe" | "review" | "dangerous";
export function classifyCommand(command: string,
  opts?: { platform?: NodeJS.Platform; dialect?: ShellDialect }):
  { risk: CommandRisk; matchedPattern?: string };
// Dialect derived from shell.shellDialect(platform); pattern tables per dialect held in an
// EXHAUSTIVE Record<ShellDialect, ...> — a new dialect cannot compile without a table.
// posix: today's rm -rf / dd of= / mkfs / find -delete / chmod -R / git reset --hard set.
// powershell (NEW): Remove-Item -Recurse/-Force, rd|rmdir /s /q, del|erase /f /s /q,
// Clear-Content, Format-Volume, Clear-Disk, Remove-Partition, Stop-Computer, Restart-Computer,
// Set-ExecutionPolicy, Remove-Item on \\.\ device paths, plus the git destructive set.
// Fixes the HIGH finding: Windows sessions are steered into PowerShell whose destructive verbs
// auto-approve today (utils/approval.ts:21) — approval parity lands on the platform whose sandbox
// is most often unavailable.
```

`src/utils/approval.ts` (`classifyCommandDetailed`) delegates here and keeps its public shape.

### 1.11 `archive.ts`

```ts
export function extractZip(archivePath: string, destDir: string,
  opts?: { onEntry? }): Promise<void>;
// Pure-JS yauzl engine promoted from src/coworkRuntime/archive.ts (symlink/mode/dupe handling,
// case-fold dupe check keyed on paths.fsCaseSensitivity — not win32-only). Identical behavior on
// all platforms; no PowerShell Expand-Archive, no `unzip` dependency.
export function extractTarGz(archivePath: string, destDir: string): Promise<void>;
// system tar when exec.which("tar") resolves; otherwise a typed MissingDependencyError naming
// the dependency and the platform remedy (pure-JS fallback is a later enhancement).
export function createTarGz(opts: { cwd: string; entries: string[]; outFile: string }): Promise<void>;
// Preflights which("tar"); the sessionBackup exit-127 mystery becomes a clear error.
```

### 1.12 `os.ts`

```ts
export function openExternal(url: string, opts?: { platform?: NodeJS.Platform }):
  Promise<{ ok: boolean; detail?: string }>;
// darwin: `open <url>` detached; linux: `xdg-open` detached; win32: `cmd.exe /d /s /c start "" <url>`
// detached with the scheme allowlisted to http(s) (replaces deprecated rundll32, which truncates
// long OAuth URLs). Honest tri-state result — callers (MCP OAuth, codex auth) print the URL as a
// fallback when ok=false. The Electron main process keeps shell.openExternal; this is the
// CLI/server path, and both now share detach-and-report semantics.
```

### 1.13 `sandbox/` — extensions (existing structure preserved)

```ts
// policy.ts — NEW exports
export function scratchRoots(platform?: NodeJS.Platform): string[];
// darwin: ["/tmp", "/private/tmp"]; linux: ["/tmp"]; win32: [os.tmpdir()].
// THE single scratch definition consumed by bwrap.ts, seatbelt.ts, windows.ts, AND
// src/runtime/codexAppServer/config.ts (codexScratchRoots deleted). Kills the three-way drift.
export function protectedMetadataPaths(roots: string[]): string[];
// collectExistingProtectedMetadataPaths promoted from bwrap.ts and shared by all three backends.
export function materializeWritableRoots(policy: SandboxPolicy): Promise<void>;
// kind-hint ensureDir/ensureFile pre-creation, shared (windows.ts currently ignores kinds).

// windows.ts — fixes inside the module
// - network flag via policyAllowsNetwork(policy) (not raw policy.network — latent inversion).
// - scratchRoots(platform) passed as writable roots (no-project-write parity with mac/linux).
// - protectedMetadataPaths(...) passed as explicit --deny-write args (tracks the shared constant).
// - sandboxHome default parameter REMOVED; callers must pass windowsSandboxHome(env).
export function windowsSandboxHome(env?: NodeJS.ProcessEnv): string;
// COWORK_WIN_SANDBOX_HOME ?? paths.coworkHome(). One resolver for detect.ts, windows.ts, the
// desktop, and (via --sandbox-home, which the Rust cwd_junction must start honoring) the helper.

export function verifyWindowsBundle(bundle: { helperPath: string; setupPath: string;
  runnerPath: string; manifestPath?: string },
  opts: { requireAuthenticode: boolean }): Promise<{ ok: boolean; detail?: string }>;
// Manifest schema + SHA-256 loop + ONE Get-AuthenticodeSignature probe (built on the shell plan's
// flag set), consumed by BOTH detect.ts and apps/desktop serverManager (deletes the copy-paste).

// detect.ts — behavior fixes
// - probeWindowsSandboxBundle memoized per (helperPath, sandboxHome) with a TTL — today it
//   re-hashes three binaries and spawnSyncs `helper probe` on EVERY sandboxed bash call.
// - hasSeatbelt()/isBwrapUsable() negative results get a cooldown re-probe (a transient codesign
//   timeout no longer disables the sandbox until restart).

// denied.ts → classifyDenial with per-platform marker tables:
// posix: inject LC_MESSAGES=C into sandboxed children (via env.minimalSandboxEnv) so markers
//   match regardless of user locale; linux/darwin glibc/curl phrasings as today.
// win32: add "No such host is known", "The remote name could not be resolved", WSAHOST_NOT_FOUND
//   and localized-access-denied handling keyed on Win32 error codes where present.
```

---

## 2. Migration map

Priorities: **P0** = active ping-pong sources + agent toolbelt (`src/tools`); **P1** = server / runtime / providers; **P2** = scripts, desktop-benign, adjacent programs. Sites are representative; the audit's full site lists apply per cluster.

| # | Hazard / divergence cluster (representative sites) | Replacing API | Priority |
|---|---|---|---|
| 1 | Repo line endings unpinned: Biome fails wholesale on Windows checkouts; 5 hand-rolled CRLF normalizers; byte-divergent fingerprints (`biome.json:34`, `winSandboxPrebuilt.ts:49`) | Root `.gitattributes` (`* text=auto eol=lf` + binary exceptions) + one `git add --renormalize .` commit; `text.normalizeLineEndings` for user-provided trees | **P0** (Phase 0) |
| 2 | PowerShell 3-parse-layer corruption + no output encoding pin (`src/platform/shell.ts:42-54`); mojibake decode (`execFileCompat.ts:126`), mid-code-point maxBuffer cut (`:111`) | `shell.buildPlatformShellExecutionPlan` (`-EncodedCommand` + encoding prelude); `proc.run` + `text.decodeChildOutput` | **P0** |
| 3 | Split exe resolution in the bash tool: sandboxed lane hand-rolled walk vs unsandboxed Bun.spawn PATH (`bash.ts:239/:393`), hardcoded ext list (`:246`), local `readPathVar` (`:221`) | `exec.which` used by BOTH lanes; `env.readPathValue` | **P0** |
| 4 | Sandbox env strips Windows profile vars; no PYTHONUTF8 (`bash.ts:30/:35`) | `env.sandboxEnvAllowlist` + `env.minimalSandboxEnv` | **P0** |
| 5 | **CRITICAL** read/edit EOL split: multi-line edits always fail on CRLF checkouts; LF splice corrupts CRLF files (`edit.ts:58/:83`, `read.ts:119-120`); no BOM/UTF-16 handling in read | `text.replaceRespectingEol` in edit; `text.decodeTextBuffer` in read (read stays LF-normalized — documented canonical view) | **P0** |
| 6 | Glob/grep pattern mangling: backslash rewrite destroys POSIX escapes (`glob.ts:38/:67`), `"/"` fallback root (`glob.ts:78`), deny-glob separator corruption (`grep.ts:37`) | `paths.normalizeGlobPattern`, `paths.splitAbsoluteGlob`, `paths.toPosixRelative` | **P0** |
| 7 | Approval classifier knows only POSIX destructive vocabulary → `Remove-Item -Recurse -Force` auto-approves on Windows (`utils/approval.ts:21-46`) | `approval.classifyCommand` (per-dialect tables) | **P0** |
| 8 | Model-as-translator prose: 14 hand-synced copies of Windows shell rules; Codex sessions get contradictory shell instructions (`prompts/system.md:100`, 11 model templates, `prompt.ts:559/:672`, `bash.ts:419-434`, `codexAppServer/config.ts:136`) | `shell.promptGuidance` rendered into a `{{shellExecutionPolicy}}` template variable; `executor:"codex"` renders `""` | **P0** |
| 9 | Three conflicting Python answers (`py -3` prose vs bundled-path instruction vs PATH prelude) (`platformCommands.ts:18`, `ensureReady.ts:482`, `prompt.ts:565`, `bash.ts:434`) | `shell.pythonInvocation` consumed by prompts, runtime instructions, and `shell.commands`; delete all `py -3` text | **P0** |
| 10 | grep-tool bootstrap can spawn `rg.cmd` shims shell-less; dead `.cmd/.bat` candidates (`ripgrep.ts:309/:318` → `grep.ts:110`) | `exec.resolveSpawn` + `exec.binaryName` | **P0** |
| 11 | Model-visible `~/.cowork/skills` tilde labels that no tool expands (`skill.ts:14`, `prompt.ts:429`) | Render `config.skillsDirs` absolute paths (one shared helper); `paths.displayPath` for human UI only | **P0** |
| 12 | Protected-metadata case bypass: `.GIT/hooks` passes on win32/darwin (`utils/paths.ts:52`) | `paths.crossesProtectedMetadata` (case-fold per `fsCaseSensitivity`) | **P0** (security) |
| 13 | Containment predicate families: case-sensitive `startsWith` INSIDE the sandbox (`policy.ts:302`), server/desktop `assertPathWithinRoots` twins (`webDesktopRoutes.ts:51` vs `validation.ts:77`), 12 more copies | `paths.isInside` / `paths.assertWithinRoots` | **P0** sandbox+tools; **P1** server/desktop |
| 14 | Bash timeout orphans grandchild trees; no tree kill anywhere (`execFileCompat.ts:74`) | `proc.run` (group/Job-Object spawn) + `proc.killTree` | **P0** |
| 15 | Sandbox backend parity: windows scratch/carve-outs/kinds/network (`windows.ts:36-53`), triplicated scratch roots (`codexAppServer/config.ts:308`, `bwrap.ts:102`, `seatbelt.ts:136`) | `sandbox.scratchRoots`, `sandbox.protectedMetadataPaths`, `sandbox.materializeWritableRoots`, `policyAllowsNetwork` inside `windows.ts` | **P0** |
| 16 | Windows probe re-hashes 3 binaries + spawns helper per bash call; seatbelt/bwrap sticky-false caches (`detect.ts`) | memoized probe with TTL + cooldown re-probe | **P0** |
| 17 | Denial classification: English-only markers, no WSA/.NET network phrasings → escalation prompt never fires for Windows/non-English (`denied.ts:21/:35`) | `sandbox.classifyDenial` (per-platform tables + `LC_MESSAGES=C` injection) | **P0** |
| 18 | execFileCompat test fixture runs POSIX scripts under `cmd /c` — 6/10 tests fail on Windows; suite absent from Windows CI (`test/fixtures/execFileCompatChild.ts:7`, `test/execFileCompat.test.ts`) | fixtures built via `shell.buildPlatformShellExecutionPlan` (or portable `bun -e` children) | **P0** (enabler) |
| 19 | Atomic-write anarchy: 3 contradictory strategies, 15 sites, same `state.json` written two ways (`atomicFile.ts`, `persistence.ts:582` vs `webDesktopService.ts:872`, `ArtifactVersionStore.ts:163`, `install.ts:28`, `ripgrep.ts:283`, `sessionStore.ts:121`, `spreadsheetEdit.ts:134`, `metadata.ts:84`, +6) | `fs.writeFileAtomic` / `fs.replaceFileAtomic` everywhere | **P0** API + canonical writers; **P1** long tail |
| 20 | Executable-replace fork: codex win32 serves `versions/`, darwin `current/`, opposite pinned tests; ripgrep does naive rm+rename (`codexAppServerResolver.ts:444/:592`, `ripgrep.ts:274`) | `fs.replaceExecutableAtomic`; both platforms converge on `current/`; un-fork the two pinned tests | **P1** |
| 21 | Home-dir resolution, five precedences; conversation import is a no-op on Windows (`ServerRuntime.ts:626` HIGH); auth/config split under Git-Bash HOME (`authHome.ts:30`, `config.ts:466`, `coworkHome.ts:4`, `presentationPreview.ts:51`, `pairing.ts:61`, `bedrockShared.ts:107`, +6) | `paths.home` / `paths.coworkHome` / `paths.coworkPaths` | **P1** (do first in phase) |
| 22 | MCP stdio children spawned without SystemRoot/PATH when config sets env (`mcp/index.ts:256` HIGH) | `env.childEnv` before `StdioClientTransport` | **P1** |
| 23 | `~/.cowork/auth/codex-cli` assembled inline at 8 sites via 2 resolver families (`codexAppServerClient.ts:88`, `AgentSession.ts:1679/:1713`, `connectionCatalog.ts:102`, +4) | `paths.coworkPaths().codexAuthDir` | **P1** |
| 24 | Case-insensitive env lookup ×7 + case-sensitive outliers (`runtime.ts:24`, `ensureReady.ts:44/:217`, `libreOffice.ts:87`, `codexAppServerClient.ts:409`, `codexAppServerResolver.ts:304`) | `env.getEnv` / `env.findEnvKey` | **P1** |
| 25 | PATH building split: Scripts-dir disagreement, duplicate dedupe/delimiter (`runtime.ts:24-104` vs `shell.ts:98`) | `env.runtimePathDirs` + `env.mergePathDirs` consumed by both | **P1** |
| 26 | Graceful-kill divergence ×4; Windows always hard-kills; snapshots never flush (`webDesktopService.ts:659`, `serverManager.ts:615`, `codexAppServerClient.ts:377`, `githubToken.ts:46`) | `proc.terminateGracefully` + `server/shutdown` JSON-RPC route (+ `docs/websocket-protocol.md`) | **P1** |
| 27 | Shutdown wiring signal-only, dead on Windows (`server/index.ts:307`, `repl.ts:741`, `start_web_dev.ts:211`) | `proc.registerShutdownSignals` / `proc.onShutdownRequest` | **P1** |
| 28 | PID-liveness ×4, two opposite policies (`SkillImprovementService.ts:184` vs `fileLock.ts:64` et al.) | `proc.isAlive` | **P1** |
| 29 | Cross-process locks ×5 (EEXIST-only bootstrapLock; unlink-live-lock JobStore hot-spin) (`bootstrapLock.ts:107`, `JobStore.ts:504`, `fileLock.ts:141`, `writeCoordinator.ts:236`, `SkillImprovementService.ts:571`) | `fs.acquireLockDir` | **P1** |
| 30 | Subprocess wrapper ×4 with 3 contracts (`sessionBackup/command.ts:14`, `libreOffice.ts:37`, `githubToken.ts:46`, `subprocess.ts`) | `proc.run` / `proc.spawnStreaming` | **P1** |
| 31 | Codex `.cmd` discovery vs shell-less spawn probe; manual PATH walk (`codexAppServerResolver.ts:292/:308/:395`) | `exec.which` + `exec.resolveSpawn` (+1 unmocked win32 spawn test) | **P1** |
| 32 | Delete-with-open-handle: logout leaves credentials on Windows (`codexAppServerAuth.ts:685` — also reorder close-before-delete), test rm loops ×2 | `fs.removeWithRetry` | **P1** |
| 33 | Move/rename ×5 with 4 failure policies (`webDesktopRoutes.ts:217`, `persistence.ts:521`, `migrateAgentConfig.ts:177`, `fileHardening.ts:26`) | `fs.moveWithFallback` | **P1** |
| 34 | Symlink handling: EPERM plugin imports, silent release skips, no O_NOFOLLOW on win32 (`conversion.ts:47`, `archive.ts:128`, `releaseBuildUtils.ts:103`, `ipc/files.ts:576`) | `fs.copyTree` / `fs.symlink` / `fs.openNoFollow` | **P1** |
| 35 | POSIX-mode hardening no-op on Windows ×7 (`fileHardening.ts:6`, `oneOffChats.ts:82`, `bootstrapLock.ts:64`, +4) | `fs.hardenPrivateDir` / `hardenPrivateFile` | **P1** |
| 36 | bare-`tar`/zip extraction ×4 mechanisms (`sessionBackup/tar.ts:9`, `ripgrep.ts:184/:196`, `codexAppServerResolver.ts:516`, `releaseBuildUtils.ts:210`) | `archive.extractZip` / `extractTarGz` / `createTarGz` | **P1** (release scripts P2) |
| 37 | URL opening via rundll32 breaks long OAuth URLs (`browser.ts:15`) | `os.openExternal` | **P1** |
| 38 | Filename validation trio: ADS `":"`, reserved device names, desktop rename validates nothing (`webDesktopRoutes.ts:60`, `ipc/files.ts:446`, `webFetch.ts:204`) | `paths.validateFileName` / `sanitizeFileName` on both surfaces | **P1** |
| 39 | Path-equality bypasses: CLI resume keys, import matchers, approved-roots Set, task byte-equality (`stateStore.ts:23`, `workspaceMapping.ts:25`, `service.ts:131/:170`, `workspaceRoots.ts:67`, `jsonrpc/routes/shared.ts:58`) | `paths.canonicalKey` / `paths.samePath` / `paths.canonicalize` | **P1** |
| 40 | Claude-Code project-dir decode fails for Windows encodings (`adapters/claudeCode.ts:36`); foreign-absolute classification (`adapters/codex.ts:97`) | importer helper on `pathString` (host-independent both-encodings decode); `paths.isAbsoluteAnyPlatform` | **P1** |
| 41 | Windows sandbox home ×4 values incl. Rust helper ignoring `--sandbox-home` (`detect.ts:102`, `windows.ts:36`, `serverManager.ts:948`, `cwd_junction.rs:25`) | `sandbox.windowsSandboxHome` + Rust fix to honor the flag | **P1** |
| 42 | Duplicated bundle trust verification (hash+Authenticode) (`serverManager.ts:359-375` vs `detect.ts:54-95`) | `sandbox.verifyWindowsBundle` | **P1** |
| 43 | Hand-assembled PowerShell invocations ×5 flag-sets, quoter ×4 copies (`ripgrep.ts:157/:185`, `releaseBuildUtils.ts:206/:213`, `detect.ts:70`) | `shell.buildPlatformShellExecutionPlan` + `quoteShellValue` (mostly deleted by #36/#42) | **P1**/P2 |
| 44 | Tree-fingerprint hashers ×5 (localeCompare sorts, mtime cache, raw-byte skill hashes) (`sourceFingerprint.ts:47`, `sessionBackup/fingerprint.ts:24`, `winSandboxPrebuilt.ts:93`, `build_desktop_resources.ts:90`, `integrity.ts:86`) | `fs.fingerprintTree` (skills opt into `normalizeEol`, hash-domain bumped to v2) | **P1** skills; **P2** build scripts |
| 45 | Renderer hand-rolled path lib ×2 + 7 basename copies + drifted explorer normalizers (`DesktopMarkdown.tsx`, `FilePreviewModal.tsx`, `explorer.ts:158`, `filePreviewKind.ts:112`) | `pathString.*` with server-reported platform threaded | **P1** (user-visible bugs) |
| 46 | Redaction/auto-link local-path regex family ×5 (privacy-relevant drift) | `pathString.localPathPattern` | **P1** |
| 47 | Hidden-entry semantics ×2, no FILE_ATTRIBUTE_HIDDEN (`webDesktopRoutes.ts:73`, `explorerVisibility.ts:3`) | `fs.isHiddenEntry` | **P2** |
| 48 | Desktop spawn/env injectability (`serverManager.ts:910` direct `process.platform`; `:1383` bare `bun`) | thread `hostPlatform()` param; `exec.which("bun")` | **P2** |
| 49 | Bun-segfault retry lane smeared across 2 files + tests (`serverPlatform.ts:8`, `serverManager.ts:1490`) | consolidate desktop-local behind one seam (stays in exempt dir) | **P2** |
| 50 | Target-triple / asset-name mapping ×6 (`sidecar.ts:50`, `build_desktop_resources.ts:331`, `winSandboxPrebuilt.ts:23`, `codexAppServerResolver.ts:174`, `ripgrep.ts:54`, `releaseBuildUtils.ts:255`) | one mapping module in `scripts/releaseBuildUtils.ts` (npm-packed), `sidecar.ts` re-exports | **P2** |
| 51 | Startup readiness as per-platform timeout constants (verified same-day ping-pong) (`serverManager.ts:645`) | heartbeat-based readiness (timeout per silent interval) on the existing bootstrap-progress events | **P2** |
| 52 | Desktop chrome contract ×4 copies, 3 platform vocabularies, linux-copies-win32 (`platformChrome.ts`, `desktopPlatform.ts:59`, `win32.css`/`linux.css`, `webAdapter.ts:777`) | single chrome-contract module generating CSS tokens; `host.toDesktopPlatform` | **P2** (exempt dir, still consolidate) |
| 53 | Release signing / updater-channel policy ping-pong (`desktop-release.yml`, `electron-builder.yml`, `updaterPlatform.ts:18`) | `publish.channel` per lane + one release-config module; separate program from this layer | **P2** |
| 54 | Mobile: hand-copied shared modules drifted (HIGH), native pin-mismatch string contract, exact-string path matching (`apps/mobile/src/cowork-shared/*`, `secureTransportClient.ts:786`, `threadStore.ts:189`) | shared workspace package (`packages/shared`) + coded native errors + `pathString.canonicalKeyLexical`; **separate track**, unblocked by `pathString` landing | **P2** |
| 55 | Test conventions: symlink skips ×10 with false "requires elevation" rationale, HOME-only pins, POSIX-shape close-info pins, host-forked assertions (`test/permissions.test.ts:297` et al., `test/agent.test.ts:375`) | `test/helpers/platform.ts` (`symlinkOrJunction`, `pinHome`, normalized `CloseInfo` from `proc`); un-fork assertions to check both variants | **P0** helpers; adoption per phase |

---

## 3. The agent-context contract

Principle: **the model authors command strings, so the shell dialect is the one platform fact it must know — rendered once, host-specific, from the same module that owns execution.** Everything else is transport and must be invisible.

### What the model IS told (all rendered from `src/platform`, never hand-written prose)

1. **Shell dialect, host-only.** `shell.promptGuidance({ platform })` fills a `{{shellExecutionPolicy}}` variable in `prompts/system.md` and all model templates, and the same string builds the bash tool description. On Windows it says: "The `bash` tool runs PowerShell (pwsh). Use PowerShell syntax: `;` to chain, `$env:NAME = \"value\"`, `Get-ChildItem -Force` to list." On macOS/Linux it says: "The `bash` tool runs bash. Standard POSIX syntax applies." A macOS session never again carries Windows rules, and vice versa. For the Codex runtime (`executor: "codex"`), the section renders **empty** — Codex owns its own shell.
2. **Exactly one Python instruction**, from `shell.pythonInvocation(env)`: the bundled interpreter's absolute path when the managed runtime is active, else bare `python`/`python3`. The string `py -3` is deleted from every prompt, template, tool description, and harness command.
3. **Path input contract:** "Use absolute paths; forward slashes are accepted in all file tools on every OS." (`paths.normalizeGlobPattern` and the file tools make this true.) All model-visible directory references (skill dirs, output dirs) are resolved absolute paths — never `~` notation.
4. **Sandbox outcomes only** (unchanged surface): the existing `[sandbox]` notices and denial-escalation prompts. These get *better* (locale/Windows-aware classification) but the model-visible contract is the same.

### What must be INVISIBLE to the model

Shell binary selection and fallback order; the `-EncodedCommand`/quoting/encoding transport; the runtime PATH prelude and `COWORK_RUNTIME_*` pointers; PATHEXT/shim resolution; env-key casing; home-directory resolution; line endings (read presents LF — the documented canonical view — and edit round-trips the file's real EOL); BOMs and UTF-16; output-encoding (UTF-8 is guaranteed by the prelude + `PYTHONUTF8=1`); timeout/kill mechanics; which sandbox backend enforces the policy. If any of these leaks into a prompt, that is a bug.

### Recommended bash execution strategy (the single cross-platform strategy)

Keep **one real shell per platform** — PowerShell on Windows, bash on POSIX — executed as follows:

1. **Resolve the shell binary through `exec.which`** for both sandboxed and unsandboxed lanes (today they use two different mechanisms and can bind different binaries on the same machine).
2. **Spawn with an args array, never a shell string at the spawn layer.** The model's script crosses **exactly one interpretation layer** on every OS: POSIX passes it as a single argv element to `bash -lc`; Windows passes it as `-EncodedCommand` Base64(UTF-16LE), eliminating PowerShell's CLI re-parse (the structural source of "works in bash, breaks in pwsh" quoting bugs — `git commit -m "..."` class).
3. **Module-owned prelude** (PATH prepend + UTF-8 console/output encoding + `PYTHONUTF8=1`) is baked into the encoded script by `buildPlatformShellCommandWithRuntimePrelude`; quoting inside the prelude uses `quoteShellValue(value, dialect)` only.
4. **Rejected alternatives**, so they aren't relitigated: (a) *translate POSIX to PowerShell* (busybox/mvdan-sh style) — a second half-correct shell implementation to maintain, breaks native-tool expectations, and models are already fluent in PowerShell when told plainly which dialect they're in; (b) *ship bash on Windows* (Git-Bash/WSL) — not guaranteed present, breaks Windows-native tool invocation (`Get-AuthenticodeSignature`, MSVC toolchains) and user expectations; (c) *cmd.exe* — never (worst quoting model; the test fixture proved it).
5. **Approval parity is part of the strategy:** `approval.classifyCommand` classifies in the dialect the host actually runs, so the human-in-the-loop gate exists equally on the platform whose sandbox backend is most often unavailable.

---

## 4. Enforcement — preventing regression

### 4.1 The boundary test (primary enforcement, runs in the existing CI lane)

`test/platform-boundary.test.ts` (bun:test) walks all `.ts`/`.tsx`/`.js` source (excluding `node_modules`, `dist`, vendored crates) and scans for banned tokens:

- `process.platform` and `os.platform(` — banned everywhere except `src/platform/**` and `apps/desktop/electron/**`.
- `os.homedir(` and `os.tmpdir(` — banned everywhere except `src/platform/paths.ts` and `src/platform/sandbox/**` (they feed `paths.home` / `sandbox.scratchRoots`).

Mechanics:

- A checked-in **ratchet baseline** (`test/platform-branch-baseline.json`: `{ file → count }`) grandfathers current offenders. The test fails when (a) a file NOT in the baseline contains a banned token, or (b) a baselined file's count **increases**. Counts may only shrink; each migration phase deletes its rows. Failure messages name the replacement API (`use hostPlatform() / platform.paths.home()`).
- The `apps/desktop/electron/**` exemption exists for genuinely platform-specific chrome (windowChrome, tray, menu, notifications, appearance, dialogs). Desktop **process/fs/spawn** logic (serverManager, sidecar, persistence, ipc/files) is exempt from the *ban* but stays in the baseline with tracked counts, so it is shrunk deliberately (P1/P2 rows above) rather than frozen.
- `test/**` is baselined too: tests should take injected `platform` parameters (the `shell.ts` pattern) rather than forking on the host; the count ratchets down as suites are parameterized in Phase 6.
- The escape hatch is greppable: `hostPlatform()` — reviewable in diffs, unlike raw `process.platform`.

### 4.2 Editor-time advisory (secondary)

Biome 2 GritQL plugin (`.biome/no-raw-platform.grit`) flagging `process.platform` / `os.platform()` outside the allowed dirs, wired into `bun run lint`. Advisory only — the bun test is the gate — so Biome version drift can't silently disable enforcement.

### 4.3 CI platform matrix

Today (per `test/ci.workflow.test.ts:51`): full `bun test` on Linux only; Windows/macOS run curated smoke lists — the structural enabler of the ping-pong.

Target: **`bun test --max-concurrency 1` + `bun run typecheck` + `bun run lint` + `bun run docs:check` on `ubuntu-latest`, `windows-latest`, `macos-latest`** — same lane everywhere.

Staged flip (Phase 6): the blockers are known and enumerated — the execFileCompat fixture (row 18), the ~10 symlink-skip suites (`symlinkOrJunction` helper), platform-parameterized sandbox argv suites (`test/platform/sandbox.test.ts:39` describe.skip), and HOME-only test pins (`pinHome`). Until the flip, every phase **adds its new module tests to the windows/macos smoke lists** so new platform code is cross-verified from day one. `test/ci.workflow.test.ts` is rewritten to pin the full-matrix contract (it currently pins the smoke-list shape and would otherwise block the flip). Native-gated integration suites (seatbelt/bwrap/win-sandbox enforcement) keep their host gating — but their **argv-construction** assertions run on every host via platform-parameterized builders.

---

## 5. Phased implementation plan

Each phase is independently shippable, lands tests before implementation, and leaves `main` green on the existing CI. Conventional commits throughout; sizes assume one engineer focused.

### Phase 0 — Repo hygiene + guardrail (1–2 days)
1. `chore: add root .gitattributes and renormalize line endings` — `* text=auto eol=lf` + binary exceptions (`*.png *.ico *.icns *.exe *.node *.dmg *.zip binary`), then `git add --renormalize .` as its own commit. Unbreaks `bun run format/lint/check` on Windows immediately; makes checkout bytes identical on all build hosts.
2. `test: add platform-boundary ratchet with baseline` — the scanner test + generated baseline (4.1).
3. `test: un-fork host-conditional prompt assertions` — `test/agent.test.ts:375` / `test/runtime.codex-app-server.test.ts:101` assert absence of BOTH `ln -s` and `cmd /c mklink /J` unconditionally.
- **Exit:** CI green on all lanes; Windows dev machines can run the quality lane.

### Phase 1 — Core modules, additive only (3–5 days)
Land `host.ts`, `pathString.ts`, `text.ts`, `paths.ts`, `env.ts`, `exec.ts` with exhaustive platform-parameterized unit tests (every branch runs on every host); `index.ts` barrel; `test/helpers/platform.ts` (`pinHome` sets HOME+USERPROFILE+override, `symlinkOrJunction`, `expectPrivateMode`). `src/utils/paths.ts` and `src/utils/workspacePath.ts` become deprecated re-export shims. No behavior changes for consumers yet.
- Commits: `test(platform): ...` + `feat(platform): add <module>` per module; `refactor: re-export utils/paths via platform`.
- **Exit:** new tests in all three CI smoke lists; ratchet baseline unchanged.

### Phase 2 — The bash lane (P0 ping-pong core) (1 week)
Tests first: golden argv tests for the new win32 `-EncodedCommand` plan (decode the base64 in assertions), quoting round-trip property tests, prompt-snapshot tests per platform.
1. `feat(platform): pwsh EncodedCommand transport with UTF-8 prelude` (+ `$SHELL` allowlist, `displayCommand`).
2. `feat(platform): shell prompt guidance, pythonInvocation, canned commands` — absorb harness `platformCommands` (re-export shim).
3. `refactor(tools): bash resolves shells via exec.which on both lanes; sandbox env via env module` (rows 3, 4).
4. `feat(prompt): render {{shellExecutionPolicy}} from platform.shell` — one variable replaces the 14 copies; codex prompt assembly renders empty; per-platform prompt snapshots replace the dual-OS pins in `test/prompt.test.ts`; delete `py -3` everywhere (rows 8, 9, 11).
5. `feat(platform): per-dialect approval classification` + delegate `utils/approval.ts` (row 7).
6. `fix(test): build execFileCompat fixtures via the platform shell plan` (row 18) — add to windows smoke list.
- **Exit:** manual verification of the real bash tool on Windows (unicode output, `git commit -m` with quotes, python package imports via prelude); harness eval prompts single-sourced through `shell.commands`.

### Phase 3 — Text contract in the file tools (3–4 days)
Tests first: CRLF-file edit round-trip fixtures, BOM/UTF-16 read fixtures, truncation-boundary decode tests.
1. `feat(tools): edit respects file EOL via text.replaceRespectingEol` (row 5 — the critical bug).
2. `feat(tools): read decodes BOM/UTF-16 via text.decodeTextBuffer` (LF view unchanged, documented).
3. `fix(platform): code-point-safe child output decoding` in the exec-compat engine (row 2 decode half).
4. `fix(tools): glob/grep pattern normalization via platform.paths` (row 6).
- **Exit:** edit/read/glob/grep suites green on a real CRLF checkout (windows lane).

### Phase 4 — fs + proc lifecycle (1–1.5 weeks)
Tests first: lock contention/stale-break matrix (both liveness policies' scenarios), atomic-replace under simulated EPERM, tree-kill integration test (grandchild survives today, dies after).
1. `feat(platform): fs atomic write/replace/move/remove primitives` (absorb `atomicFile.ts`); migrate the canonical writers — desktop `persistence.ts` + server `webDesktopService` (same file!), sessionStore, spreadsheetEdit, backup metadata, ArtifactVersionStore (delete the copyFile stance) (row 19).
2. `feat(platform): replaceExecutableAtomic; converge codex+ripgrep installs` — un-fork the darwin/win32 pinned resolver tests into one contract (row 20).
3. `feat(platform): proc.run with process-group/Job spawn and killTree` — execFileCompat re-homed, `utils/execFileCompat.ts` shim (rows 14, 30).
4. `feat(server): server/shutdown JSON-RPC route + stdin-EOF sentinel` + `docs: update websocket-protocol.md` (WebSocket-first rule) — then `refactor: terminateGracefully in webDesktopService, desktop serverManager, codex client` (rows 26, 27).
5. `feat(platform): acquireLockDir + proc.isAlive; migrate five locks` (rows 28, 29).
- **Exit:** kill-tree integration test green on win32+posix lanes; snapshot-flush-on-shutdown verified on Windows via the RPC path.

### Phase 5 — Paths adoption + sandbox parity (1 week)
1. `feat(platform): paths.home/coworkPaths; unify auth+config home` — fixes ServerRuntime import no-op, kills the 8-site codex path assembly; one-time legacy-HOME auth fallback with warning (rows 21, 23).
2. `fix(mcp): merge configured env onto platform child env` (row 22).
3. `fix(security): case-folded protected-metadata and containment checks` — `paths.crossesProtectedMetadata`, `paths.isInside/assertWithinRoots` into sandbox policy, file tools, server routes, desktop validation (rows 12, 13).
4. `fix(sandbox): shared scratch roots, windows backend parity, memoized probe, denial tables` (rows 15, 16, 17, 41, 42) — includes the Rust `--sandbox-home` fix and deleting `codexScratchRoots`; platform-parameterize `test/platform/sandbox.test.ts` (remove `describe.skip`).
5. `refactor: canonicalKey/samePath at the nine equality bypass sites` (row 39).
- **Exit:** the platform-conditional scratch expectations in `test/runtime.codex-app-server.test.ts:1069` collapse to one assertion; `.GIT` bypass regression test green on win32+darwin lanes.

### Phase 6 — CI matrix flip + test-convention cleanup (3–4 days)
1. `test: symlinkOrJunction helper; delete win32 early-returns` across the ~10 suites (row 55) — permissions, write/edit tools, tool-output-overflow, workspace.map, mcp.config-registry, skills.catalog, desktop ipc-files.
2. `test: pinHome in home-sensitive suites` (HOME+USERPROFILE).
3. `ci: run full bun test + typecheck on ubuntu/windows/macos` + `test: pin full-matrix contract in ci.workflow.test.ts` (replaces smoke-list pins).
4. `test: shrink platform-boundary baseline` — delete migrated rows; failures now block new `process.platform` outside the layer.
- **Exit:** three green full lanes; this is the moment the ping-pong structurally ends.

### Phase 7 — P1/P2 long tail (ongoing; each item independently shippable, ~0.5–2 days each)
In rough order of user impact: `env.getEnv`/`runtimePathDirs` in coworkRuntime (rows 24, 25) → `archive.*` adoption + sessionBackup tar preflight (row 36) → `os.openExternal` for OAuth (row 37) → filename validation on both rename surfaces (row 38) → `fs.copyTree/symlink/openNoFollow` (row 34) → hardening primitives (row 35) → `fs.fingerprintTree` for skills/backup/prebuilt (row 44, hash-domain v2) → renderer `pathString` migration (rows 45, 46) → conversation-import decoders (row 40) → desktop spawn injectability + build-triple module + chrome contract (rows 48–52). The mobile shared-package and release-signing programs (rows 53, 54) are tracked separately; `pathString` and this doc's error-code guidance unblock them.

**Total: roughly 5–7 focused weeks to the Phase 6 flip**, with user-visible fixes shipping from Phase 0 onward. After Phase 6, the invariant is mechanical: one implementation per concern, platform branches only inside `src/platform/`, every branch tested on every host, and a ratchet that only goes down.
---

# Appendix B — Full critique (staff-engineer adversarial review)

# Review: Unified Platform Abstraction Layer

I spot-checked the load-bearing claims against HEAD. Nearly all verified: `shell.ts:42-54` does re-parse via `-Command`; `read.ts:120` (LF view) vs `edit.ts:57-58` (raw `includes`) is a real CRLF-breaking split; `approval.ts:21-46` is POSIX-only vocabulary; `glob.ts:38/67` destroys POSIX escapes unconditionally; `mcp/index.ts:256` passes `env` raw to `StdioClientTransport` (replace, not merge); `ServerRuntime.ts:626` is `env.HOME ?? process.cwd()`; `browser.ts:15-20` is rundll32; `py -3` triplication confirmed (`platformCommands.ts:18`, `bash.ts:434`, `prompt.ts:565`, `prompts/system-models/gpt-5.5.md:184-185`); scratch-root triplication confirmed (`bwrap.ts:102` `/tmp` vs `seatbelt.ts:136` `/tmp,/private/tmp`); no `.gitattributes` + `biome.json:34 "lineEnding":"lf"`; `sandbox.test.ts:39` `describe.skip`; `authHome.ts:30` precedence as described. The diagnosis is sound. The objections below are about the cure.

1. **BLOCKING — Case-folded containment on darwin widens the sandbox on case-sensitive volumes.** §1.4 hardcodes `fsCaseSensitivity("darwin") = "insensitive"` and routes `paths.isInside` into the sandbox acceptance path (design says it replaces "both families, including policy.ts:302"; `utils/paths.isPathInside` also backs `resolveUsableTargetPath` at `src/platform/sandbox/policy.ts:257/264`, which decides whether a child `targetPath` becomes an OS-writable root). On case-sensitive APFS (a supported, developer-common format), `/Users/Foo/Project` and `/users/foo/project` are *different trees*; folded `isInside` accepts an outside path as a writable root where today's exact compare fails closed. Folding is fail-safe for deny-side checks (`crossesProtectedMetadata` — over-blocks) and fail-open for accept-side checks. The design applies one rule to both. Require: split predicates by fail direction (fold deny-side; accept-side folds only when realpath/inode identity confirms sameness, or per-volume probing), and state it in §1.4.

2. **BLOCKING — `paths.canonicalize` (async) specifies an API that does not exist in this runtime.** §1.4: "BOTH use the NATIVE realpath engine (fs.realpathSync.native / the async native equivalent)." Verified on Bun 1.3.14 (the repo's runtime): `fs.promises.realpath.native === undefined`; only `fs.realpathSync.native` exists. The entire "canonical forms string-match everywhere" unification (rows 13, 39; collapsing `src/utils/paths.ts:96` async-JS vs `:61` sync-native vs `permissions.ts` copies) hinges on one engine. The design must pick and state the resolution — sync-native under the async signature (event-loop cost on server routes), a worker offload, or post-hoc normalization — before Phase 1, not discover it there.

3. **BLOCKING — `-EncodedCommand` has an unaddressed 32 KB command-line ceiling and an underspecified exit-code guard.** UTF-16LE + base64 is ~2.67× expansion; Windows `CreateProcess` caps the command line at 32,767 chars, so scripts over ~11-12 KB (which today fit under `-Command`, ~30 KB) fail with a *new* "command line too long" error class — models do emit multi-KB inline scripts. Spec a `-File` temp-script fallback above a threshold. Also, empirically (this machine): `powershell.exe -Command "cmd /c exit 3"` exits 1, and with a trailing cmdlet exits 0 — the proposed trailing `exit $LASTEXITCODE` changes both cases (native-last: 1→3, an improvement; cmdlet-final handled-failure scripts: 0→stale 3, a regression). The golden tests in Phase 2 must pin the intended exit contract explicitly, and `$LASTEXITCODE`-when-unset must be defined for 5.1 (no `??` there).

4. **BLOCKING — `proc.terminateGracefully` cannot deliver row 26/27 as specified; the win32 graceful phase leaks back to callers.** §1.7's signature is `terminateGracefully(handle, { graceMs })`, but the prose says the Windows graceful mechanism is "stdin-EOF sentinel, or the child's `server/shutdown` RPC *when the caller wires it*." There is no parameter to wire it, so codexAppServerClient (JSON-RPC shutdown), webDesktopService, and serverManager each keep bespoke ask-nicely logic — exactly the divergence the module claims to absorb. Worse, the stdin-EOF sentinel is incompatible with the current spawn default: `execFileCompat.ts:61` spawns `stdin: "ignore"`, so there is no stdin to close. Add `requestShutdown?: () => Promise<void>` to the opts and define which spawn modes get a pipe stdin. Relatedly, "attached to a Job Object on win32 where available" has no implementation path in pure Bun (no Job Object API; no FFI plan) — the honest primary win32 mechanism is `taskkill /T /F` (PID-reuse racy, misses re-parented orphans); say so, and note the *sandboxed* lane already gets tree-kill via the helper's kill-on-close Job Object (`windows.ts` docstring). (`Bun.spawn` `detached` does exist in 1.3.14 — `bun.d.ts:6705-6718` — so the POSIX process-group half is fine.)

5. **BLOCKING — Priority inversion on the design's own CRITICAL bug.** Row 5 (multi-line edit fails on every CRLF checkout — verified: `read.ts:120` presents LF, `edit.ts:58` matches raw bytes) is the worst agent-visible defect in the audit, yet it ships in Phase 3, behind ~2 weeks of Phase 1+2 shell-transport work it does not depend on. `text.ts` lands in Phase 1; wiring `replaceRespectingEol` into `edit.ts` is a day. Move it to Phase 1. Note also that Phase 0's renormalize masks the bug for in-repo files while leaving it live for user workspaces — which makes early sequencing more important, not less.

6. **NIT — Missing confirmed hazard class: loopback/dual-stack binding.** CLAUDE.md's engineering rules record a real OAuth incident ("never share one constant between listener bind host and advertised redirect host; bind both `::1` and `127.0.0.1`"), which is platform-divergent (localhost resolution order differs per OS). No module or migration row covers it. Add a `platform.net` seam or an explicit row, or state why it's out of scope.

7. **NIT — `paths.home(env?)`/`coworkPaths(env?)` have a confused injection contract.** `os.homedir()` reads the *real* process env, so the `env` parameter is honored only for `COWORK_HOME_OVERRIDE` — half-injected. Meanwhile the repo's established pattern is DI via parameters (CLAUDE.md), and `ServerRuntime.ts:634` already threads `opts.homedir`; the design forces that through a process-global env var instead. Also `resolveAuthHomeDir`'s config-following derivation (`authHome.ts:21-27`: auth home follows a relocated `userCoworkDir`) is silently dropped — state how a non-default `.cowork` location keeps auth co-located, or you reintroduce the auth/config split from the other direction.

8. **NIT — stdin-EOF-as-shutdown must be opt-in per entrypoint.** `registerShutdownSignals` win32 = "SIGINT + stdin-EOF watcher": a headless `bun run serve < /dev/null` (service managers, cron) sees EOF at boot and shuts down immediately; the CLI REPL owns stdin for interaction. Fine for desktop-spawned sidecars, wrong as a default.

9. **NIT — `pathString` hand-rolls a second win32 path resolver next to `node:path.win32`.** Server code in `paths.ts` keeps node semantics while shared code gets the new resolver (drive-relative cwd, UNC, `\\?\`) — the layer itself becomes two path implementations one edit apart (the exact pattern in the `workspacePath.ts:52` bug it fixes). Require differential/property tests asserting `pathString.*` ≡ `path.win32`/`path.posix` on generated inputs, as a standing suite. Same-class gap: `canonicalKey` case-folds but never Unicode-normalizes (NFC/NFD), so two spellings of the same file on macOS still miss as map keys.

10. **NIT — Boundary-test token list won't catch the divergences it exists to kill.** Banning `process.platform`/`os.platform`/`os.homedir`/`os.tmpdir` misses: `Bun.which` (executable-resolution mechanism #3, `ripgrep.ts:51` — nothing stops new callers post-migration), `process.arch`/`os.arch` (row 50's triple-mapping seed), and direct `path.win32`/`path.posix` selection. Add them (baselined) or the ratchet gates the symptom, not the disease. Also generate the "~240/90" baseline rather than asserting it — my count is 155 occurrences / 56 files excluding `test/`.

11. **NIT — Over-engineered items to trim per the repo's simplicity rule:** `whichAll` (no named consumer); `fs.openNoFollow`'s win32 "lstat + post-open identity re-check" (TOCTOU theater for one consumer, `ipc/files.ts:576` — document the limitation instead); three overlapping remove/move primitives (`removeWithRetry`/`removeDirBestEffort`/`moveWithFallback` could be two); the Biome GritQL plugin (an advisory duplicate of the bun-test gate — a second enforcement mechanism to keep in sync); and `fs.isHiddenEntry`'s `FILE_ATTRIBUTE_HIDDEN` check, which no Node/Bun fs API exposes — it needs a per-entry `attrib`/PowerShell spawn or FFI for a P2 nicety; the spec presents it as free.

12. **NIT — `replaceRespectingEol` silently normalizes mixed-EOL files.** Re-emitting the dominant EOL rewrites line endings on lines the edit never touched (noisy diffs, surprising `git blame`). Acceptable tradeoff, but the spec should say it's intentional — otherwise the first bug report re-opens the design.

13. **NIT — Renormalize commit and `.gitattributes` need two footnotes.** `git add --renormalize .` conflicts with every open branch (coordinate the landing); and `* text=auto eol=lf` needs `eol=crlf` exceptions audited for any `.bat`/`.cmd` (cmd label parsing misbehaves with LF) before the flip, plus fixture files that intentionally test CRLF must be marked `-text`.

14. **NIT — Approval dialect tables: union, don't partition.** PowerShell accepts POSIX-ish aliases (`rm`, `del`, `ri` are `Remove-Item`; `rm -r -fo` is destructive and matches neither the listed `Remove-Item -Recurse` regex nor the POSIX `rm -rf` shape). The "exhaustive Record per dialect" framing invites disjoint tables; specify that dialect tables extend a shared dialect-neutral set (git, pipe-to-interpreter) plus alias forms. (For the record, the claimed `windows.ts:53` network "inversion" is currently unreachable — `SandboxManager.transform` returns danger-full-access-with-network unwrapped at `index.ts:132` — so "latent" is accurate; the fix is still right.)

The migration does **not** structurally break sandbox enforcement — the sandbox lane's `{file, args}` shape, `resolveInnerCandidate`→`exec.which` swap, and base64 args through the helper are compatible, and the probe memoization is *more* conservative than the existing forever-cached `hasSeatbelt()`/`bwrapUsabilityCache` — with the single exception of objection 1, which must be resolved before Phase 5.

VERDICT: revise
---

# Appendix C — All 83 divergence clusters (names; full stories in audit output)

- C1. Five coexisting executable-resolution mechanisms
- C2. Discovery enumerates .cmd/.bat shims that the spawn layer may not execute
- C3. Three bare-'tar' spawn sites with three different platform assumptions
- C4. Two contradictory answers to replacing a possibly-running executable on Windows
- C5. Home-directory resolution (five precedence rules)
- C6. Case-insensitive env-key lookup (seven copies plus case-sensitive outliers)
- C7. ~/.cowork/auth/codex-cli path assembly (eight sites, two resolver families)
- C8. Windows sandbox home (four values)
- C9. PATH construction: delimiter, dedupe, and the Scripts-dir disagreement
- C10. Electron userData resolution (native vs hand-rolled)
- C11. Model-as-shell-translator prose (14 hand-synced copies)
- C12. Three answers to 'how do I run Python' (py -3 vs bundled path vs PATH-resolved python)
- C13. Tilde-notation skills-directory label
- C14. Dual-authored per-platform eval prompts with host-forked guard tests
- C15. Destructive-command vocabulary known only in POSIX
- C16. Graceful-kill escalation (4+ divergent implementations)
- C17. PID-liveness probe (4 copies, 2 opposite policies)
- C18. Shutdown-signal wiring (3 hand-rolled sites, none Windows-functional)
- C19. Windows Bun-startup crash workaround split across layers
- C20. Startup readiness encoded as per-platform timeout constants (verified ping-pong)
- C21. Path-containment predicate (isPathInside / isPathWithin / isPathEqualOrInside)
- C22. Realpath canonicalization variants (longest-existing-prefix walk)
- C23. Same-path equality and case folding (win32 patch here, darwin patch there)
- C24. Sandbox per-backend canonicalize/scratch/metadata duplication (the historical ping-pong engine)
- C25. Renderer hand-rolled path library (node:path unavailable in sandboxed renderer)
- C26. Drive-letter / cross-platform absolute-path regex family
- C27. PATH environment building (delimiter, case-insensitive dedupe, Scripts dir)
- C28. toPosixRelative idiom (split(path.sep).join('/'))
- C29. 'What does a local path look like' regexes (redaction + auto-link)
- C30. findGitRoot walk-up scanners
- C31. read/edit line-ending contract split
- C32. four coexisting child-output line-splitting implementations
- C33. Atomic file replace (temp+rename)
- C34. Cross-process lock implementations (x5)
- C35. Sandbox temp-scratch roots (three definitions per policy)
- C36. Windows sandbox backend parity gap
- C37. Filesystem case-sensitivity identity
- C38. Path canonicalization (realpath) implementations
- C39. Windows-legal filename compensation
- C40. POSIX-mode privacy hardening (no-op on Windows)
- C41. Symlink handling on Windows
- C42. Move/rename with fallback
- C43. Explorer hidden-file semantics (x2)
- C44. Windows open-handle delete retry
- C45. mkdir-chain create/rollback
- C46. PowerShell single-quote escaper (4 copies)
- C47. Hand-assembled PowerShell invocations (5 flag-set variants)
- C48. Archive extraction (4 mechanisms, 3 platform forks)
- C49. Subprocess runner wrappers (4 spawn wrappers, 3 contracts)
- C50. Arg tokenizers for user-supplied command strings (2 incompatible grammars)
- C51. How to run Python on Windows (3 prose/code sites vs the PATH prelude)
- C52. Bundled-Bun-runtime plan for Windows ARM64 (2 copies)
- C53. (platform, arch) -> target-triple / runtime-asset mapping (6 copies)
- C54. Build-input fingerprinting: mtime vs content-hash (2 mechanisms, same directory)
- C55. Windows sandbox bundle trust verification (3 implementations)
- C56. Windows signing / ARM64 release-lane policy ping-pong (history-verified)
- C57. Windows symlink-fixture strategy: skip vs junction vs silent-pass
- C58. Shell dialect selection: production pwsh vs test-fixture cmd vs test-fixture sh
- C59. Codex managed-install promotion: current/ on darwin vs versions/ on win32
- C60. bwrap capability probe: test and production encode opposite fixes
- C61. Process shutdown shape: POSIX SIGTERM pinned everywhere
- C62. Windows temp-dir teardown retry loops
- C63. Antigravity Windows gate: two tokens, two layers
- C64. Directory-tree fingerprint hashing (five independent walk-sort-hash implementations)
- C65. Platform chrome contract quadruplicated
- C66. Three platform vocabularies, two normalizers
- C67. Linux mirrors Windows shell by copy, not by sharing
- C68. Darwin popup-window behavior scattered outside windowChrome
- C69. Two opposite strategies for sharing server code with mobile
- C70. Native transport error taxonomy: literal Kotlin sentinel vs localized iOS cancellation vs JS regex
- C71. Duplicated '"Bun" in globalThis' runtime sniffing for test-vs-device transport selection
- C72. Three keyboard-avoidance forks, two detection idioms, two Android behaviors
- C73. Exact-string host-path matching without normalization
- C74. Inconsistent CRLF normalization boundary for message text
- C75. PowerShell invocation construction (3 independent copies)
- C76. UTF-8 BOM handling on file reads (9 sites, 8 handle it, the main read tool does not)
- C77. Child stdout decoding strategy (buffered vs streaming, both hard-coded UTF-8)
- C78. Hand-rolled CRLF normalizers (5 sites, 3 different algorithms)
- C79. Directory-tree hashers: two raw-byte, one normalized
- C80. Code-signing enforcement policy per platform
- C81. Per-platform/per-arch update-feed metadata delivery
- C82. CI artifact discovery conventions
- C83. Regression pins encoding the divergence in tests
