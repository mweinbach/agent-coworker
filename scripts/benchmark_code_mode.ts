/**
 * Fixed independent fake-tool workflows, not an LLM/token benchmark.
 *
 * Production enforcement:
 *   bun scripts/benchmark_code_mode.ts
 *
 * Trusted fixtures on hosts without a hard-memory backend:
 *   bun scripts/benchmark_code_mode.ts --trusted-fixture-process
 *
 * The explicit fixture lane measures the real subprocess/VM/IPC plumbing but
 * NOT OS enforcement or sandbox startup. Never feed external code to that lane.
 */
import assert from "node:assert/strict";

import type { CodeModeProcessSpawner } from "../src/platform/codeModeProcess";
import { type CodeModeCatalog, createCodeModeTool } from "../src/runtime/codeMode";
import { spawnTrustedCodeModeFixture } from "../test/helpers/codeModeProcess";

const IDS = Array.from({ length: 12 }, (_, index) => index);
const BATCH_CODE = `
const results = await Promise.all(
  Array.from({length: 12}, (_, id) => tools.call("fixture.lookup", {id}))
);
return results.map(({id, score, sources}) => ({id, score, sources}));
`.trim();

function fixture(id: number) {
  return {
    id,
    score: id * 7,
    detail: "x".repeat(2048),
    sources: [{ id: `fixture-${id}`, url: `https://example.invalid/fixture/${id}` }],
  };
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const project = ({ id, score, sources }: ReturnType<typeof fixture>) => ({ id, score, sources });
const elapsed = (start: number) => Number((performance.now() - start).toFixed(3));
const catalog: CodeModeCatalog = {
  search: () => ({ tools: [{ name: "fixture.lookup" }] }),
  async call({ name, arguments: args }) {
    await Promise.resolve();
    if (name === "fixture.fail") throw new Error("fixture failure");
    assert.equal(name, "fixture.lookup");
    return fixture((args as { id: number }).id);
  },
};

type Measurement = {
  mode: string;
  wallTimeMs: number;
  simulatedToolRequestBatches: number;
  modelFacingToolOutputBytes: number;
  finalResultBytes: number;
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export async function runCodeModeBenchmark(options: { trustedFixtureProcess?: boolean } = {}) {
  const spawnProcess: CodeModeProcessSpawner | undefined = options.trustedFixtureProcess
    ? spawnTrustedCodeModeFixture
    : undefined;
  const dependencies = spawnProcess ? { spawnProcess } : undefined;
  const expected = IDS.map((id) => project(fixture(id)));
  const measurements: Measurement[] = [];
  let start = performance.now();
  const serial: ReturnType<typeof fixture>[] = [];
  for (const id of IDS) {
    serial.push(
      (await catalog.call({ name: "fixture.lookup", arguments: { id } })) as ReturnType<
        typeof fixture
      >,
    );
  }
  assert.deepEqual(serial.map(project), expected);
  measurements.push({
    mode: "direct-sequential",
    wallTimeMs: elapsed(start),
    simulatedToolRequestBatches: IDS.length,
    modelFacingToolOutputBytes: serial.reduce((total, value) => total + bytes(value), 0),
    finalResultBytes: bytes(expected),
  });
  start = performance.now();
  const parallel = (await Promise.all(
    IDS.map((id) => catalog.call({ name: "fixture.lookup", arguments: { id } })),
  )) as ReturnType<typeof fixture>[];
  assert.deepEqual(parallel.map(project), expected);
  measurements.push({
    mode: "direct-parallel",
    wallTimeMs: elapsed(start),
    simulatedToolRequestBatches: 1,
    modelFacingToolOutputBytes: parallel.reduce((total, value) => total + bytes(value), 0),
    finalResultBytes: bytes(expected),
  });

  const report = {
    scope:
      "deterministic fake tools; measured local wall time; no live LLM, token, or speedup claims",
    executionLane: options.trustedFixtureProcess
      ? "trusted-fixture-process: no OS sandbox or hard-memory enforcement"
      : "production-enforced-process",
    assumptions:
      "12 independent calls; direct-parallel is a fair one-batch baseline; " +
      "model-facing output counts JSON UTF-8 bytes only, not provider framing or tokens; " +
      "code mode explicitly projects away detail while retaining sources",
    codeModeSourceBytes: Buffer.byteLength(BATCH_CODE, "utf8"),
    nestedHostResultBytes: serial.reduce((total, value) => total + bytes(value), 0),
    measurements,
    codeMode: { status: "unavailable" as "unavailable" | "measured", reason: "" },
    checks: {
      // null means not run because enforced code mode was unavailable.
      sameFinalResults: null as boolean | null,
      toolFailurePropagated: null as boolean | null,
      cancellationRetainsHostOwnership: null as boolean | null,
    },
  };

  start = performance.now();
  let result: unknown;
  try {
    result = await createCodeModeTool({ catalog }, dependencies).execute({ code: BATCH_CODE });
  } catch (error) {
    report.codeMode.reason = error instanceof Error ? error.message : String(error);
    if (options.trustedFixtureProcess) throw error;
    return report;
  }
  assert.deepEqual(result, expected);
  report.checks.sameFinalResults = true;
  report.codeMode = { status: "measured", reason: "" };
  measurements.push({
    mode: "code-mode-batched-projection",
    wallTimeMs: elapsed(start),
    simulatedToolRequestBatches: 1,
    modelFacingToolOutputBytes: bytes(result),
    finalResultBytes: bytes(result),
  });

  await assert.rejects(
    Promise.resolve(
      createCodeModeTool({ catalog }, dependencies).execute({
        code: 'return await tools.call("fixture.fail", {});',
      }),
    ),
    /fixture failure/,
  );
  report.checks.toolFailurePropagated = true;

  const controller = new AbortController();
  const started = deferred();
  const release = deferred();
  let settled = false;
  let hostCompleted = false;
  const cancellationRun = Promise.resolve(
    createCodeModeTool(
      {
        catalog: {
          ...catalog,
          async call() {
            started.resolve();
            await release.promise;
            hostCompleted = true;
            return null;
          },
        },
        abortSignal: controller.signal,
      },
      dependencies,
    ).execute({ code: 'return await tools.call("fixture.wait", {});' }),
  );
  void cancellationRun.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.race([started.promise, cancellationRun]);
  controller.abort();
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(hostCompleted, false);
  release.resolve();
  await assert.rejects(cancellationRun, /cancelled/);
  assert.equal(hostCompleted, true);
  report.checks.cancellationRetainsHostOwnership = true;
  return report;
}

if (import.meta.main) {
  const flags = process.argv.slice(2);
  if (flags.some((flag) => flag !== "--trusted-fixture-process")) {
    throw new Error("only --trusted-fixture-process is supported; benchmark inputs are fixed");
  }
  console.log(
    JSON.stringify(
      await runCodeModeBenchmark({
        trustedFixtureProcess: flags.includes("--trusted-fixture-process"),
      }),
      null,
      2,
    ),
  );
}
