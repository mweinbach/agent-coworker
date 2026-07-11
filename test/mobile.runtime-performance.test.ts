import { describe, expect, test } from "bun:test";

import { MOBILE_RUNTIME_PROFILE_BUDGET } from "../apps/mobile/src/features/cowork/mobilePerformanceContracts";
import type { MobileRuntimeProfile } from "./fixtures/mobile-runtime-profile";

const PROFILE_FIELDS: Array<keyof MobileRuntimeProfile> = [
  "deltaEvents",
  "elapsedMs",
  "fixtureHeapBytes",
  "frameBudgetMisses",
  "maxUpdateCommitDurationMs",
  "networkRequests",
  "rowRenders",
  "streamingHeapBytes",
  "streamingHeapGrowthBytes",
  "totalUpdateCommitDurationMs",
  "updateCommits",
];

function parseMobileRuntimeProfile(value: unknown): MobileRuntimeProfile {
  if (typeof value !== "object" || value === null) {
    throw new Error("Mobile runtime profiler returned a non-object result");
  }
  const profile = value as Record<string, unknown>;
  for (const field of PROFILE_FIELDS) {
    if (typeof profile[field] !== "number") {
      throw new Error(`Mobile runtime profiler omitted numeric field ${field}`);
    }
  }
  return profile as MobileRuntimeProfile;
}

async function runIsolatedMobileRuntimeProfile(): Promise<MobileRuntimeProfile> {
  const profilerPath = `${import.meta.dir}/fixtures/mobile-runtime-profile.ts`;
  const child = Bun.spawn([process.execPath, profilerPath], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`Mobile runtime profiler exited ${exitCode}: ${stderr.trim()}`);
  }
  return parseMobileRuntimeProfile(JSON.parse(stdout.trim()) as unknown);
}

describe("mobile streaming runtime performance", () => {
  test("1,000 immutable tail updates stay inside render, commit, frame, heap, and request budgets", async () => {
    const profile = await runIsolatedMobileRuntimeProfile();

    expect(profile.updateCommits).toBe(MOBILE_RUNTIME_PROFILE_BUDGET.expectedUpdateCommits);
    expect(profile.rowRenders).toBeLessThanOrEqual(MOBILE_RUNTIME_PROFILE_BUDGET.maxRowRenders);
    expect(profile.frameBudgetMisses).toBeLessThanOrEqual(
      MOBILE_RUNTIME_PROFILE_BUDGET.maxFrameBudgetMisses,
    );
    expect(profile.totalUpdateCommitDurationMs).toBeLessThanOrEqual(
      MOBILE_RUNTIME_PROFILE_BUDGET.maxTotalUpdateCommitDurationMs,
    );
    expect(profile.fixtureHeapBytes).toBeLessThanOrEqual(
      MOBILE_RUNTIME_PROFILE_BUDGET.maxLongFixtureHeapBytes,
    );
    expect(profile.streamingHeapBytes).toBeLessThanOrEqual(
      MOBILE_RUNTIME_PROFILE_BUDGET.maxStreamingHeapBytes,
    );
    expect(profile.streamingHeapGrowthBytes).toBeLessThanOrEqual(
      MOBILE_RUNTIME_PROFILE_BUDGET.maxStreamingHeapGrowthBytes,
    );
    expect(profile.networkRequests).toBe(MOBILE_RUNTIME_PROFILE_BUDGET.maxNetworkRequests);

    const outputPath = process.env.MOBILE_PROFILE_OUTPUT;
    if (outputPath) {
      await Bun.write(outputPath, `${JSON.stringify(profile, null, 2)}\n`);
    }
  }, 30_000);
});
