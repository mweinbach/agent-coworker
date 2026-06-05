import { describe, expect, test } from "bun:test";

import { buildBwrapCommand } from "../../src/platform/sandbox/bwrap";
import { isLikelySandboxDenied } from "../../src/platform/sandbox/denied";
import {
  SANDBOX_ENV_VAR,
  SANDBOX_NETWORK_DISABLED_ENV_VAR,
  type SandboxCapabilities,
  SandboxManager,
} from "../../src/platform/sandbox/index";
import { resolveSandboxPolicy, type SandboxPolicy } from "../../src/platform/sandbox/policy";
import {
  buildSeatbeltCommand,
  MACOS_SEATBELT_EXECUTABLE,
} from "../../src/platform/sandbox/seatbelt";
import { buildWindowsSandboxCommand } from "../../src/platform/sandbox/windows";

const INNER = { file: "/bin/bash", args: ["-lc", "echo hi"] };

function caps(overrides: Partial<SandboxCapabilities> = {}): SandboxCapabilities {
  return { seatbelt: false, bwrapPath: null, windowsHelperPath: null, ...overrides };
}

describe("resolveSandboxPolicy", () => {
  test("danger-full-access mode wins", () => {
    const policy = resolveSandboxPolicy({
      config: { mode: "danger-full-access" },
      workingDirectory: "/w",
    });
    expect(policy.kind).toBe("danger-full-access");
  });

  test("read-only role forces read-only even on auto", () => {
    const policy = resolveSandboxPolicy({
      config: { mode: "auto" },
      readOnlyRole: true,
      workingDirectory: "/w",
    });
    expect(policy.kind).toBe("read-only");
  });

  test("workspace-write derives writable roots from cwd + output dir", () => {
    const policy = resolveSandboxPolicy({
      config: { mode: "workspace-write", network: false },
      workingDirectory: "/work/project",
      outputDirectory: "/work/out",
    });
    expect(policy).toEqual({
      kind: "workspace-write",
      writableRoots: ["/work/project", "/work/out"],
      network: false,
    });
  });

  test("child agent targetPaths become the only writable roots", () => {
    const policy = resolveSandboxPolicy({
      config: { mode: "auto" },
      workingDirectory: "/work/project",
      outputDirectory: "/work/out",
      targetPaths: ["/work/project/pkg-a"],
    });
    expect(policy).toEqual({
      kind: "workspace-write",
      writableRoots: ["/work/project/pkg-a"],
      network: true,
    });
  });

  test("read-only role stays read-only even under danger-full-access", () => {
    const policy = resolveSandboxPolicy({
      config: { mode: "danger-full-access" },
      readOnlyRole: true,
      workingDirectory: "/work/project",
    });
    expect(policy.kind).toBe("read-only");
  });

  test("relative targetPaths resolve against the workspace, not process cwd", () => {
    const policy = resolveSandboxPolicy({
      config: { mode: "auto" },
      workingDirectory: "/work/project",
      targetPaths: ["src/auth"],
    });
    expect(policy).toEqual({
      kind: "workspace-write",
      writableRoots: ["/work/project/src/auth"],
      network: true,
    });
  });

  test("drops writable roots inside protected metadata (.git/.cowork)", () => {
    const policy = resolveSandboxPolicy({
      config: { mode: "auto" },
      workingDirectory: "/work/project",
      targetPaths: [".git/hooks", ".cowork/skills", "src/ok"],
    });
    expect(policy).toEqual({
      kind: "workspace-write",
      writableRoots: ["/work/project/src/ok"],
      network: true,
    });
  });

  test("keeps a workspace that merely lives under a .cowork ancestor", () => {
    // One-off chat workspaces live under ~/.cowork/chats/<id>; the ancestor
    // `.cowork` must NOT cause the workspace root to be dropped.
    const policy = resolveSandboxPolicy({
      config: { mode: "workspace-write" },
      workingDirectory: "/home/u/.cowork/chats/abc",
    });
    expect(policy).toEqual({
      kind: "workspace-write",
      writableRoots: ["/home/u/.cowork/chats/abc"],
      network: true,
    });
  });

  test("drops absolute/escaping targetPaths outside the workspace", () => {
    const policy = resolveSandboxPolicy({
      config: { mode: "auto" },
      workingDirectory: "/work/project",
      targetPaths: ["/home/user/.ssh", "../sibling", "src/ok"],
    });
    expect(policy).toEqual({
      kind: "workspace-write",
      writableRoots: ["/work/project/src/ok"],
      network: true,
    });
  });
});

