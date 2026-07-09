# Electron quality gates

This suite launches the production `electron-vite` renderer and preload in a real Electron
process. `electron/qualityGateMain.ts` supplies deterministic IPC, filesystem, persisted-state,
mobile-device, and loopback JSON-RPC fixtures. It never starts the Cowork sidecar, reads provider
credentials, or makes an external network request. The launcher strips credential-shaped
environment variables before Electron starts.

## Run the CI command locally

Linux:

```bash
xvfb-run --auto-servernum --server-args="-screen 0 1400x1000x24" bun run desktop:quality
```

macOS and Windows (from a graphical session):

```bash
bun run desktop:quality
```

Focused debugging after the initial build:

```bash
bun run desktop:quality:test -- --grep "streaming"
```

The suite fails on uncaught renderer exceptions, renderer/main `console.error`, external network
traffic, serious or critical Axe violations, visual differences, viewport clipping, or exceeded
publication/render/filesystem budgets.

## Coverage

- First launch, theme-correct slow bootstrap, onboarding, keyboard focus, and Axe.
- Project and Quick Chat; streaming reasoning/tool/approval state; Stop, steer, cancellation, and
  completion.
- Disconnect/reconnect, drafts, tool-failure history, and attachment-only transcript semantics.
- File Explorer, Markdown preview, Canvas popout, and all three desktop resizers.
- Settings persistence, full-payload trace confirmation, and trusted-device removal.
- Active Task blocking questions, artifact review, cancellation controls, and Research
  loading/empty/completed/follow-up states.
- Mention geometry at 100% and 125% zoom.
- Approved screenshots at 640, 800, 1024, and 1240 pixels across light, dark, reduced-motion, and
  forced-colors modes.
- Deterministic probes for 1,000 deltas, 1,000 messages, and 1,000 files. Budgets are reviewed in
  `budgets.json`; wall-clock timing is intentionally not used.

## Failure diagnostics

On failure, Playwright writes to `apps/desktop/quality-gates/artifacts/` and the HTML report to
`apps/desktop/quality-gates/report/`. Each failed Electron test keeps:

- `diagnostics.json` with renderer/main console output, renderer diagnostic log entries, and
  deterministic counters.
- `trace.zip`.
- one full-display WebM per Electron test.
- a screenshot per open window.
- Axe JSON for accessibility checks.
- Playwright expected/actual/diff images for visual failures.

CI uploads both directories with `if: failure()`.

`bun run desktop:quality:proof` intentionally injects one renderer exception, one pixel change,
and one serious Axe violation. The command succeeds only when all three nested Playwright runs fail
and emit their required evidence under `apps/desktop/quality-gates/proof-artifacts/`.

## Updating screenshots

Baselines are Linux/sRGB artifacts because Linux is the review and enforcement host. Update them
only in the same container/runner used by CI:

```bash
xvfb-run --auto-servernum --server-args="-screen 0 1400x1000x24" bun run desktop:quality:update
```

That explicit command updates reviewed baselines and copies the approved 1240-pixel light image to
`docs/assets/desktop-product.png`. Normal test runs never write baselines. CI separately runs
`bun run desktop:quality:screenshot:check`, so the product image cannot drift from the shipping UI.

macOS and Windows retain their native-chrome unit/release coverage. Their text rasterization differs
from Linux, so they do not compare against Linux pixels; the deterministic fixture keeps native
platform values explicit for future platform-owned baseline jobs.
