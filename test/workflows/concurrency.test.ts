import { describe, expect, test } from "bun:test";

import {
  resolveWorkflowConcurrency,
  WORKFLOW_MAX_CONFIGURABLE_AGENTS,
  WORKFLOW_MAX_INFLIGHT_AGENTS,
} from "../../src/workflows/scheduler";

describe("resolveWorkflowConcurrency", () => {
  test("falls back to the hosted-API default when unset", () => {
    expect(resolveWorkflowConcurrency(undefined)).toBe(WORKFLOW_MAX_INFLIGHT_AGENTS);
  });

  test("honours a lower value, which is the point for local engines", () => {
    // A local inference server has a small request pool and per-model context
    // budget; a 12-wide fan-out there fails rather than queueing.
    expect(resolveWorkflowConcurrency(2)).toBe(2);
    expect(resolveWorkflowConcurrency(1)).toBe(1);
  });

  test("clamps to at least one so a workflow can always make progress", () => {
    expect(resolveWorkflowConcurrency(0)).toBe(1);
    expect(resolveWorkflowConcurrency(-5)).toBe(1);
  });

  test("clamps to AgentControl's per-parent ceiling", () => {
    // Configuring above MAX_ACTIVE_CHILDREN_PER_PARENT cannot help: spawn()
    // rejects past that point, so the extra slots would only produce errors.
    expect(resolveWorkflowConcurrency(999)).toBe(WORKFLOW_MAX_CONFIGURABLE_AGENTS);
    expect(WORKFLOW_MAX_CONFIGURABLE_AGENTS).toBe(16);
  });

  test("ignores non-finite junk and floors fractions", () => {
    // Non-finite values fall back to the default rather than clamping, so a
    // corrupted config reads as "unset" instead of silently maxing out fan-out.
    expect(resolveWorkflowConcurrency(Number.NaN)).toBe(WORKFLOW_MAX_INFLIGHT_AGENTS);
    expect(resolveWorkflowConcurrency(Number.POSITIVE_INFINITY)).toBe(WORKFLOW_MAX_INFLIGHT_AGENTS);
    expect(resolveWorkflowConcurrency(3.9)).toBe(3);
  });
});
