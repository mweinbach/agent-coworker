# Bun-Native Migration: Audit & Plan

Status: **Phases 0–6 implemented** (see "Implementation status" below). This document is the system-of-record for moving the harness from Node.js APIs to Bun-native APIs where it is a win, and for recording what deliberately stays on `node:` builtins.

Audited at repo `e8c7bb66`. Scope: `src/`, `packages/`, `scripts/`. `apps/desktop` (Electron) and `apps/mobile` (Expo) run Node/Chromium/React Native and are only in scope as consumers of shared `src/` modules.

## TL;DR

The two largest surfaces are **already Bun-native**:

- **WebSocket/HTTP server**: `src/server/startServer.ts` and the H3 mobile transport (`src/server/transport/h3/server.ts`) are fully on `Bun.serve` (fetch handler, `srv.upgrade`, `websocket.open/message/close/drain`, TLS + `h3: true`). No `ws` server, no `node:http` in the agent server path.
- **SQLite**: `src/server/sessionDb*` and `src/memoryStore.ts` already use `bun:sqlite`.

What remains is a long tail: `node:child_process` (13 files), `node:fs` read/write hot paths (~109 files, mostly fine as-is), `node:crypto` hashing/UUIDs, one `node:http` OAuth callback listener, and a handful of npm deps (`fast-glob`, `ws` in desktop) that Bun builtins can replace.

Important framing: Bun implements `node:fs`, `node:path`, `node:crypto`, `node:os`, etc. **natively** — they are not a slow compatibility shim. Migration targets are chosen for (a) simpler/faster Bun-idiomatic code on hot paths, (b) dropping npm deps, (c) consistency — not because `node:` imports are broken under Bun.

## Hard constraint: the Electron/renderer shared-module boundary

Files under `apps/desktop/electron/**` run in Electron **main** (Node runtime, not Bun). Files under `apps/desktop/src/**` run in the **renderer** (Chromium). Both value-import modules from root `src/`. Those shared modules can never use `bun:` imports or `Bun.*` globals.

The desktop app never runs harness/server logic in-process: `apps/desktop/electron/services/serverManager.ts` always spawns the server as a **Bun sidecar** (`bun src/server/index.ts` in dev; the `bun build --compile` `cowork-server` binary when packaged). So everything reachable only from the server/CLI/harness entrypoints is safe for Bun-only APIs.

### Must stay Node-compatible (value-imported by Electron main/preload, incl. one-level transitive closure)

```
src/diagnostics/redaction.ts        src/sync/providers/customHttp.ts
src/platform/sandbox/bwrap.ts       src/sync/queue.ts
src/platform/sandbox/detect.ts      src/sync/redaction.ts
src/platform/sandbox/policy.ts      src/sync/service.ts
src/platform/sandbox/seatbelt.ts    src/sync/types.ts
src/platform/sandbox/windows.ts     src/telemetry/config.ts
src/server/startupProgress.ts       src/telemetry/crashReporting.ts
src/shared/attachments.ts           src/telemetry/productAnalytics.ts
src/shared/featureFlags.ts          src/types.ts
src/shared/quickChatShortcut.ts     src/utils/atomicFile.ts
src/store/connections.ts            src/utils/oneOffChats.ts
                                    src/utils/paths.ts
```

### Must stay browser-compatible (value-imported by the desktop renderer)

`src/client/jsonRpcSocket.ts`, `src/models/registry.ts`, `src/providers/catalog.ts`, `src/server/jsonrpc/protocol.ts`, `src/session/*`, most of `src/shared/*`, `src/telemetry/{config,crashReporting,productAnalytics}.ts`, `src/types.ts`, `src/utils/workspacePath.ts`.

Audit result: **no current violations** — none of these files import `bun:` modules or use `Bun.*` today. Phase 0 below adds a guardrail so it stays that way.