describe("seatbelt argv generation", () => {
  test("read-only: prepends sandbox-exec, allows read, no file-write section", () => {
    const policy: SandboxPolicy = { kind: "read-only", network: false };
    const { file, args } = buildSeatbeltCommand(INNER, policy);
    expect(file).toBe(MACOS_SEATBELT_EXECUTABLE);
    expect(args[0]).toBe("-p");
    const policyText = args[1];
    expect(policyText).toContain("(deny default)");
    expect(policyText).toContain("(allow file-read*)");
    expect(policyText).not.toContain("(allow file-write*");
    expect(policyText).not.toContain("network-outbound");
    // command appended after the -- separator
    expect(args.slice(-4)).toEqual(["--", "/bin/bash", "-lc", "echo hi"]);
  });

  test("workspace-write: emits write rules with -D params and protects .git/.cowork", () => {
    const policy: SandboxPolicy = {
      kind: "workspace-write",
      writableRoots: ["/work"],
      network: true,
    };
    const { args } = buildSeatbeltCommand(INNER, policy);
    const policyText = args[1];
    expect(policyText).toContain("(allow file-write*");
    expect(policyText).toContain("network-outbound");
    // writable root + protected subpaths passed as -D bindings
    expect(args).toContain("-DWRITABLE_ROOT_0=/work");
    expect(args).toContain("-DWRITABLE_ROOT_0_EXCLUDED_0=/work/.git");
    expect(args).toContain("-DWRITABLE_ROOT_0_EXCLUDED_1=/work/.cowork");
    // /tmp is always writable scratch
    expect(args.some((a) => a.startsWith("-DWRITABLE_ROOT_") && a.endsWith("=/tmp"))).toBe(true);
  });
});

describe("bwrap argv generation", () => {
  const allExist = { exists: () => true, program: "bwrap" };

  test("read-only: ro-bind root, unshare-net when network off", () => {
    const policy: SandboxPolicy = { kind: "read-only", network: false };
    const { file, args } = buildBwrapCommand(INNER, policy, "/work", allExist);
    expect(file).toBe("bwrap");
    expect(args).toContain("--ro-bind");
    expect(args).toContain("--unshare-net");
    expect(args).not.toContain("--bind"); // no writable roots
    expect(args.slice(-4)).toEqual(["--", "/bin/bash", "-lc", "echo hi"]);
  });

  test("workspace-write: binds writable roots, re-freezes .git, keeps network when enabled", () => {
    const policy: SandboxPolicy = {
      kind: "workspace-write",
      writableRoots: ["/work"],
      network: true,
    };
    const { args } = buildBwrapCommand(INNER, policy, "/work", allExist);
    // writable bind for the root
    expect(joinPairs(args, "--bind")).toContain("/work /work");
    // protected subpath re-frozen read-only
    expect(joinPairs(args, "--ro-bind")).toContain("/work/.git /work/.git");
    // network enabled => no unshare-net
    expect(args).not.toContain("--unshare-net");
    expect(args).toContain("--chdir");
  });

  test("creates and binds nonexistent writable roots", () => {
    const existing = new Set(["/tmp"]);
    const created: string[] = [];
    const policy: SandboxPolicy = {
      kind: "workspace-write",
      writableRoots: ["/work/new-feature"],
      network: true,
    };
    const { args } = buildBwrapCommand(INNER, policy, "/work", {
      program: "bwrap",
      exists: (p) => existing.has(p),
      ensureDir: (p) => {
        created.push(p);
        existing.add(p);
      },
    });
    // The missing target dir is created so the child can work in its own scope.
    expect(created).toContain("/work/new-feature");
    expect(joinPairs(args, "--bind")).toContain("/work/new-feature /work/new-feature");
  });

  test("does not add /tmp scratch when a root already lives under /tmp", () => {
    const policy: SandboxPolicy = {
      kind: "workspace-write",
      writableRoots: ["/tmp/proj/src"],
      network: true,
    };
    const { args } = buildBwrapCommand(INNER, policy, "/tmp/proj/src", {
      program: "bwrap",
      exists: () => true,
    });
    // The scoped root is bound, but /tmp is NOT blanket-bound (would over-scope).
    expect(joinPairs(args, "--bind")).toContain("/tmp/proj/src /tmp/proj/src");
    expect(joinPairs(args, "--bind")).not.toContain("/tmp /tmp");
  });
});

