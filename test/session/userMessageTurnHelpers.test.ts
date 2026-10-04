import { describe, expect, test } from "bun:test";

import type { SessionContext } from "../../src/server/session/SessionContext";
import {
  getTaskLockAbortSessionError,
  isAbortLikeError,
  isStartStepPart,
  isTaskLockAbortError,
  makeTaskLockAbortError,
  resolveUserInputDisplayText,
} from "../../src/server/session/turnExecution/userMessageTurnHelpers";

const sessionContext = (abortController: AbortController | null): SessionContext =>
  ({ state: { abortController } }) as SessionContext;

describe("userMessageTurnHelpers", () => {
  test("resolveUserInputDisplayText keeps basename-only attachment names", () => {
    expect(resolveUserInputDisplayText("  Please review  ")).toBe("Please review");
    expect(
      resolveUserInputDisplayText("Please review", [
        { filename: "../secret/notes.md" },
        { filename: "/tmp/report.md" },
        { filename: "." },
        { filename: ".." },
        { filename: "" },
      ]),
    ).toBe("Please review\n\nAttached: [notes.md, report.md]");
    expect(
      resolveUserInputDisplayText("   ", [{ filename: "docs/spec.md" }, { filename: ".." }]),
    ).toBe("[spec.md]");
  });

  test("task-lock abort errors, abort signals, and start-step parts are classified accurately", () => {
    const sessionError = {
      code: "task_locked" as const,
      source: "session" as const,
      message: "Task is locked",
      data: {
        category: "task_locked" as const,
        source: "session" as const,
        lockKind: "terminal_task_thread" as const,
        taskId: "task-1",
        taskStatus: "completed" as const,
      },
    };
    const branded = makeTaskLockAbortError("Cancelled by task lock", sessionError);
    const plainAbort = Object.assign(new Error("Cancelled"), { code: "ABORT_ERR" });

    expect(isTaskLockAbortError(branded)).toBe(true);
    expect(isTaskLockAbortError(plainAbort)).toBe(false);
    expect(isTaskLockAbortError(new Error("Cancelled"))).toBe(false);
    expect(getTaskLockAbortSessionError(branded)).toEqual(sessionError);
    expect(getTaskLockAbortSessionError(makeTaskLockAbortError())).toBeNull();
    expect(getTaskLockAbortSessionError(plainAbort)).toBeNull();

    const aborted = new AbortController();
    aborted.abort();
    expect(isAbortLikeError(sessionContext(null), makeTaskLockAbortError())).toBe(true);
    expect(isAbortLikeError(sessionContext(aborted), new Error("provider stopped"))).toBe(true);
    expect(
      isAbortLikeError(sessionContext(new AbortController()), new Error("provider stopped")),
    ).toBe(false);
    expect(isAbortLikeError(sessionContext(null), new Error("provider stopped"))).toBe(false);

    expect(isStartStepPart({ type: "start-step" })).toBe(true);
    expect(isStartStepPart({ type: "tool-call" })).toBe(false);
    expect(isStartStepPart("start-step")).toBe(false);
    expect(isStartStepPart(null)).toBe(false);
  });
});
