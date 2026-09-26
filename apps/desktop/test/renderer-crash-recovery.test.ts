import { describe, expect, test } from "bun:test";

import {
  type CrashedRendererReloadDecision,
  RENDERER_CRASH_RELOAD_COOLDOWN_MS,
  shouldReloadCrashedRenderer,
} from "../electron/services/rendererCrashRecovery";

function decision(
  overrides: Partial<CrashedRendererReloadDecision> = {},
): CrashedRendererReloadDecision {
  return {
    reason: "crashed",
    windowClosing: false,
    applicationQuitting: false,
    applicationQuitPending: false,
    windowDestroyed: false,
    webContentsDestroyed: false,
    lastReloadAtMs: undefined,
    nowMs: 1_000_000,
    ...overrides,
  };
}

describe("shouldReloadCrashedRenderer", () => {
  test("reloads a crashed renderer that is still showing a live window", () => {
    expect(shouldReloadCrashedRenderer(decision())).toBe(true);
    expect(shouldReloadCrashedRenderer(decision({ reason: "oom" }))).toBe(true);
    expect(shouldReloadCrashedRenderer(decision({ reason: "killed" }))).toBe(true);
  });

  test("does not reload a renderer whose window is already closing or gone", () => {
    expect(shouldReloadCrashedRenderer(decision({ windowClosing: true }))).toBe(false);
    expect(shouldReloadCrashedRenderer(decision({ windowDestroyed: true }))).toBe(false);
    expect(shouldReloadCrashedRenderer(decision({ webContentsDestroyed: true }))).toBe(false);
    expect(shouldReloadCrashedRenderer(decision({ reason: "clean-exit" }))).toBe(false);
  });

  test("does not reload while the app is quitting, including a quit that has not finished", () => {
    expect(shouldReloadCrashedRenderer(decision({ applicationQuitting: true }))).toBe(false);
    expect(shouldReloadCrashedRenderer(decision({ applicationQuitPending: true }))).toBe(false);
  });

  test("allows one reload per cooldown so a renderer that crashes on load cannot loop", () => {
    const nowMs = 5_000_000;
    expect(
      shouldReloadCrashedRenderer(
        decision({
          nowMs,
          lastReloadAtMs: nowMs - RENDERER_CRASH_RELOAD_COOLDOWN_MS + 1,
        }),
      ),
    ).toBe(false);
    expect(
      shouldReloadCrashedRenderer(
        decision({
          nowMs,
          lastReloadAtMs: nowMs - RENDERER_CRASH_RELOAD_COOLDOWN_MS,
        }),
      ),
    ).toBe(true);
  });
});