describe("windows wrapper", () => {
  test("workspace-write: helper invocation with mode + writable roots", () => {
    const policy: SandboxPolicy = {
      kind: "workspace-write",
      writableRoots: ["/work"],
      network: false,
    };
    const { file, args } = buildWindowsSandboxCommand(
      INNER,
      policy,
      "/work",
      "C:/h/cowork-win-sandbox.exe",
    );
    expect(file).toBe("C:/h/cowork-win-sandbox.exe");
    expect(args).toContain("--mode");
    expect(args).toContain("workspace-write");
    expect(args).toContain("--writable-root");
    expect(args).not.toContain("--allow-network");
    expect(args.slice(-4)).toEqual(["--", "/bin/bash", "-lc", "echo hi"]);
  });
});

describe("SandboxManager.transform", () => {
  const mgr = new SandboxManager();

  test("danger-full-access => unwrapped, no markers, no warning", () => {
    const r = mgr.transform({
      ...INNER,
      policy: { kind: "danger-full-access" },
      cwd: "/w",
      platform: "linux",
      capabilities: caps(),
    });
    expect(r.sandbox).toBe("none");
    expect(r.unsandboxed).toBe(true);
    expect(r.warning).toBeUndefined();
    expect(r.file).toBe("/bin/bash");
    expect(r.env).toEqual({});
  });

  test("darwin with seatbelt => wraps and sets marker env", () => {
    const r = mgr.transform({
      ...INNER,
      policy: { kind: "read-only", network: false },
      cwd: "/w",
      platform: "darwin",
      capabilities: caps({ seatbelt: true }),
    });
    expect(r.sandbox).toBe("macos-seatbelt");
    expect(r.file).toBe(MACOS_SEATBELT_EXECUTABLE);
    expect(r.env[SANDBOX_ENV_VAR]).toBe("macos-seatbelt");
    expect(r.env[SANDBOX_NETWORK_DISABLED_ENV_VAR]).toBe("1");
  });

  test("linux without bwrap => unsandboxed with warning", () => {
    const r = mgr.transform({
      ...INNER,
      policy: { kind: "workspace-write", writableRoots: ["/w"], network: true },
      cwd: "/w",
      platform: "linux",
      capabilities: caps({ bwrapPath: null }),
    });
    expect(r.sandbox).toBe("none");
    expect(r.unsandboxed).toBe(true);
    expect(r.warning).toContain("bubblewrap");
    expect(r.file).toBe("/bin/bash");
  });

  test("linux with bwrap => wraps", () => {
    const r = mgr.transform({
      ...INNER,
      policy: { kind: "read-only", network: true },
      cwd: "/w",
      platform: "linux",
      capabilities: caps({ bwrapPath: "/usr/bin/bwrap" }),
    });
    expect(r.sandbox).toBe("linux-bwrap");
    expect(r.file).toBe("/usr/bin/bwrap");
    expect(r.env[SANDBOX_NETWORK_DISABLED_ENV_VAR]).toBeUndefined();
  });

  test("win32 without helper => unsandboxed with warning", () => {
    const r = mgr.transform({
      ...INNER,
      policy: { kind: "read-only", network: false },
      cwd: "C:/w",
      platform: "win32",
      capabilities: caps({ windowsHelperPath: null }),
    });
    expect(r.sandbox).toBe("none");
    expect(r.warning).toContain("cowork-win-sandbox");
  });
});

describe("isLikelySandboxDenied", () => {
  test("flags permission/read-only failures with non-trivial exit codes", () => {
    expect(
      isLikelySandboxDenied({
        stdout: "",
        stderr: "touch: cannot touch 'x': Read-only file system",
        exitCode: 1,
      }),
    ).toBe(true);
    expect(
      isLikelySandboxDenied({ stdout: "", stderr: "Operation not permitted", exitCode: 1 }),
    ).toBe(true);
  });

  test("flags Windows 'Access is denied' failures", () => {
    expect(isLikelySandboxDenied({ stdout: "", stderr: "Access is denied.", exitCode: 1 })).toBe(
      true,
    );
  });

  test("ignores success and command-not-found", () => {
    expect(isLikelySandboxDenied({ stdout: "ok", stderr: "", exitCode: 0 })).toBe(false);
    expect(
      isLikelySandboxDenied({ stdout: "", stderr: "bash: foo: command not found", exitCode: 127 }),
    ).toBe(false);
  });
});

/** Join repeated `flag value1 value2` triples into "value1 value2" tokens for assertion. */
function joinPairs(args: string[], flag: string): string[] {
  const pairs: string[] = [];
  for (let i = 0; i < args.length - 2; i++) {
    if (args[i] === flag) pairs.push(`${args[i + 1]} ${args[i + 2]}`);
  }
  return pairs;
}
