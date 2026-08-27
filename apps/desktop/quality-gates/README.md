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

The primary pane must retain 520 pixels, except when a compact or narrow window has an active
inline context rail, where the layout contract reserves 320 pixels. Collapsed rails and Canvas or
Task overlays retain the 520-pixel requirement. Dedicated proof cases shrink panes below each
minimum and verify that the width gate rejects them.

Axe runs every selected WCAG A/AA rule, including `color-contrast`, in its Electron-compatible
legacy injection mode. `axe-baseline.json` contains narrowly scoped selectors for pre-existing
light/dark navigation, top-bar, task, and file-panel contrast debt; issue #235 adds enforcement
without changing shipping theme tokens. Axe's generated target is resolved back to its DOM element
and matched against those selectors, so harmless generated-selector ordering changes do not expand
the baseline. Only `color-contrast` results on matching elements are filtered after analysis, so
every other rule still evaluates those elements and any new contrast target fails. The dedicated
assertion test injects an unbaselined low-contrast label and proves the gate rejects it. Axe also has
one narrow mainline exclusion for `.sidebar-symbol-slot`: the existing custom animated workspace
disclosure uses a Radix trigger without a Radix content node, so Radix emits a dangling generated
`aria-controls` value.

## Coverage

- First launch, theme-correct slow bootstrap, onboarding, keyboard focus, and Axe.
- Project and Quick Chat; streaming reasoning/tool/approval state; Stop, steer, cancellation, and
  completion.
- Disconnect/reconnect, drafts, tool-failure history, and attachment-only transcript semantics.
- File Explorer, Markdown preview, Canvas popout, and all three desktop resizers.
- Settings persistence through the production preload/state bridge.
- Active Task blocking questions, artifact review, and cancellation controls.
- Mention geometry at 100%, 150%, and 200% zoom.
- Approved screenshots and Axe/focus/clipping checks for the complete 16-case Cartesian matrix:
  640, 800, 1024, and 1240 pixels, each in light, dark, reduced-motion, and forced-colors modes.
- Deterministic probes for 1,000 deltas, 1,000 messages, and 1,000 files. Every probe runs three
  samples through the production store/JSON-RPC path. The quality renderer aliases
  `react-dom/client` to React's profiling build while leaving `react-dom` available to the profiling
  bundle's internal shared-state import. Every sample must record positive React commits and store
  publications (plus filesystem requests for the file-tree probe), then remain below the reviewed
  upper budgets in `budgets.json`. Composer input, thread navigation, and tree expansion also
  enforce responsiveness budgets.

The delta-burst probe also budgets content publications, feed and row renders, streaming/full
Markdown transitions, feed derivation size, and unrelated sidebar-row renders. The long-transcript
probe budgets both derivation size and mounted rows. Completion is released by an explicit harness
handshake after the live-stream state is observed, so slower hosts cannot skip the streaming phase.
The checked limits retain CI scheduling headroom without allowing a zero-value or inactive probe to
pass.

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

`bun run desktop:quality:proof` intentionally injects a renderer exception, mention-highlight drift,
a pixel change, and a serious Axe violation. The command succeeds only when all four nested Playwright runs fail
and emit their required evidence under `apps/desktop/quality-gates/proof-artifacts/`.

## Updating screenshots

Baselines are Linux/sRGB artifacts because Linux is the review and enforcement host. CI pins
the Playwright 1.62.0 container on Ubuntu Noble by immutable image digest
`sha256:baed2032d533817f3dbe6425de795788430ba345e819a1201337009ba17c9d07`, the repository
`.bun-version` channel, and `bun.lock` (including the test driver's version). From the repository root, this invocation mirrors the CI
mount, working directory, Linux dependencies, image-baked fonts, Bun version, lockfile, Xvfb
display, and Playwright browser toolchain:

```bash
docker run --rm --platform linux/amd64 --ipc=host \
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
  mcr.microsoft.com/playwright:v1.62.0-noble@sha256:baed2032d533817f3dbe6425de795788430ba345e819a1201337009ba17c9d07 \
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
    bun_release="$bun_version"
    if [ "$bun_version" != canary ]; then bun_release="bun-v$bun_version"; fi
    curl --fail --silent --show-error --location https://bun.sh/install |
      bash -s -- "$bun_release"
    export BUN_INSTALL=/root/.bun
    export PATH="$BUN_INSTALL/bin:$PATH"
    if [ "$bun_version" != canary ]; then test "$(bun --version)" = "$bun_version"; fi
    bun --revision
    bun install --frozen-lockfile
    bunx playwright --version
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