Note on globals: `crypto.randomUUID()`, `crypto.getRandomValues()`, `fetch`, `WebSocket`, `TextEncoder/Decoder`, and Web Streams are available in Bun, Node ≥ 20, and browsers — shared modules may use these freely. That makes "drop `node:crypto` import, use global Web Crypto" safe even inside the shared boundary.

## Audit results by area

### 1. Network stack — done, two stragglers

| Surface | State |
| --- | --- |
| Main WS/HTTP server (`startServer.ts`) | ✅ `Bun.serve` + `srv.upgrade`, port fallback, backpressure via `drain` |
| H3 mobile transport (`transport/h3/server.ts`) | ✅ `Bun.serve` with TLS + `h3: true` (QUIC when available, HTTPS fallback); clients use fetch + SSE, not WS |
| WS clients (CLI REPL, renderer, tests, examples) | ✅ `JsonRpcSocket` over `globalThis.WebSocket` (Bun-native / browser-native) |
| MCP OAuth callback listener (`src/mcp/oauthProvider.ts`) | ❌ `node:http` `createServer`, binds `127.0.0.1` only → **migrate to `Bun.serve`** (Phase 2) |
| `ws` npm dep | ❌ Only `apps/desktop/electron/services/desktopSmoke.ts` (Electron main — legitimately Node) and one subprotocol-negotiation test in `test/server.jsonrpc.test.ts`. Not a root dep. |

The OAuth migration must also fix a pre-existing gap vs. our OAuth engineering rule: the listener binds IPv4 loopback only; the `Bun.serve` version should bind both `127.0.0.1` and `::1` (two listeners, one advertised redirect URI) or document why IPv4-only is required by specific IdPs.

### 2. SQLite — done

`bun:sqlite` in `src/server/sessionDb.ts` (+ `sessionDb/` modules) and `src/memoryStore.ts`. No `better-sqlite3`/`node:sqlite` anywhere. No action.

### 3. Child processes — the main migration (13 files, all `Bun.spawn`-able)

No `exec`/`execSync`/`fork` anywhere; usage is `execFile` (buffered), `spawn` (streaming), `spawnSync` (sandbox probes). Precedent already exists: `scripts/releaseBuildUtils.ts` uses `Bun.spawn`.

| File | API | Difficulty | Notes |
| --- | --- | --- | --- |
| `scripts/postinstall.ts`, `scripts/open_xcode_workspace.ts` | `spawn` inherit | easy | direct swap |
| `src/utils/ripgrep.ts` | `execFile` | easy | tar/PowerShell extraction, bounded |
| `src/tools/bash.ts` | `execFile` | **hard, highest value** | agent shell tool: 10 MB `maxBuffer`, timeout→SIGTERM→exit 124, AbortSignal→exit 130, `windowsHide`, env replacement, shell-candidate ENOENT fallback, sandbox transform |
| `src/tools/grep.ts` | `execFile` | medium | same contract as bash (timeout/abort/maxBuffer), injectable `execFileImpl` |
| `src/coworkRuntime/runtime.ts` | promisified `execFile` | medium | version/import probes with timeout + maxBuffer |
| `src/coworkRuntime/libreOffice.ts` | `spawn` + manual SIGKILL timer | medium | add an output cap while migrating (currently unbounded) |
| `src/server/sessionBackup/command.ts` | `spawn`, async stream drain | medium | tar/preview; consider adding timeout/max-bytes |
| `src/server/webDesktopService.ts` | `spawn` + readline line streaming, graceful SIGTERM→SIGKILL | medium | startup JSON monitor |
| `src/utils/browser.ts` | `spawn` `detached` + `unref` | needs care | verify Bun fire-and-forget parity per platform |
| `src/providers/codexAppServerResolver.ts` + `codexAppServerClient.ts` | `spawn` (probes, tar, long-lived JSON-RPC over stdio) | hard | migrate together behind a subprocess interface (stdin write, stdout line events, kill, exited) |
| `src/platform/sandbox/detect.ts` | `spawnSync` ×4 | **blocked as-is** | value-imported by Electron main (`findWindowsHelper`); split Node-safe exports out first, or keep on `node:child_process` (works in both runtimes) |

