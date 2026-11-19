# Plan: Fully native Windows ARM64 via LibreOffice-WASM converter

## Goal

Replace the native LibreOffice component (x64-only on Windows → x64 emulation under Windows ARM64) with the arch-neutral WASM converter (`@matbee/libreoffice-converter`), so the Windows ARM64 Cowork runtime — Node, Python, Git, Poppler, libheif, jxrlib, and the Office conversion engine — is fully native ARM64.

Direction chosen by the user. Source material: `docs/harness/office-conversion.md` (candidate results + production blockers), `scripts/officeWasmQualification.ts` (qualification harness), `crates/cowork-win-sandbox` (Windows helper).

## Current state (verified)

- Production native path: `src/server/presentationPreview.ts` spawns runtime `soffice` + `pdftoppm` (25 s deadline, fail-closed sandboxing, no host fallback). Runtime verification (`src/coworkRuntime/runtime.ts`, `src/coworkRuntime/libreOffice.ts`) smoke-tests HTML→PDF via the same launcher.
- WASM qualification harness exists but **POSIX-only**: `scripts/officeWasmQualification/supervise.ts` assumes `/bin/ps`, detached POSIX process groups, `kill(-pid)`; the CLI refuses win32 (`scripts/officeWasmQualification.ts:75-79`: "requires native helper setup, Job Object resource limits and a tested supervisor").
- Windows helper (`crates/cowork-win-sandbox`) has kill-on-close Job Objects, restricted-token/ACL write scoping, and firewall network denial — but **no Job-Object resource limits (memory/process/CPU), no usage stats, no timeout flag on `run`, and no read-deny exposure**.

## Phase 1 — Windows qualification lane (this pass, in-repo)

### 1.1 Native helper: Job-Object resource limits + stats
Files: `crates/cowork-win-sandbox/src/main.rs`, `crates/cowork-win-sandbox/src/bin/codex-command-runner/win.rs`, `crates/cowork-win-sandbox/src/bin/codex-command-runner/job.rs`.

- Extend `create_job_kill_on_close` (win.rs:131-154) into a configurable builder:
  - `JOB_OBJECT_LIMIT_JOB_MEMORY` (aggregate commit cap) from `--memory-limit-mb`
  - `JOB_OBJECT_LIMIT_ACTIVE_PROCESS` from `--max-processes`
  - optional `JOB_OBJECT_LIMIT_JOB_TIME` (CPU budget) — only if cheap to add
- `run` gains `--timeout-ms`, `--memory-limit-mb`, `--max-processes`, `--stats-file <path>`, and repeatable `--deny-read <abs path>` (wire to `deny_read_paths_override`; currently hardcoded empty at main.rs:448-451).
- After child exit, `QueryInformationJobObject` (`JobObjectExtendedLimitInformation` + `JobObjectBasicAccountingInformation`) → write JSON stats: peak job/process memory, total user/kernel time, active/total/terminated processes, timed-out flag.
- Rust unit tests alongside `job.rs:16-152` for limit-struct construction and stats serialization.

### 1.2 Qualification supervisor: Windows backend
Files: `scripts/officeWasmQualification/supervise.ts` → split into `supervise.ts` (dispatcher) + `supervisePosix.ts` (existing logic) + `superviseWindows.ts` (new), mirroring the `src/platform/sandbox/{seatbelt,bwrap,windows}.ts` convention.

- Windows backend: `SandboxManager.transform` (workspace-write, writable = qualification root only, `network:false`) → `cowork-win-sandbox.exe run --writable-root <root> --cwd <root> --timeout-ms … --memory-limit-mb … --max-processes … --stats-file … -- node.exe child.mjs …`; no `detached`; containment via Job Object (killed when helper dies — host-side kill is a valid backstop).
- Keep the identical evidence contract: `<label>.policy.json`, `.stdout.log`, `.stderr.log`, `.run.json` (+ new stats), survivor verification from job stats (`ActiveProcesses === 0`) with `taskkill /T /F` fallback.
- Enforcement gate: allow `windows-sandbox`, require all four `enforcement` flags true.

### 1.3 Qualification CLI + child portability
Files: `scripts/officeWasmQualification.ts`, `scripts/officeWasmQualification/child.mjs`.

