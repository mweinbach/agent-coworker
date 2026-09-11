import { describe, expect, test } from "bun:test";

import { resolveRestoredAgentExecutionState } from "../../src/shared/agents";

describe("resolveRestoredAgentExecutionState", () => {
  test("closed lifecycle always restores as closed", () => {
    expect(resolveRestoredAgentExecutionState("running", "closed")).toBe("closed");
    expect(resolveRestoredAgentExecutionState("pending_init", "closed")).toBe("closed");
    expect(resolveRestoredAgentExecutionState("completed", "closed")).toBe("closed");
    expect(resolveRestoredAgentExecutionState(null, "closed")).toBe("closed");
    expect(resolveRestoredAgentExecutionState(undefined, "closed")).toBe("closed");
  });

  test("does not resurrect in-flight states after a process restart", () => {
    expect(resolveRestoredAgentExecutionState("running")).toBe("errored");
    expect(resolveRestoredAgentExecutionState("pending_init")).toBe("errored");
    expect(resolveRestoredAgentExecutionState("running", "active")).toBe("errored");
  });

  test("preserves settled states and defaults missing state to completed", () => {
    expect(resolveRestoredAgentExecutionState("completed")).toBe("completed");
    expect(resolveRestoredAgentExecutionState("errored", "active")).toBe("errored");
    expect(resolveRestoredAgentExecutionState("closed", "active")).toBe("closed");
    expect(resolveRestoredAgentExecutionState(null)).toBe("completed");
    expect(resolveRestoredAgentExecutionState(undefined, "active")).toBe("completed");
  });
});
