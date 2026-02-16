import { describe, expect, test } from "bun:test";

import { resolveCtrlCAction } from "../apps/TUI/util/ctrl-c";

describe("resolveCtrlCAction", () => {
  test("clears input immediately when text is present", () => {
    const out = resolveCtrlCAction("hello", null, 1_000);
    expect(out).toEqual({ outcome: "clear_input", nextPendingAt: null });
  });

  test("asks for confirmation on first ctrl+c with empty input", () => {
    const out = resolveCtrlCAction("", null, 2_000);
    expect(out.outcome).toBe("confirm_exit");
    expect(out.nextPendingAt).toBe(2_000);
  });

  test("exits on second ctrl+c inside confirmation window", () => {
    const out = resolveCtrlCAction("", 2_000, 2_800, 1_500);
    expect(out).toEqual({ outcome: "exit", nextPendingAt: null });
  });

  test("restarts confirmation when second ctrl+c is outside window", () => {
    const out = resolveCtrlCAction("", 2_000, 4_000, 1_500);
    expect(out.outcome).toBe("confirm_exit");
    expect(out.nextPendingAt).toBe(4_000);
  });
});
