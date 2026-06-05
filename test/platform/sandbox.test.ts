import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildBwrapCommand } from "../../src/platform/sandbox/bwrap";
import { isLikelySandboxDenied } from "../../src/platform/sandbox/denied";
import {
  DEFAULT_SANDBOX_CONFIG,
  SANDBOX_ENV_VAR,
  SANDBOX_NETWORK_DISABLED_ENV_VAR,
  type SandboxCapabilities,
  SandboxManager,
} from "../../src/platform/sandbox/index";
import {
  canonicalizeRoot,
  filterTargetPathsToWorkspace,
  resolveSandboxPolicy,
  type SandboxPolicy,
} from "../../src/platform/sandbox/policy";
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
  test("default sandbox config fails closed when a backend is unavailable", () => {
    expect(DEFAULT_SANDBOX_CONFIG).toEqual({
      mode: "workspace-write",
      network: true,
      requireBackend: true,
    });
  });

  test("danger-full-access mode wins", () => {
    const policy = resolveSandboxPolicy({
      config: { mode: "danger-full-access" },
      workingDirectory: "/w",
    });
    expect(policy.kind).toBe("danger-full-access");
  });

  test("a scoped child stays scoped even under a danger-full-access config", () => {
    const policy = resolveSandboxPolicy({
      config: { mode: "danger-full-access" },
      workingDirectory: "/work/project",
      targetPaths: ["src/auth"],
    });
    // The explicit targetPaths scope is a hard floor; it is not lifted to full
    // access just because the workspace config is danger-full-access.
    expect(policy).toEqual({
      kind: "workspace-write",
      writableRoots: ["/work/project/src/auth"],
      network: true,
    });
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
    const chatWorkspace = path.join(os.tmpdir(), ".cowork", "chats", "abc");
    const policy = resolveSandboxPolicy({
      config: { mode: "workspace-write" },
      workingDirectory: chatWorkspace,
    });
    expect(policy).toEqual({
      kind: "workspace-write",
      writableRoots: [canonicalizeRoot(chatWorkspace)],
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

  test("includes uploadsDirectory in workspace-write roots (file-tool parity)", () => {
    const policy = resolveSandboxPolicy({
      config: { mode: "workspace-write", network: true },
      workingDirectory: "/work/project",
      outputDirectory: "/work/out",
      uploadsDirectory: "/work/uploads",
    });
    expect(policy).toEqual({
      kind: "workspace-write",
      writableRoots: ["/work/project", "/work/out", "/work/uploads"],
      network: true,
    });
  });

  test("includes the project root for a subdirectory working directory", () => {
    const policy = resolveSandboxPolicy({
      config: { mode: "workspace-write", network: true },
      workingDirectory: "/repo/src",
      projectRoot: "/repo",
    });
    expect(policy).toEqual({
      kind: "workspace-write",
      writableRoots: ["/repo/src", "/repo"],
      network: true,
    });
  });

  test("drops output/uploads roots that sit inside protected metadata", () => {
    const policy = resolveSandboxPolicy({
      config: { mode: "workspace-write", network: true },
      workingDirectory: "/work",
      outputDirectory: ".git/out",
      uploadsDirectory: ".cowork/up",
    });
    expect(policy).toEqual({
      kind: "workspace-write",
      writableRoots: ["/work"],
      network: true,
    });
  });

  test("drops an output/uploads dir that symlinks into protected metadata", () => {
    const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "od-ws-")));
    try {
      fs.mkdirSync(path.join(ws, ".git", "hooks"), { recursive: true });
      // `uploads` -> `.git/hooks`: a logical-looking root that really resolves
      // into protected metadata.
      fs.symlinkSync(path.join(ws, ".git", "hooks"), path.join(ws, "uploads"));
      const policy = resolveSandboxPolicy({
        config: { mode: "workspace-write", network: true },
        workingDirectory: ws,
        uploadsDirectory: "uploads",
      });
      expect(policy).toEqual({ kind: "workspace-write", writableRoots: [ws], network: true });
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test("drops a metadata root under the project root for a subdir working dir", () => {
    const policy = resolveSandboxPolicy({
      config: { mode: "workspace-write", network: true },
      workingDirectory: "/repo/src",
      projectRoot: "/repo",
      // Output dir mis-pointed at the project root's .git — must NOT be writable,
      // even though it is outside the subdirectory working directory.
      outputDirectory: "/repo/.git/hooks",
    });
    expect(policy).toEqual({
      kind: "workspace-write",
      writableRoots: ["/repo/src", "/repo"],
      network: true,
    });
  });
});

describe("filterTargetPathsToWorkspace", () => {
  test("keeps in-workspace paths and drops external/protected ones", () => {
    expect(
      filterTargetPathsToWorkspace("/work/project", [
        "src/ok",
        "/home/user/.ssh",
        "../sibling",
        ".git/hooks",
      ]),
    ).toEqual(["/work/project/src/ok"]);
  });

  test("returns empty when every entry is outside the workspace or protected", () => {
    expect(
      filterTargetPathsToWorkspace("/work/project", ["/etc/passwd", "../../x", ".cowork/secrets"]),
    ).toEqual([]);
  });

  test("drops an in-workspace symlink whose real target escapes the workspace", () => {
    const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tp-ws-")));
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tp-out-")));
    try {
      fs.mkdirSync(path.join(ws, "src"));
      // `src/link` -> external dir (escape); `src/ok` is a legit in-workspace dir.
      fs.symlinkSync(outside, path.join(ws, "src", "link"));
      fs.mkdirSync(path.join(ws, "src", "ok"));
      const roots = filterTargetPathsToWorkspace(ws, ["src/link", "src/ok"]);
      // The escaping symlink is dropped; the legit root is kept (canonicalized).
      expect(roots).toEqual([path.join(ws, "src", "ok")]);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("drops a not-yet-existing target below a symlinked parent that escapes", () => {
    const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tp-ws2-")));
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tp-out2-")));
    try {
      fs.mkdirSync(path.join(ws, "src"));
      // `src/link` exists and escapes; `new.ts` below it does NOT exist yet.
      fs.symlinkSync(outside, path.join(ws, "src", "link"));
      const roots = filterTargetPathsToWorkspace(ws, ["src/link/new.ts", "src/ok.ts"]);
      // The escaping parent is resolved via the existing prefix and dropped.
      expect(roots).toEqual([path.join(ws, "src", "ok.ts")]);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("contains scopes within the PROJECT root for a subdirectory working dir", () => {
    // workingDirectory is a subdir; the project root is the parent. Relative
    // entries resolve against the working dir, but containment is the project root.
    expect(filterTargetPathsToWorkspace("/repo/src", ["../package.json", "auth"], "/repo")).toEqual(
      ["/repo/package.json", "/repo/src/auth"],
    );
    // Escaping the project root, or crossing protected metadata, is still rejected.
    expect(
      filterTargetPathsToWorkspace("/repo/src", ["../../outside", "../.git/hooks"], "/repo"),
    ).toEqual([]);
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
    // writable root passed as a -D binding
    expect(args).toContain("-DWRITABLE_ROOT_0=/work");
    // protected metadata excluded recursively via a path regex (any depth)
    expect(policyText).toContain('(require-not (regex #"/\\.git(/|$)"))');
    expect(policyText).toContain('(require-not (regex #"/\\.cowork(/|$)"))');
    // /tmp is always writable scratch
    expect(args.some((a) => a.startsWith("-DWRITABLE_ROOT_") && a.endsWith("=/tmp"))).toBe(true);
  });

  test("workspace-write: excludes nested .git/.cowork recursively (not just direct children)", () => {
    const policy: SandboxPolicy = {
      kind: "workspace-write",
      writableRoots: ["/repo"],
      network: true,
    };
    const { args } = buildSeatbeltCommand(INNER, policy);
    const policyText = args[1];
    // One recursive regex per protected name covers nested cases like
    // /repo/src/.git/hooks, replacing the old per-root direct-child subpaths.
    expect(policyText).toContain('(require-not (regex #"/\\.git(/|$)"))');
    expect(args.some((a) => a.includes("_EXCLUDED_"))).toBe(false);
  });

  test("does not add /tmp or /private/tmp scratch for a /tmp-scoped root (macOS alias)", () => {
    const scopedRoot = canonicalizeRoot("/tmp/proj/src");
    const policy: SandboxPolicy = {
      kind: "workspace-write",
      writableRoots: ["/tmp/proj/src"],
      network: true,
    };
    const { args } = buildSeatbeltCommand(INNER, policy);
    // Neither blanket temp root may be granted: `/tmp` and `/private/tmp` are the
    // same tree on macOS, so either would re-open the scope via the alias.
    expect(args.some((a) => a.startsWith("-DWRITABLE_ROOT_") && a.endsWith("=/tmp"))).toBe(false);
    expect(args.some((a) => a.startsWith("-DWRITABLE_ROOT_") && a.endsWith("=/private/tmp"))).toBe(
      false,
    );
    // The scoped root itself stays writable.
    expect(args.some((a) => a.endsWith(`=${scopedRoot}`))).toBe(true);
  });

  test("canonicalizes symlinked writable roots (matches bwrap)", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "sb-canon-"));
    try {
      const real = path.join(base, "real");
      fs.mkdirSync(real);
      const link = path.join(base, "link");
      fs.symlinkSync(real, link);
      const policy: SandboxPolicy = {
        kind: "workspace-write",
        writableRoots: [link],
        network: true,
      };
      const { args } = buildSeatbeltCommand(INNER, policy);
      // The -D param must reference the resolved real path, not the logical
      // symlink, so a symlinked root can't grant writes outside its target.
      const resolved = fs.realpathSync(link);
      expect(args).toContain(`-DWRITABLE_ROOT_0=${resolved}`);
      expect(args).not.toContain(`-DWRITABLE_ROOT_0=${link}`);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
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

  test("creates file-like missing writable roots as files", () => {
    const existing = new Set(["/tmp", "/work/src"]);
    const fileRoots = new Set<string>();
    const createdDirs: string[] = [];
    const createdFiles: string[] = [];
    const policy: SandboxPolicy = {
      kind: "workspace-write",
      writableRoots: ["/work/src/new.ts"],
      network: true,
    };
    const { args } = buildBwrapCommand(INNER, policy, "/work", {
      program: "bwrap",
      exists: (p) => existing.has(p),
      ensureDir: (p) => {
        createdDirs.push(p);
        existing.add(p);
      },
      ensureFile: (p) => {
        createdFiles.push(p);
        existing.add(p);
        fileRoots.add(p);
      },
      isDirectory: (p) => !fileRoots.has(p),
    });
    expect(createdFiles).toContain("/work/src/new.ts");
    expect(createdDirs).not.toContain("/work/src/new.ts");
    expect(joinPairs(args, "--bind")).toContain("/work/src/new.ts /work/src/new.ts");
  });

  test("creates common dotless file roots as files", () => {
    const existing = new Set(["/tmp", "/work"]);
    const createdDirs: string[] = [];
    const createdFiles: string[] = [];
    const fileRoots = new Set<string>();
    const policy: SandboxPolicy = {
      kind: "workspace-write",
      writableRoots: ["/work/Dockerfile", "/work/Makefile"],
      network: true,
    };
    const { args } = buildBwrapCommand(INNER, policy, "/work", {
      program: "bwrap",
      exists: (p) => existing.has(p),
      ensureDir: (p) => {
        createdDirs.push(p);
        existing.add(p);
      },
      ensureFile: (p) => {
        createdFiles.push(p);
        existing.add(p);
        fileRoots.add(p);
      },
      isDirectory: (p) => !fileRoots.has(p),
    });
    expect(createdFiles).toEqual(["/work/Dockerfile", "/work/Makefile"]);
    expect(createdDirs).not.toContain("/work/Dockerfile");
    expect(joinPairs(args, "--bind")).toContain("/work/Dockerfile /work/Dockerfile");
    expect(joinPairs(args, "--bind")).toContain("/work/Makefile /work/Makefile");
  });

  test("re-freezes existing nested protected metadata under writable roots", () => {
    const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bwrap-meta-")));
    try {
      fs.mkdirSync(path.join(ws, "src", ".git", "hooks"), { recursive: true });
      fs.mkdirSync(path.join(ws, "pkg", ".cowork", "state"), { recursive: true });
      const policy: SandboxPolicy = {
        kind: "workspace-write",
        writableRoots: [ws],
        network: true,
      };
      const { args } = buildBwrapCommand(INNER, policy, ws, {
        program: "bwrap",
      });
      const roBinds = joinPairs(args, "--ro-bind");
      expect(roBinds).toContain(`${path.join(ws, "src", ".git")} ${path.join(ws, "src", ".git")}`);
      expect(roBinds).toContain(
        `${path.join(ws, "pkg", ".cowork")} ${path.join(ws, "pkg", ".cowork")}`,
      );
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test("does not add /tmp scratch when a root already lives under /tmp", () => {
    const scopedRoot = canonicalizeRoot("/tmp/proj/src");
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
    expect(joinPairs(args, "--bind")).toContain(`${scopedRoot} ${scopedRoot}`);
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

  test("win32 runs under the restricted-token helper with a partial-containment warning", () => {
    const helper = "C:/h/cowork-win-sandbox.exe";
    const r = mgr.transform({
      ...INNER,
      policy: { kind: "workspace-write", writableRoots: ["C:/w"], network: false },
      cwd: "C:/w",
      platform: "win32",
      capabilities: caps({ windowsHelperPath: helper }),
    });
    // The helper IS selected (process containment), wrapping the inner command.
    expect(r.sandbox).toBe("windows-restricted");
    expect(r.unsandboxed).toBe(false);
    expect(r.file).toBe(helper);
    expect(r.args).toContain("--mode");
    // ...but it does not enforce FS/network scoping, which must be surfaced.
    expect(r.warning).toContain("filesystem and network scoping are not yet enforced");
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
