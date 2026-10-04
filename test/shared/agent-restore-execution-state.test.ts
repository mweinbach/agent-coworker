import { describe, expect, test } from "bun:test";
import { resolveRestoredAgentExecutionState } from "../../src/shared/agents";

describe("resolveRestoredAgentExecutionState", () => {
  test("resolves closed, in-flight, and settled states accurately", () => {
    for (const s of ["running", "pending_init", "completed", null, undefined] as const) {
      expect(resolveRestoredAgentExecutionState(s, "closed")).toBe("closed");
    }
    expect(resolveRestoredAgentExecutionState("running")).toBe("errored");
    expect(resolveRestoredAgentExecutionState("pending_init")).toBe("errored");
    expect(resolveRestoredAgentExecutionState("running", "active")).toBe("errored");
    expect(resolveRestoredAgentExecutionState("completed")).toBe("completed");
    expect(resolveRestoredAgentExecutionState("errored", "active")).toBe("errored");
    expect(resolveRestoredAgentExecutionState("closed", "active")).toBe("closed");
    expect(resolveRestoredAgentExecutionState(null)).toBe("completed");
    expect(resolveRestoredAgentExecutionState(undefined, "active")).toBe("completed");
  });
});
