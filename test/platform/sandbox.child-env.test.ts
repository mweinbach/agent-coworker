import { describe, expect, test } from "bun:test";

import { normalizeSandboxChildEnv, type SandboxPolicy } from "../../src/platform/sandbox/policy";

const outsideTemp = "/opt/cowork-not-a-temp";

describe("normalizeSandboxChildEnv policy gates", () => {
  test("returns the Windows env unchanged", () => {
    const env = {
      PATH: "C:\\Windows\\System32",
      TEMP: "C:\\Users\\alice\\AppData\\Local\\Temp",
      TMP: "C:\\Users\\alice\\AppData\\Local\\Temp",
    };
    const policy: SandboxPolicy = {
      kind: "workspace-write",
      writableRoots: ["C:\\repo"],
      network: true,
    };

    expect(normalizeSandboxChildEnv(env, policy, "win32")).toBe(env);
  });

  test("sets LC_MESSAGES on read-only and full-access policies without moving temp dirs", () => {
    const env = {
      PATH: "/usr/bin",
      TMPDIR: outsideTemp,
      TEMP: outsideTemp,
    };
    for (const policy of [
      { kind: "read-only", network: false },
      { kind: "danger-full-access" },
    ] as const satisfies readonly SandboxPolicy[]) {
      const normalized = normalizeSandboxChildEnv(env, policy, "linux");
      expect(normalized.LC_MESSAGES).toBe("C");
      expect(normalized.TMPDIR).toBe(outsideTemp);
      expect(normalized.TEMP).toBe(outsideTemp);
      expect(normalized).not.toBe(env);
    }
  });

  test("rewrites POSIX temp vars that sit outside scratch and keeps ones already under /tmp", () => {
    const policy: SandboxPolicy = {
      kind: "no-project-write",
      projectRoots: ["/work/app"],
      network: false,
    };
    const normalized = normalizeSandboxChildEnv(
      {
        TMPDIR: `${outsideTemp}/job`,
        TMP: "   ",
        TEMP: "/var/cowork-not-scratch",
      },
      policy,
      "linux",
    );

    expect(normalized.LC_MESSAGES).toBe("C");
    expect(normalized.TMPDIR).toBe("/tmp");
    expect(normalized.TMP).toBe("   ");
    expect(normalized.TEMP).toBe("/tmp");

    const inside = normalizeSandboxChildEnv(
      {
        TMPDIR: "/tmp/job",
        TEMP: "/tmp/job",
      },
      {
        kind: "workspace-write",
        writableRoots: ["/work/app"],
        network: true,
      },
      "linux",
    );
    expect(inside.TMPDIR).toBe("/tmp/job");
    expect(inside.TEMP).toBe("/tmp/job");
  });
});
