# Electron quality gates

This Linux-only suite builds the shipping `App` and preload through a dedicated
`quality-gates/electron.vite.config.ts`, then launches that output in a real Electron process. The
shipping build never includes the harness entry or renderer instrumentation.
`electron/qualityGateMain.ts` supplies deterministic IPC, filesystem, persisted-state, and
loopback JSON-RPC fixtures. It never starts the Cowork sidecar or reads provider credentials. A
main-process `session.webRequest` guard, installed before the first window, denies every
non-loopback request. The launcher also strips credential-shaped environment variables before
Electron starts.

## Run the CI command locally

Run from a Linux graphical session with `ffmpeg` and Xvfb installed:

```bash
xvfb-run --auto-servernum --server-args="-screen 0 1400x1000x24" bun run desktop:quality
```

Focused debugging after the initial build:

```bash
bun run desktop:quality:test -- --grep "streaming"
```

The suite fails on uncaught renderer exceptions, renderer/main `console.error`, external network
traffic, serious or critical Axe violations, visual differences, viewport clipping, or exceeded
publication/render/filesystem budgets. Clipping checks reject any viewport or overflow clipping for
declared critical controls, including controls entirely off-viewport or clipped by a scrollable
ancestor. Noncritical list controls may remain offscreen only when their scroll ancestor can reveal
them.

Axe runs in its Electron-compatible legacy injection mode. The scan disables `color-contrast`
because existing mainline theme opacity values fail that rule in the shipping sidebar and context
panel; issue #235 explicitly does not change product theme tokens. It also has one narrow mainline
exclusion for `.sidebar-symbol-slot`: the existing custom animated workspace disclosure uses a
Radix trigger without a Radix content node, so Radix emits a dangling generated `aria-controls`
value. Every other selected WCAG A/AA rule and element remains enforced, including the intentional
serious violation used by the proof suite. Reviewed light/dark/forced-colors baselines cover visual
theme regressions but are not a substitute for a future product contrast correction.

## Coverage

- First launch, theme-correct slow bootstrap, onboarding, keyboard focus, and Axe.
- Project and Quick Chat; streaming reasoning/tool/approval state; Stop, steer, cancellation, and
  completion.
- Disconnect/reconnect, drafts, tool-failure history, and attachment-only transcript semantics.
- File Explorer, Markdown preview, Canvas popout, and all three desktop resizers.
- Settings persistence through the production preload/state bridge.
- Active Task blocking questions, artifact review, cancellation controls, and Research
  empty/completed/follow-up states.
- Mention geometry at 100% and 125% zoom.
- Approved screenshots and Axe/focus/clipping checks for the complete 16-case Cartesian matrix:
  640, 800, 1024, and 1240 pixels, each in light, dark, reduced-motion, and forced-colors modes.
- Deterministic probes for 1,000 deltas, 1,000 messages, and 1,000 files. Every probe runs three
  samples through the production store/JSON-RPC path. The quality renderer aliases
  `react-dom/client` to React's profiling build while leaving `react-dom` available to the profiling
  bundle's internal shared-state import. Every sample must record positive React commits and store
  publications (plus filesystem requests for the file-tree probe), then remain below the reviewed
  upper budgets in `budgets.json`; wall-clock timing is intentionally not used.

The profiling budgets were calibrated over nine Linux samples per scenario: delta bursts recorded
2,006–2,007 commits, long transcripts 1,576–1,594 commits, and file trees two commits with one
filesystem request. The checked limits retain CI scheduling headroom without allowing a zero-value
or inactive probe to pass.

## Failure diagnostics

On failure, Playwright writes to `apps/desktop/quality-gates/artifacts/` and the HTML report to
`apps/desktop/quality-gates/report/`. After Electron and the recorder finish, every test removes its
temporary runtime and user-data profiles. Failed tests first copy only the reviewed attachments into
the Playwright output:

- `diagnostics.json` with renderer/main console output, renderer diagnostic log entries, and
  deterministic counters.
- `trace.zip`.
- one Linux/X11 full-display WebM per Electron test.
- a screenshot per open window.
- Axe JSON for accessibility checks.
- Playwright expected/actual/diff images for visual failures.

CI uploads both directories with `if: failure()`.

`bun run desktop:quality:proof` intentionally injects one renderer exception, one pixel change,
and one serious Axe violation. The command succeeds only when all three nested Playwright runs fail
and emit their required evidence under `apps/desktop/quality-gates/proof-artifacts/`.

## Updating screenshots

Baselines are Linux/sRGB artifacts because Linux is the review and enforcement host. CI pins
Playwright 1.61.1 on Ubuntu Noble by immutable image digest
`sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48`, the repository
`.bun-version`, and `bun.lock`. From the repository root, this exact invocation mirrors the CI
mount, working directory, Linux dependencies, image-baked fonts, Bun version, lockfile, Xvfb
display, and Playwright browser toolchain:

```bash
docker run --rm --ipc=host \
  --env CI=1 \
  --env ANTHROPIC_API_KEY= \
  --env GEMINI_API_KEY= \
  --env GOOGLE_API_KEY= \
  --env OPENAI_API_KEY= \
  --env HOST_UID="$(id -u)" \
  --env HOST_GID="$(id -g)" \
  --mount "type=bind,source=$PWD,target=/work/agent-coworker" \
  --mount "type=volume,target=/work/agent-coworker/node_modules" \
  --workdir /work/agent-coworker \
  mcr.microsoft.com/playwright:v1.61.1-noble@sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48 \
  bash -lc '
    set -euo pipefail
    trap '\''chown -R "$HOST_UID:$HOST_GID" /work/agent-coworker'\'' EXIT
    apt-get update
    apt-get install --yes --no-install-recommends ffmpeg unzip
    rm -rf /var/lib/apt/lists/*
    dpkg-query --show --showformat='\''${Package}=${Version}\n'\'' \
      fontconfig fonts-liberation fonts-noto-color-emoji
    fc-match sans-serif
    fc-match emoji
    bun_version="$(tr -d '\''\r\n'\'' < .bun-version)"
    curl --fail --silent --show-error --location https://bun.sh/install |
      bash -s -- "bun-v${bun_version}"
    export BUN_INSTALL=/root/.bun
    export PATH="$BUN_INSTALL/bin:$PATH"
    test "$(bun --version)" = "$bun_version"
    bun install --frozen-lockfile
    test "$(bunx playwright --version)" = "Version 1.61.1"
    xvfb-run --auto-servernum --server-args="-screen 0 1400x1000x24" \
      bun run desktop:quality:update
  '
```

The anonymous `node_modules` volume prevents host dependencies from influencing the build, while
the bind mount writes reviewed snapshots back to the checkout. The image digest owns Chromium and
the font packages verified by `dpkg-query`; the command installs only the same `ffmpeg`/`unzip`
prerequisites as CI. It updates reviewed baselines and copies the approved 1240-pixel light image to
`docs/assets/desktop-product.png`. Normal test runs never write baselines. CI separately runs
`bun run desktop:quality:screenshot:check`, so the product image cannot drift from the shipping UI.

macOS and Windows retain their native-chrome unit/release coverage. This quality suite does not run
there because its diagnostic recorder is Linux/X11-specific and native text rasterization cannot be
compared with the reviewed Linux pixels. Platform-owned recording and baseline jobs remain future
work; the harness fails explicitly instead of silently omitting video.
