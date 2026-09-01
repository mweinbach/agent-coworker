import { describe, expect, test } from "bun:test";

import { compileWorkflowSource } from "../../src/workflows/compile";
import {
  resolveWorkflowConcurrency,
  WORKFLOW_MAX_CONFIGURABLE_AGENTS,
  WORKFLOW_MAX_INFLIGHT_AGENTS,
} from "../../src/workflows/scheduler";
import { WORKFLOW_WORKER_BOOTSTRAP } from "../../src/workflows/workerBootstrap";
import { metaHeader } from "./harness";

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

test("the worker caps outbound agent requests without relying on host admission", async () => {
  const compiled = compileWorkflowSource(
    `${metaHeader("worker-admission-limit", ["main"])}` +
      `export default async function run({ agent, phase, log }) {\n` +
      `  const calls = [];\n` +
      `  for (let index = 0; index < 1005; index += 1) {\n` +
      `    calls.push(agent("work").catch(() => null));\n` +
      `  }\n` +
      `  phase("main"); log("after ceiling");\n` +
      `  await Promise.all(calls);\n` +
      `  return "swallowed failure";\n}`,
  );
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) return;

  const blobUrl = URL.createObjectURL(
    new Blob([WORKFLOW_WORKER_BOOTSTRAP], { type: "text/javascript" }),
  );
  const worker = new Worker(blobUrl, { type: "module" } as WorkerOptions);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let outboundAgents = 0;
  try {
    const terminal = new Promise<{ t: string; message?: string }>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("worker did not settle")), 2_000);
      worker.onerror = (event) => reject(new Error(event.message));
      worker.onmessage = (event) => {
        const message = event.data;
        if (message.t === "meta") {
          worker.postMessage({
            t: "metaAck",
            callId: message.callId,
            ok: true,
            payload: { ok: true },
          });
        } else if (message.t === "agent") {
          outboundAgents += 1;
          worker.postMessage({
            t: "agentResult",
            callId: message.callId,
            ok: true,
            payload: JSON.stringify({ ok: true, value: "result" }),
          });
        } else if (message.t === "error" || message.t === "done") {
          resolve(message);
        }
      };
    });
    worker.postMessage({ t: "start", js: compiled.js, argsJson: "{}", budgetTotal: null });

    expect(await terminal).toMatchObject({
      t: "error",
      message: "workflow exceeded the 1000-agent ceiling",
    });
    expect(outboundAgents).toBe(1_000);
  } finally {
    clearTimeout(timer);
    worker.terminate();
    URL.revokeObjectURL(blobUrl);
  }
});