Strategy: build one shared `execFileCompat(file, args, opts)` helper on `Bun.spawn` that reproduces the Node `execFile` contract our tools rely on (maxBuffer cap, `timeout` + `killSignal`, `AbortSignal`, buffered stdout/stderr, exit-code/signal mapping), land it with a parity test suite, then convert consumers one at a time. Parity notes:

- Bash tool today has **no process-tree kill** — timeout SIGTERMs only the direct shell child. Migrate for parity first; tree-kill would be a behavior change to consider separately.
- `Bun.spawn` timeouts/kills need a manual timer + `proc.kill("SIGTERM")`; there is no `maxBuffer`, so cap while reading the streams.

### 4. Filesystem — targeted hot-path wins, keep the rest

~109 files import `node:fs`/`node:fs/promises`. Most usage (mkdir, readdir, stat, rm, rename, chmod, watch, symlink, realpath) has **no Bun-native equivalent** and stays. `node:path` (~120 files) needs no migration at all.

Migrate (whole-file text/JSON read/write → `Bun.file().text()/.json()` + `Bun.write()`):

| Target | Why |
| --- | --- |
| `src/tools/edit.ts` | hottest agent path; read-modify-write of whole files |
| `src/tools/read.ts` image branch | `Bun.file().arrayBuffer()`; keep the streaming text branch |
| `src/skills/loadSkillBody.ts`, `src/skills/catalog.ts`, `src/prompt.ts`, `src/projectInstructions.ts` | per-turn prompt/skill assembly |
| `src/config.ts` | startup config layers; also converts the sync `readFileSync` API-key read to async |
| `src/server/sessionStore.ts` JSON bodies, `src/memoryStore.ts`, `src/store/connections.ts`* , `src/mcp/authStore/store.ts`, `src/cli/repl/stateStore.ts` | small JSON blobs (*connections.ts is Electron-shared — keep `node:fs` there) |
| `src/runtime/toolOutputOverflow.ts` spill writes | `Bun.write` |
| `scripts/*`, `packages/harness/*` | Bun-only; lowest-risk pilot area |

Keep on `node:fs` (explicit non-goals):

- **Atomic writes** (`src/utils/atomicFile.ts`, sessionStore/writeCoordinator tmp+`rename`+Windows-retry) — `Bun.write` is not atomic-rename.
- **Streaming** (`tools/webFetch.ts` capped downloads via `fs.open`, `coworkRuntime/{archive,download}.ts`, backup hashing/deltas, `tools/read.ts` line streaming).
- **`fs.watch`** (`SkillMutationBus`, `webDesktopService`, `coworkRuntime/integrity.ts` recursive watch) — Bun has no watch API.
- **`realpathSync.native`** in `src/utils/paths.ts` — security-critical permission checks, also used from Electron IPC.
- **chmod/mode hardening**, readdir+Dirent walks, copyFile, symlink/readlink.

