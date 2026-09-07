import { expect, test } from "bun:test";

import { runCodeModeBenchmark } from "../scripts/benchmark_code_mode";

test("fake-tool benchmark checks equivalent results, fair parallel baseline and lifecycle", async () => {
  const report = await runCodeModeBenchmark({ trustedFixtureProcess: true });
  expect(report.codeMode.status).toBe("measured");
  expect(report.executionLane).toContain("no OS sandbox or hard-memory enforcement");
  expect(report.checks).toEqual({
    sameFinalResults: true,
    toolFailurePropagated: true,
    cancellationRetainsHostOwnership: true,
  });
  expect(report.measurements.map((measurement) => measurement.simulatedToolRequestBatches)).toEqual(
    [12, 1, 1],
  );
  expect(new Set(report.measurements.map((measurement) => measurement.finalResultBytes)).size).toBe(
    1,
  );
  const [serial, parallel, codeMode] = report.measurements;
  expect(serial.modelFacingToolOutputBytes).toBe(parallel.modelFacingToolOutputBytes);
  expect(codeMode.modelFacingToolOutputBytes).toBeLessThan(parallel.modelFacingToolOutputBytes);
  for (const measurement of report.measurements) {
    expect(measurement.wallTimeMs).toBeGreaterThanOrEqual(0);
  }
});
