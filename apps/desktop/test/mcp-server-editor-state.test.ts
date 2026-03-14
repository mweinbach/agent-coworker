import { describe, expect, test } from "bun:test";

import {
  createMcpAutoValidateScheduler,
  getMcpEditorSubmitLabel,
  getMcpEditorTitle,
  getPreviousNameForUpsert,
} from "../src/ui/settings/pages/mcpServerEditorState";

describe("MCP server editor state", () => {
  test("treats a real server named new as edit mode", () => {
    const editorState = { mode: "edit", name: "new" } as const;

    expect(getMcpEditorTitle(editorState)).toBe("Edit new");
    expect(getMcpEditorSubmitLabel(editorState)).toBe("Save changes");
    expect(getPreviousNameForUpsert(editorState)).toBe("new");
  });

  test("cancel clears a pending auto-validation before it fires", () => {
    const validateCalls: Array<{ workspaceId: string; name: string }> = [];
    const pendingTimers = new Map<number, () => void>();
    const clearedTimers: number[] = [];
    let nextTimerId = 1;

    const scheduler = createMcpAutoValidateScheduler(
      (workspaceId, name) => {
        validateCalls.push({ workspaceId, name });
      },
      {
        delayMs: 500,
        setTimeoutFn: ((handler: () => void) => {
          const timerId = nextTimerId++;
          pendingTimers.set(timerId, handler);
          return timerId as unknown as ReturnType<typeof setTimeout>;
        }) as typeof setTimeout,
        clearTimeoutFn: ((timerId: ReturnType<typeof setTimeout> | undefined) => {
          const numericId = Number(timerId);
          clearedTimers.push(numericId);
          pendingTimers.delete(numericId);
        }) as typeof clearTimeout,
      },
    );

    scheduler.schedule("ws-1", "alpha");
    expect(pendingTimers.size).toBe(1);

    scheduler.cancel();

    expect(clearedTimers).toHaveLength(1);
    expect(pendingTimers.size).toBe(0);
    expect(validateCalls).toHaveLength(0);
  });
});