- Lift the win32 gate; on Windows require helper env (`COWORK_WIN_SANDBOX_*`) + completed `setup`.
- Windows env construction for supervised children (`Path` with `;`, `SystemRoot`, `SystemDrive`, `ComSpec`, `PATHEXT`, `USERPROFILE`, `TEMP/TMP`, no `/usr/bin`).
- Windows read-canary in the real user profile (mirror of the Linux canary at `officeWasmQualification.ts:200-219`); verify restricted-token denial; if readable, implement via `--deny-read`.
- `child.mjs`: accept `COWORK_SANDBOX=windows-sandbox`; add Windows denial-code sets (write: `EPERM/EACCES`; network: `ECONNREFUSED/ETIMEDOUT/EHOSTUNREACH/EPERM/EACCES`).
- Windows Poppler resolution via `OFFICE_WASM_POPPLER_BIN`/PATH (`which()` already handles PATHEXT).

### 1.4 CI + tests + docs
Files: `.github/workflows/office-conversion-qualification.yml`, `test/office-wasm.integration.test.ts`, `docs/harness/office-conversion.md`.

- Add `windows-x64` (`windows-latest`) and `windows-arm64` (`windows-11-arm`) jobs: build helper from source (same pattern as `ci.yml:294-329`), set helper path+sha256 envs, one-time elevated `setup`, install Poppler, run `setup`+`qualify`, upload evidence with `if: always()`.
- Deterministic unit tests for the Windows argv/env builders; integration stays behind `OFFICE_WASM_INTEGRATION=1`.
- Update the Windows paragraph in `docs/harness/office-conversion.md` (and add it to `docs/harness/index.md`).

### Phase 1 verification
- `bun run test`, `bun run typecheck`, `bun run check`, `bun run docs:check`
- `cargo test` + `cargo clippy` in `crates/cowork-win-sandbox`
- End-to-end: run the qualification locally on this machine (win32/arm64) — build helper, `setup`, `qualify`, inspect evidence.
- Phase 1 changes no production behavior; it only makes Windows qualification possible.

## Phase 2 — Harness converter integration (next pass)

- New `src/coworkRuntime/officeConverter.ts`: capability resolution + supervised invocation contract (child runs managed Node with the runtime's converter assets; never in the harness process — the package patches fs APIs and leaks timers after `destroy()`).
- `src/server/presentationPreview.ts`: converter path for `.pptx`, keep Poppler for PDF→PNG; legacy `.ppt` contract decision (the package targets OOXML/ODF; `.ppt` support unconfirmed — if unsupported, keep today's explicit `unsupported_format` behavior).
- Verification/check contract: replace the HTML→PDF smoke (HTML support unconfirmed) with a fixture conversion; update `runtime.ts`, `libreOffice.ts`, `src/shared/jsonrpcControlSchemas.ts` (`cowork/runtime/libreoffice/check`) and `docs/websocket-protocol.md`.
- Runtime manifest: add converter path(s) to `src/coworkRuntime/types.ts`/`manifest.ts` path allowlists + integrity entrypoint closure; keep `soffice` contract for mac/linux until runtime cutover.

## Phase 3 — Cowork runtime payload (separate repo: `mweinbach/cowork-runtime`)

- Add the pinned converter component + a Cowork-owned entrypoint (recommendation: a compat `soffice` launcher for marketplace skills **and** an explicit `office-converter` entrypoint the harness uses).
- Build the native `win-arm64` payload: official Node arm64, official Python 3.12 arm64 (+ wheel audit), official MinGit busybox arm64 (verified available in Git for Windows 2.56.0.2), Poppler/libheif/jxrlib arm64 build recipes, Rust launcher shim `aarch64-pc-windows-msvc`; drop native LibreOffice on Windows.
- Release + sign `cowork-runtime-win-arm64.zip`; keep `win-x86` for x64 Windows.
- Close the `docs/harness/office-conversion.md` production blockers: MPL-2.0 notices/corresponding source, attestation signature verification, fidelity review (LibreOfficeDev 24.8.8 vs 26.2.3.2), lifecycle/memory ownership.

## Phase 4 — Flip + release (this repo + runtime repo)

- `src/coworkRuntime/platform.ts`: map `win32-arm64 → win-arm64` (only after the asset is published); update types + tests.
- End-to-end verification on `windows-11-arm`: download → verify → install → preview conversion.
- Marketplace skills migration to the managed converter entrypoint (coordinated, outside this repo).

## Risks / open questions

| Risk | Where resolved |
| --- | --- |
| Cold-start latency outlier (Linux x64 75.5 s docx) vs 25 s preview budget | Phase 2 profiling; possibly warm process or larger deadline |
| Converter's runtime memory (~1.6 GiB peak) vs Job memory cap | Phase 1 limits; Phase 2/3 sizing |
| `.ppt` (legacy binary) support | Phase 2 contract decision |
| HTML smoke fixture no longer valid | Phase 2 verification redesign |
| License/provenance/fidelity blockers | Phase 3 checklist |
| Windows read-canary behavior under restricted token | Phase 1 step 1.3 |
