import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  hasSeatbelt,
  isBwrapUsable,
  NEGATIVE_PROBE_COOLDOWN_MS,
  probeWindowsSandboxBundle,
  resetSandboxProbeCachesForTests,
  WINDOWS_SANDBOX_PROBE_TTL_MS,
} from "../../src/platform/sandbox/detect";

// Detection caches are process-global; never leak fabricated probe results
// (fake clocks, injected probes) into other suites in the same bun process.
afterEach(() => {
  resetSandboxProbeCachesForTests();
});

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("probeWindowsSandboxBundle memoization", () => {
  function makeHelper(): { root: string; helper: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-probe-cache-"));
    const helper = path.join(root, "cowork-win-sandbox.exe");
    fs.writeFileSync(helper, "helper-bytes");
    return { root, helper };
  }

  test("caches per (helperPath, sandboxHome) and re-probes after the TTL", () => {
    const { root, helper } = makeHelper();
    let t = 0;
    const now = () => t;
    try {
      // No trusted hashes configured -> integrity failure (no spawn happens).
      const first = probeWindowsSandboxBundle(helper, {}, { now });
      expect(first.warning).toContain("trusted SHA-256 is missing");

      // Within the TTL the (changed) env is NOT re-evaluated: same cache key,
      // stale result — this is what makes repeated sandboxed bash calls cheap.
      const changedEnv = { COWORK_WIN_SANDBOX_HELPER_SHA256: digest("something-else") };
      t = WINDOWS_SANDBOX_PROBE_TTL_MS - 1;
      const second = probeWindowsSandboxBundle(helper, changedEnv, { now });
      expect(second.warning).toContain("trusted SHA-256 is missing");

      // At the TTL boundary the probe re-runs and sees the new env.
      t = WINDOWS_SANDBOX_PROBE_TTL_MS;
      const third = probeWindowsSandboxBundle(helper, changedEnv, { now });
      expect(third.warning).toContain("SHA-256 mismatch");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a different sandbox home is a different cache entry", () => {
    const { root, helper } = makeHelper();
    const now = () => 0;
    try {
      const homeA = path.join(root, "home-a");
      const homeB = path.join(root, "home-b");
      const first = probeWindowsSandboxBundle(helper, { COWORK_WIN_SANDBOX_HOME: homeA }, { now });
      expect(first.warning).toContain("trusted SHA-256 is missing");
      // Same clock instant, different home: fresh probe, so the new env's
      // mismatched hash is observed instead of the cached "missing" result.
      const second = probeWindowsSandboxBundle(
        helper,
        { COWORK_WIN_SANDBOX_HOME: homeB, COWORK_WIN_SANDBOX_HELPER_SHA256: digest("other") },
        { now },
      );
      expect(second.warning).toContain("SHA-256 mismatch");
      expect(second.sandboxHome).toBe(path.resolve(homeB));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("callers cannot poison the cache by mutating a returned probe", () => {
    const now = () => 0;
    const first = probeWindowsSandboxBundle(null, {}, { now });
    expect(first.enforcement.filesystem).toBe(false);
    first.enforcement.filesystem = true;
    first.warning = "tampered";
    const second = probeWindowsSandboxBundle(null, {}, { now });
    expect(second.enforcement.filesystem).toBe(false);
    expect(second.warning).toContain("not found");
  });
});

describe("hasSeatbelt negative-result cooldown", () => {
  test("false is re-probed only after the cooldown", () => {
    let t = 0;
    let calls = 0;
    const probe = () => {
      calls += 1;
      return false;
    };
    expect(hasSeatbelt({ now: () => t, probe })).toBe(false);
    expect(calls).toBe(1);

    t = NEGATIVE_PROBE_COOLDOWN_MS - 1;
    expect(hasSeatbelt({ now: () => t, probe })).toBe(false);
    expect(calls).toBe(1); // still inside the cooldown: no re-probe

    t = NEGATIVE_PROBE_COOLDOWN_MS;
    expect(hasSeatbelt({ now: () => t, probe })).toBe(false);
    expect(calls).toBe(2); // cooldown elapsed: transient failures recover
  });

  test("true is cached for the process lifetime", () => {
    let t = 0;
    let calls = 0;
    const probe = () => {
      calls += 1;
      return true;
    };
    expect(hasSeatbelt({ now: () => t, probe })).toBe(true);
    t = NEGATIVE_PROBE_COOLDOWN_MS * 100;
    expect(hasSeatbelt({ now: () => t, probe })).toBe(true);
    expect(calls).toBe(1);
  });

  test("a recovered probe flips the cached value to true forever", () => {
    let t = 0;
    const results = [false, true];
    let calls = 0;
    const probe = () => {
      const value = results[Math.min(calls, results.length - 1)] as boolean;
      calls += 1;
      return value;
    };
    expect(hasSeatbelt({ now: () => t, probe })).toBe(false);
    t = NEGATIVE_PROBE_COOLDOWN_MS;
    expect(hasSeatbelt({ now: () => t, probe })).toBe(true);
    t = NEGATIVE_PROBE_COOLDOWN_MS * 10;
    expect(hasSeatbelt({ now: () => t, probe })).toBe(true);
    expect(calls).toBe(2);
  });
});

describe("isBwrapUsable negative-result cooldown", () => {
  test("false re-probes per program after the cooldown; true sticks", () => {
    let t = 0;
    const calls = new Map<string, number>();
    const probe = (program: string) => {
      calls.set(program, (calls.get(program) ?? 0) + 1);
      return program === "/usr/bin/bwrap-good";
    };

    expect(isBwrapUsable("/usr/bin/bwrap-bad", { now: () => t, probe })).toBe(false);
    expect(isBwrapUsable("/usr/bin/bwrap-good", { now: () => t, probe })).toBe(true);

    t = NEGATIVE_PROBE_COOLDOWN_MS - 1;
    expect(isBwrapUsable("/usr/bin/bwrap-bad", { now: () => t, probe })).toBe(false);
    expect(calls.get("/usr/bin/bwrap-bad")).toBe(1); // cooldown: cached false

    t = NEGATIVE_PROBE_COOLDOWN_MS;
    expect(isBwrapUsable("/usr/bin/bwrap-bad", { now: () => t, probe })).toBe(false);
    expect(calls.get("/usr/bin/bwrap-bad")).toBe(2); // re-probed after cooldown

    t = NEGATIVE_PROBE_COOLDOWN_MS * 100;
    expect(isBwrapUsable("/usr/bin/bwrap-good", { now: () => t, probe })).toBe(true);
    expect(calls.get("/usr/bin/bwrap-good")).toBe(1); // positive result never re-probes
  });
});
