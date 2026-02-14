import { describe, expect, test } from "bun:test";

import { HarnessContextStore } from "../src/harness/contextStore";
import type { HarnessContextPayload } from "../src/types";

function makePayload(overrides?: Partial<HarnessContextPayload>): HarnessContextPayload {
  return {
    runId: "run-1",
    taskId: "task-1",
    objective: "Complete the mission",
    acceptanceCriteria: ["criterion-a", "criterion-b"],
    constraints: ["constraint-x"],
    ...overrides,
  };
}

describe("HarnessContextStore", () => {
  test("get returns null for unknown session", () => {
    const store = new HarnessContextStore();
    expect(store.get("nonexistent")).toBeNull();
  });

  test("set then get returns the stored context", () => {
    const store = new HarnessContextStore();
    const payload = makePayload();
    store.set("s1", payload);
    const result = store.get("s1");
    expect(result).not.toBeNull();
    expect(result!.runId).toBe("run-1");
    expect(result!.taskId).toBe("task-1");
    expect(result!.objective).toBe("Complete the mission");
    expect(result!.acceptanceCriteria).toEqual(["criterion-a", "criterion-b"]);
    expect(result!.constraints).toEqual(["constraint-x"]);
  });

  test("set trims whitespace from runId, taskId, objective", () => {
    const store = new HarnessContextStore();
    store.set("s1", makePayload({ runId: "  run-2  ", taskId: "  task-2  ", objective: "  goal  " }));
    const result = store.get("s1")!;
    expect(result.runId).toBe("run-2");
    expect(result.taskId).toBe("task-2");
    expect(result.objective).toBe("goal");
  });

  test("set filters empty strings from acceptanceCriteria and constraints after trim", () => {
    const store = new HarnessContextStore();
    store.set(
      "s1",
      makePayload({
        acceptanceCriteria: ["  valid  ", "  ", "", "also valid"],
        constraints: ["", "  ", "  keep  "],
      })
    );
    const result = store.get("s1")!;
    expect(result.acceptanceCriteria).toEqual(["valid", "also valid"]);
    expect(result.constraints).toEqual(["keep"]);
  });

  test("set handles taskId being undefined", () => {
    const store = new HarnessContextStore();
    store.set("s1", makePayload({ taskId: undefined }));
    const result = store.get("s1")!;
    expect(result.taskId).toBeUndefined();
  });

  test("set handles taskId being empty string (becomes undefined)", () => {
    const store = new HarnessContextStore();
    store.set("s1", makePayload({ taskId: "" }));
    const result = store.get("s1")!;
    expect(result.taskId).toBeUndefined();
  });

  test("set includes metadata when provided", () => {
    const store = new HarnessContextStore();
    store.set("s1", makePayload({ metadata: { env: "prod", tier: "1" } }));
    const result = store.get("s1")!;
    expect(result.metadata).toEqual({ env: "prod", tier: "1" });
  });

  test("set excludes metadata when not provided", () => {
    const store = new HarnessContextStore();
    store.set("s1", makePayload({ metadata: undefined }));
    const result = store.get("s1")!;
    expect(result.metadata).toBeUndefined();
  });

  test("get returns a clone (mutating returned object does not affect stored)", () => {
    const store = new HarnessContextStore();
    store.set("s1", makePayload());
    const first = store.get("s1")!;
    first.runId = "mutated";
    first.acceptanceCriteria.push("injected");
    const second = store.get("s1")!;
    expect(second.runId).toBe("run-1");
    expect(second.acceptanceCriteria).toEqual(["criterion-a", "criterion-b"]);
  });

  test("set returns a clone (mutating returned object does not affect stored)", () => {
    const store = new HarnessContextStore();
    const returned = store.set("s1", makePayload());
    returned.runId = "mutated";
    returned.acceptanceCriteria.push("injected");
    const stored = store.get("s1")!;
    expect(stored.runId).toBe("run-1");
    expect(stored.acceptanceCriteria).toEqual(["criterion-a", "criterion-b"]);
  });

  test("clear removes the context (get returns null after clear)", () => {
    const store = new HarnessContextStore();
    store.set("s1", makePayload());
    expect(store.get("s1")).not.toBeNull();
    store.clear("s1");
    expect(store.get("s1")).toBeNull();
  });

  test("clear on unknown session is a no-op (does not throw)", () => {
    const store = new HarnessContextStore();
    expect(() => store.clear("nonexistent")).not.toThrow();
  });

  test("multiple sessions stored independently", () => {
    const store = new HarnessContextStore();
    store.set("s1", makePayload({ runId: "run-a", objective: "goal-a" }));
    store.set("s2", makePayload({ runId: "run-b", objective: "goal-b" }));
    const r1 = store.get("s1")!;
    const r2 = store.get("s2")!;
    expect(r1.runId).toBe("run-a");
    expect(r1.objective).toBe("goal-a");
    expect(r2.runId).toBe("run-b");
    expect(r2.objective).toBe("goal-b");
  });

  test("set overwrites previous context for same session", () => {
    const store = new HarnessContextStore();
    store.set("s1", makePayload({ objective: "first" }));
    store.set("s1", makePayload({ objective: "second" }));
    const result = store.get("s1")!;
    expect(result.objective).toBe("second");
  });

  test("updatedAt is set to an ISO timestamp string", () => {
    const store = new HarnessContextStore();
    const before = new Date().toISOString();
    store.set("s1", makePayload());
    const after = new Date().toISOString();
    const result = store.get("s1")!;
    expect(typeof result.updatedAt).toBe("string");
    // Validate ISO format
    expect(new Date(result.updatedAt).toISOString()).toBe(result.updatedAt);
    // updatedAt should be between before and after timestamps
    expect(result.updatedAt >= before).toBe(true);
    expect(result.updatedAt <= after).toBe(true);
  });
});