Optional follow-ups: async-ify `src/workspace/map.ts` (sync readdir/stat on every turn's prompt build) and `existsSync` → `Bun.file().exists()` in Bun-only paths.

### 5. Crypto — mechanical wins, three deliberate keeps

| Pattern | Sites | Action |
| --- | --- | --- |
| `import { randomUUID } from "node:crypto"` | 6 files (`sync/service`, `oneOffChats`, `coworkRuntime/{install,bootstrapLock}`, `spreadsheetEdit`, `mcp/oauthProvider`) | global `crypto.randomUUID()` — safe even in Electron-shared files; ~25 files already do this |
| `randomBytes(24)` OAuth state | `mcp/oauthProvider.ts` | `crypto.getRandomValues` + existing base64url helper |
| `createHash("sha256")` | 18+ files (fingerprints, checksums, content-addressed artifacts) | shared `sha256Stream`/`sha256` helpers on `Bun.CryptoHasher` for Bun-only paths; `detect.ts` (Electron-shared) keeps `node:crypto` |
| `randomInt` | `appleFoundationTitle.ts` | low priority; keep or `getRandomValues` |
| `timingSafeEqual` | `h3/pairing.ts` | **keep** `node:crypto` (native in Bun) |
| Ed25519 `createPublicKey`+`verify` | `coworkRuntime/integrity.ts` | **keep** — signed-runtime trust boundary; only migrate with full test vectors |
| `node:dns/promises` + `net.isIP` SSRF gate | `utils/webSafety.ts` | **keep** — security-critical resolution semantics |

### 6. Small builtins — keep

`node:readline` (CLI REPL prompts + secret masking via `_writeToOutput`; NDJSON subprocess parsing — could become a shared async line-reader when the codex client migrates), `node:os`, `node:url`, `node:async_hooks` (`AsyncLocalStorage`, Bun-supported), `node:stream` (fetch→disk pipelines), `Buffer` (idiomatic and fast in Bun). One cleanup: `promisify(execFile)` in `coworkRuntime/runtime.ts` disappears with `execFileCompat`.

### 7. npm dependencies

| Dep | Verdict |
| --- | --- |
| `fast-glob` | **Replace in `test/package-manifest.test.ts`** with `Bun.Glob`. **Keep in `src/tools/glob.ts` for now**: the tool needs streaming with abort, `stats: true` (mtime ordering), `objectMode`, `braceExpansion: false` — `Bun.Glob` has no stat-stream; revisit as a scoped follow-up with behavior tests. |
| `ws` (desktop) | Replace the one test usage with Bun's client `WebSocket` if it supports multi-protocol offers; `desktopSmoke.ts` runs in Electron main (Node) and may keep `ws`, or move smoke into a Bun subprocess to drop the dep. |
| `proxy-agent` | **Keep** — feeds Node `http.Agent` into the AWS SDK's `NodeHttpHandler` for Bedrock; Bun's fetch env-proxy doesn't apply. |
| `yauzl`, `jszip`, `fast-xml-parser` | **Keep** — ZIP extraction with zip-slip/symlink/entry-limit hardening (yauzl) and OOXML read/modify/write (jszip + fxp). Bun has gzip/zstd, not ZIP or XML. |
| `partial-json` | Keep (single call site for streaming tool-arg JSON; inline later if we want). |
| `posthog-node`, `@sentry/bun` | Correctly runtime-split today (`loadSdk` injection; Electron injects `@sentry/electron/*`). Hygiene item: split config-only exports out of `telemetry/productAnalytics.ts` so preload bundles can't pick up `posthog-node`. |

## Phased plan

Each phase is one or more PR-sized slices. Every slice: full `bun test`, `bun run typecheck`, `bun run check`, `bun run docs:check`; behavior-parity tests land **with** the migration, not after.

### Test lane: why `bun test` stays single-process serial

The lane was `bun test --max-concurrency 1` until July 2026, but that flag is a no-op: it only gates `test.concurrent` tests, which this repo never uses, so files always ran serially in one process. Bun 1.3.13+ parallel mechanisms were evaluated empirically (2026-07-13, Bun 1.4.0-canary on Windows, 658 files / ~7.5k tests, 325s serial) and both rejected:

- **`--parallel` (worker processes, implies `--isolate`)**: per-file isolation resets the module cache, so every file re-imports the whole `src/` graph plus the jsdom preload — measured **+2.2s/file** (`test/jsonrpc/`: 96s shared-process vs 156s isolated), inflating total CPU work ~4-5x. Best local result was 245s at 16 workers with 40 nondeterministic 5s-timeout failures; 4 workers ran **slower than serial** (513s). On a <=4-vCPU ubuntu CI runner the inflated total work makes `--parallel` strictly slower than serial. Contention also cascades: a timed-out test that leaked `process.chdir` crashed its worker's next preload resolution (`preload not found "./test/bun-test-setup.ts"`).
- **`--shard=i/N` run as N concurrent plain processes**: no isolation tax, but 61 tests failed instantly (sub-millisecond) across `JsonRpcSocket runtime`, `H3 mobile server pairing`, `mcp oauth provider`, and `webAdapter` suites — cross-file `mock.module`/state coupling that only the full fixed file order masks (the same hazard the verification rules warn about).

Revisit when (a) Bun ships isolation that preserves the module cache across files, or (b) the cross-file mock coupling is eliminated (see the DI-override conversion work), whichever unblocks first. Re-run the experiment before switching: a green `--parallel` run must be cheaper than serial on the CI runner class and 3/3 green locally.


### Phase 0 — Guardrail (small, do first)

Add a boundary check (test or lint script) that fails if any file in the Electron-main or renderer shared lists above imports `bun:*` or references `Bun.` — freezing today's clean state before we add more Bun-only code. Keep the lists in one checked-in manifest the test reads.

### Phase 1 — Mechanical, zero-risk slices

1. `randomUUID`/`randomBytes` → global Web Crypto (all 7 files, incl. Electron-shared ones — globals are runtime-portable).
2. `Bun.spawn` in Bun-only scripts: `scripts/postinstall.ts`, `scripts/open_xcode_workspace.ts`.
3. `Bun.Glob` in `test/package-manifest.test.ts`.
4. `Bun.file`/`Bun.write` in `scripts/` and `packages/harness/` file I/O.

### Phase 2 — OAuth callback listener → `Bun.serve`

Port `src/mcp/oauthProvider.ts` `createCallbackCapture` to `Bun.serve` (`hostname`, `port: 0`, fetch handler). Bind both loopbacks per the OAuth rule (or record the IdP-compat exception). Update `test/mcp.oauth-provider.test.ts` to cover the advertised redirect URI and both binds.

### Phase 3 — `execFileCompat` + process migration

1. Build `src/utils/execFileCompat.ts` on `Bun.spawn` replicating the Node `execFile` contract (maxBuffer, timeout→SIGTERM, AbortSignal, windowsHide, env replacement, exit/signal mapping) with a dedicated parity test file.
2. Convert buffered consumers: `ripgrep.ts`, `grep.ts`, `coworkRuntime/runtime.ts`, then `bash.ts` last (its tests must pin exit 124/130 and the truncation/stderr messages).
3. Convert streaming consumers with a small line-reader helper: `sessionBackup/command.ts`, `libreOffice.ts` (add output cap), `webDesktopService.ts`.
4. `utils/browser.ts` — verify detached/unref parity on macOS/Linux/Windows before swapping.

### Phase 4 — Filesystem hot paths

`Bun.file`/`Bun.write` in `tools/edit.ts`, `tools/read.ts` (image branch), skills/prompt loaders, `config.ts`, session/memory/auth JSON stores (except Electron-shared `store/connections.ts`), `toolOutputOverflow.ts`. Atomic-write, streaming, watch, and chmod paths are explicitly untouched.

### Phase 5 — Long-lived subprocess abstraction (largest slice)

Define a `HarnessSubprocess` interface (spawn, write stdin, async line iteration, kill(SIGTERM→SIGKILL), `exited`) and migrate `codexAppServerResolver.ts` + `codexAppServerClient.ts` together onto a `Bun.spawn` implementation. This also retires their `node:readline` pipe parsing.

### Phase 6 — Cleanup & opportunistic

- Split Node-safe exports (`findWindowsHelper`, `findBwrap`) out of `platform/sandbox/detect.ts` so the Bun-only probe code can migrate; or leave the whole file on `node:` (valid endstate).
- `Bun.CryptoHasher` sha256 helpers across Bun-only fingerprint/checksum sites.
- Drop `ws` from the one test; evaluate dropping it from desktop via a Bun-subprocess smoke.
- Evaluate `Bun.Glob` for `src/tools/glob.ts` behind its existing tool tests.
- Async-ify `workspace/map.ts`; telemetry config/SDK split.

## Implementation status

- **Phase 0** ✅ `test/desktopSharedBunBoundary.test.ts` computes the Electron-main and renderer value-import closures and fails on any `bun:`/`Bun.*` usage inside them.
- **Phase 1** ✅ global `crypto.randomUUID()`/`getRandomValues` replace `node:crypto` imports in 7 files; `Bun.spawn` in `scripts/postinstall.ts` and `scripts/open_xcode_workspace.ts`; `Bun.Glob` replaces `fast-glob` in `test/package-manifest.test.ts` (verified identical file sets).
- **Phase 2** ✅ MCP OAuth callback on `Bun.serve`, bound to `127.0.0.1` + best-effort `::1` on one port, redirect URI pinned to `127.0.0.1`, with an IPv6 coverage test.
- **Phase 3** ✅ `src/utils/execFileCompat.ts` (Bun.spawn, Node execFile contract: maxBuffer, timeout→SIGTERM/exit 124, abort/exit 130, ENOENT codes, pipe teardown on kill) + parity tests; consumers migrated: `tools/bash.ts`, `tools/grep.ts`, `utils/ripgrep.ts`, `coworkRuntime/runtime.ts`. Streaming consumers on `src/utils/subprocess.ts` (`spawnStreamingSubprocess` + `subscribeLines`): `sessionBackup/command.ts`, `coworkRuntime/libreOffice.ts` (now with a 4 MiB output cap), `webDesktopService.ts`.
- **Phase 4** ✅ `Bun.file` reads on hot paths: edit/read tools, prompt templates, skill catalog/bodies, config layers, session snapshots, memory/MCP-auth/CLI-state stores; `Bun.write` in the edit tool.
- **Phase 5** ✅ codex app-server client/resolver on `StreamingSubprocess` (NDJSON via `subscribeLines`, stdin via Bun `FileSink`, SIGTERM→SIGKILL stop escalation; probe/tar via `execFileCompat` with SIGKILL timeout).
- **Phase 6** ✅ `src/utils/hash.ts` (`Bun.CryptoHasher` sha256 helpers, streaming file hashing) adopted by ripgrep + codex asset checksums; `ws` removed from the root test suite (Bun's client negotiates multi-protocol offers natively).

Deferred follow-ups (deliberate):

- `src/tools/glob.ts` keeps `fast-glob` (stat-streaming + abort semantics; revisit with behavior tests).
- `utils/browser.ts` keeps `node:child_process` `detached`+`unref` until fire-and-forget parity is verified on macOS/Windows.
- `platform/sandbox/detect.ts` stays fully on `node:` (value-imported by Electron main).
- `config.ts` `getSavedProviderApiKeyForHome` sync read and `workspace/map.ts` sync walk (API-shape changes; separate slice).
- Telemetry config/SDK split for preload bundling hygiene.
- Remaining `createHash("sha256")` fingerprint sites work natively under Bun; adopt `utils/hash.ts` opportunistically.

## Keep-on-Node register (deliberate, with reasons)

| What | Why |
| --- | --- |
| `node:fs` mkdir/readdir/stat/rm/rename/chmod/watch/symlink/realpath | no Bun-native equivalent; native-speed in Bun |
| Atomic write paths (`utils/atomicFile.ts` et al.) | tmp+rename semantics incl. Windows retries |
| `tools/webFetch.ts`, runtime download/archive, backups | streaming + byte caps via fs handles/streams |
| `utils/paths.ts` `realpathSync.native` | security boundary, Electron-shared |
| `coworkRuntime/integrity.ts` Ed25519 verify | signed-runtime trust boundary |
| `utils/webSafety.ts` DNS + `isIP` | SSRF gate; injectable for tests |
| CLI REPL `node:readline` | TTY UX, history, secret masking |
| `yauzl`/`jszip`/`fast-xml-parser`/`proxy-agent` | no Bun ZIP/XML/agent equivalents |
| Everything in the Electron/renderer shared lists | runs under Node/Chromium |
