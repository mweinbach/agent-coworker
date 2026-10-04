import { describe, expect, test } from "bun:test";

import {
  type CrashedRendererReloadDecision,
  RENDERER_CRASH_RELOAD_COOLDOWN_MS,
  shouldReloadCrashedRenderer,
} from "../electron/services/rendererCrashRecovery";

const nowMs = 1_000_000;
const decision = (
  overrides: Partial<CrashedRendererReloadDecision> = {},
): CrashedRendererReloadDecision => ({
  reason: "crashed",
  windowClosing: false,
  applicationQuitting: false,
  applicationQuitPending: false,
  windowDestroyed: false,
  webContentsDestroyed: false,
  lastReloadAtMs: undefined,
  nowMs,
  ...overrides,
});

describe("shouldReloadCrashedRenderer", () => {
  test("reloads live crashed renderers once per cooldown and skips closing or quitting states", () => {
    for (const reason of ["crashed", "oom", "killed"]) {
      expect(shouldReloadCrashedRenderer(decision({ reason }))).toBe(true);
    }
    for (const overrides of [
      { reason: "clean-exit" },
      { windowClosing: true },
      { windowDestroyed: true },
      { webContentsDestroyed: true },
      { applicationQuitting: true },
      { applicationQuitPending: true },
      { lastReloadAtMs: nowMs - RENDERER_CRASH_RELOAD_COOLDOWN_MS + 1 },
    ]) {
      expect(shouldReloadCrashedRenderer(decision(overrides))).toBe(false);
    }
    expect(
      shouldReloadCrashedRenderer(
        decision({ lastReloadAtMs: nowMs - RENDERER_CRASH_RELOAD_COOLDOWN_MS }),
      ),
    ).toBe(true);
  });
});
