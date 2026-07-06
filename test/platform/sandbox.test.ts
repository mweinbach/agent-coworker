import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildBwrapCommand } from "../../src/platform/sandbox/bwrap";
import {
  classifySandboxDenial,
  describeSandboxDenial,
  isLikelySandboxDenied,
} from "../../src/platform/sandbox/denied";
import {
  findBwrapProbeCommand,
  probeWindowsSandboxBundle,
} from "../../src/platform/sandbox/detect";
import {
  DEFAULT_SANDBOX_CONFIG,
  detectCapabilities,
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
  tmpScratchRoots,
} from "../../src/platform/sandbox/policy";
import {
  buildSeatbeltCommand,
  MACOS_SEATBELT_EXECUTABLE,
} from "../../src/platform/sandbox/seatbelt";
import { buildWindowsSandboxCommand } from "../../src/platform/sandbox/windows";

const INNER = { file: "/bin/bash", args: ["-lc", "echo hi"] };
const posixBackendDescribe = process.platform === "win32" ? describe.skip : describe;

function caps(overrides: Partial<SandboxCapabilities> = {}): SandboxCapabilities {
  return { seatbelt: false, bwrapPath: null, windowsHelperPath: null, ...overrides };
}

function testRoot(value: string): string {
  return canonicalizeRoot(value);
}

describe("resolveSandboxPolicy", () => {
  test("default sandbox config allows approved fallback when a backend is unavailable", () => {
    expect(DEFAULT_SANDBOX_CONFIG).toEqual({
      mode: "workspace-write",
      network: true,
      requireBackend: false,
    });
  });

  test("danger-full-access mode wins", () => {
    const policy = resolveSandboxPolicy({
      config: { mode: "danger-full-access" },
      workingDirectory: "/w",
    });
    expect(policy.kind).toBe("danger-full-access");
  });

  test("danger-full-access preserves an explicitly disabled network policy", () => {
    const policy = resolveSandboxPolicy({
      config: { mode: "danger-full-access", network: false },
      workingDirectory: "/w",
    });
    expect(policy).toEqual({ kind: "danger-full-access", network: false });
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
      writableRoots: [testRoot("/work/project/src/auth")],
      network: true,
    });
  });

  test("YOLO lifts an unscoped workspace-write session to danger-full-access", () => {
    const policy = resolveSandboxPolicy({
      config: { mode: "workspace-write" },
      workingDirectory: "/w",
      yolo: true,
    });
    expect(policy).toEqual({ kind: "danger-full-access" });
  });

  test("YOLO preserves an explicitly disabled network policy", () => {
    const policy = resolveSandboxPolicy({
      config: { mode: "workspace-write", network: false },
      workingDirectory: "/w",
      yolo: true,
    });
    expect(policy).toEqual({ kind: "danger-full-access", network: false });
  });

  test("YOLO does not widen an explicit read-only mode", () => {
    const policy = resolveSandboxPolicy({
      config: { mode: "read-only", network: true },
      workingDirectory: "/w",
      yolo: true,
    });
    expect(policy).toEqual({ kind: "read-only", network: true });
  });

  test("YOLO does not widen a read-only role", () => {
    const policy = resolveSandboxPolicy({
      config: { mode: "workspace-write" },
      readOnlyRole: true,
      workingDirectory: "/work/project",
      yolo: true,
    });
    expect(policy).toEqual({
      kind: "no-project-write",
      projectRoots: [testRoot("/work/project")],
      network: true,
    });
  });

  test("YOLO does not lift a scoped child beyond its targetPaths", () => {
    const policy = resolveSandboxPolicy({
      config: { mode: "workspace-write" },
      workingDirectory: "/work/project",
      targetPaths: ["src/auth"],
      yolo: true,
    });
    expect(policy).toEqual({
      kind: "workspace-write",
      writableRoots: [testRoot("/work/project/src/auth")],
      network: true,
    });
  });

  test("read-only role forbids project writes while preserving temp scratch", () => {
    const policy = resolveSandboxPolicy({
      config: { mode: "auto" },
      readOnlyRole: true,
      workingDirectory: "/w",
    });
    expect(policy.kind).toBe("no-project-write");
  });

  test("read-only role is not widened by advanced-memory writable roots", () => {
    const policy = resolveSandboxPolicy({
      config: { mode: "workspace-write" },
      readOnlyRole: true,
      workingDirectory: "/work/project",
      toolRuntimeWritableRoots: ["/home/user/.cowork/memories/project-active"],
    });
    expect(policy).toEqual({
      kind: "no-project-write",
      projectRoots: [testRoot("/work/project")],
      network: true,
    });
  });

  test("explicit read-only mode remains fully read-only", () => {
    const policy = resolveSandboxPolicy({
      config: { mode: "read-only", network: false },
      workingDirectory: "/w",
    });
    expect(policy.kind).toBe("read-only");
    expect(policy).toEqual({ kind: "read-only", network: false });
  });

  test("explicit read-only mode beats read-only role temp scratch", () => {
    const policy = resolveSandboxPolicy({
      config: { mode: "read-only", network: false },
      readOnlyRole: true,
      workingDirectory: "/w",
    });
    expect(policy).toEqual({ kind: "read-only", network: false });
  });

  test("workspace-write derives writable roots from cwd + output dir", () => {
    const policy = resolveSandboxPolicy({
      config: { mode: "workspace-write", network: false },
      workingDirectory: "/work/project",
      outputDirectory: "/work/out",
    });
    expect(policy).toEqual({
      kind: "workspace-write",
      writableRoots: [testRoot("/work/project"), testRoot("/work/out")],
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
      writableRoots: [testRoot("/work/project/pkg-a")],
      network: true,
    });
  });

  test("read-only role keeps project writes disabled even under danger-full-access", () => {
    const policy = resolveSandboxPolicy({
      config: { mode: "danger-full-access" },
      readOnlyRole: true,
      workingDirectory: "/work/project",
    });
    expect(policy.kind).toBe("no-project-write");
  });

  test("no-project-write policy carries project roots for temp scratch exclusion", () => {
    const policy = resolveSandboxPolicy({
      config: { mode: "auto" },
      readOnlyRole: true,
      workingDirectory: "/tmp/project/src",
      projectRoot: "/tmp/project",
    });
    expect(policy).toEqual({
      kind: "no-project-write",
      projectRoots: [path.resolve("/tmp/project/src"), path.resolve("/tmp/project")],
      network: true,
    });
  });

  test("temp scratch exclusion canonicalizes symlinked project roots", () => {
    if (process.platform === "win32") {
      return;
    }

    const realProject = fs.mkdtempSync(path.join("/tmp", "cowork-sandbox-real-project-"));
    const linkParent = fs.mkdtempSync(path.join(process.cwd(), ".tmp-cowork-sandbox-link-"));
    const linkedProject = path.join(linkParent, "project-link");
    try {
      fs.symlinkSync(realProject, linkedProject, "dir");
      expect(tmpScratchRoots([linkedProject], ["/tmp"])).toEqual([]);
    } finally {
      fs.rmSync(linkParent, { recursive: true, force: true });
      fs.rmSync(realProject, { recursive: true, force: true });
    }
  });

  test("relative targetPaths resolve against the workspace, not process cwd", () => {
    const policy = resolveSandboxPolicy({
      config: { mode: "auto" },
      workingDirectory: "/work/project",
      targetPaths: ["src/auth"],
    });
    expect(policy).toEqual({
      kind: "workspace-write",
      writableRoots: [testRoot("/work/project/src/auth")],
      network: true,
    });
  });

  test("preserves explicit directory intent for targetPaths with trailing separators", () => {
    const policy = resolveSandboxPolicy({
      config: { mode: "auto" },
      workingDirectory: "/work/project",
      targetPaths: ["docs/v1.0/"],
    });
    expect(policy).toEqual({
      kind: "workspace-write",
      writableRoots: [testRoot("/work/project/docs/v1.0")],
      writableRootKinds: { [testRoot("/work/project/docs/v1.0")]: "directory" },
      network: true,
    });
  });

  test("preserves file intent for file-like targetPaths before bwrap setup", () => {
    const policy = resolveSandboxPolicy({
      config: { mode: "auto" },
      workingDirectory: "/work/project",
      targetPaths: ["src/new.ts"],
    });
    expect(policy).toEqual({
      kind: "workspace-write",
      writableRoots: [testRoot("/work/project/src/new.ts")],
      writableRootKinds: { [testRoot("/work/project/src/new.ts")]: "file" },
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
      writableRoots: [testRoot("/work/project/src/ok")],
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
      writableRoots: [testRoot("/work/project/src/ok")],
      network: true,
    });
  });

  test("keeps in-workspace names that merely start with '..'", () => {
    const policy = resolveSandboxPolicy({
      config: { mode: "auto" },
      workingDirectory: "/work/project",
      targetPaths: ["..foo"],
    });
    expect(policy).toEqual({
      kind: "workspace-write",
      writableRoots: [testRoot("/work/project/..foo")],
      writableRootKinds: { [testRoot("/work/project/..foo")]: "file" },
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
      writableRoots: [testRoot("/work/project"), testRoot("/work/out"), testRoot("/work/uploads")],
      network: true,
    });
  });

  test("includes Cowork tool runtime caches in unscoped workspace-write roots", () => {
    const policy = resolveSandboxPolicy({
      config: { mode: "workspace-write", network: true },
      workingDirectory: "/work/project",
      outputDirectory: "/work/out",
      uploadsDirectory: "/work/uploads",
      toolRuntimeWritableRoots: ["/Users/test/.cache/cowork/artifact-runtime"],
    });
    expect(policy).toEqual({
      kind: "workspace-write",
      writableRoots: [
        testRoot("/work/project"),
        testRoot("/work/out"),
        testRoot("/work/uploads"),
        testRoot("/Users/test/.cache/cowork/artifact-runtime"),
      ],
      network: true,
    });
  });

  test("does not widen scoped child targetPaths with tool runtime caches", () => {
    const policy = resolveSandboxPolicy({
      config: { mode: "workspace-write", network: true },
      workingDirectory: "/work/project",
      targetPaths: ["src/only"],
      toolRuntimeWritableRoots: ["/Users/test/.cache/cowork/artifact-runtime"],
    });
    expect(policy).toEqual({
      kind: "workspace-write",
      writableRoots: [testRoot("/work/project/src/only")],
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
      writableRoots: [testRoot("/repo/src"), testRoot("/repo")],
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
      writableRoots: [testRoot("/work")],
      network: true,
    });
  });

  test("drops an output/uploads dir that symlinks into protected metadata", () => {
    const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "od-ws-")));
    try {
      fs.mkdirSync(path.join(ws, ".git", "hooks"), { recursive: true });
      // `uploads` -> `.git/hooks`: a logical-looking root that really resolves
      // into protected metadata.
      fs.symlinkSync(
        path.join(ws, ".git", "hooks"),
        path.join(ws, "uploads"),
        process.platform === "win32" ? "junction" : undefined,
      );
      const policy = resolveSandboxPolicy({
        config: { mode: "workspace-write", network: true },
        workingDirectory: ws,
        uploadsDirectory: "uploads",
      });
      expect(policy).toEqual({
        kind: "workspace-write",
        writableRoots: [canonicalizeRoot(ws)],
        network: true,
      });
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
      writableRoots: [testRoot("/repo/src"), testRoot("/repo")],
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
    ).toEqual([testRoot("/work/project/src/ok")]);
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
      fs.symlinkSync(
        outside,
        path.join(ws, "src", "link"),
        process.platform === "win32" ? "junction" : undefined,
      );
      fs.mkdirSync(path.join(ws, "src", "ok"));
      const roots = filterTargetPathsToWorkspace(ws, ["src/link", "src/ok"]);
      // The escaping symlink is dropped; the legit root is kept (canonicalized).
      expect(roots).toEqual([canonicalizeRoot(path.join(ws, "src", "ok"))]);
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
      fs.symlinkSync(
        outside,
        path.join(ws, "src", "link"),
        process.platform === "win32" ? "junction" : undefined,
      );
      const roots = filterTargetPathsToWorkspace(ws, ["src/link/new.ts", "src/ok.ts"]);
      // The escaping parent is resolved via the existing prefix and dropped.
      expect(roots).toEqual([canonicalizeRoot(path.join(ws, "src", "ok.ts"))]);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("contains scopes within the PROJECT root for a subdirectory working dir", () => {
    // workingDirectory is a subdir; the project root is the parent. Relative
    // entries resolve against the working dir, but containment is the project root.
    expect(filterTargetPathsToWorkspace("/repo/src", ["../package.json", "auth"], "/repo")).toEqual(
      [testRoot("/repo/package.json"), testRoot("/repo/src/auth")],
    );
    // Escaping the project root, or crossing protected metadata, is still rejected.
    expect(
      filterTargetPathsToWorkspace("/repo/src", ["../../outside", "../.git/hooks"], "/repo"),
    ).toEqual([]);
  });
});

posixBackendDescribe("seatbelt argv generation", () => {
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

  test("no-project-write: allows temp scratch but no project writable roots", () => {
    const policy: SandboxPolicy = { kind: "no-project-write", network: false };
    const { args } = buildSeatbeltCommand(INNER, policy);
    const policyText = args[1];
    expect(policyText).toContain("(allow file-read*)");
    expect(policyText).toContain("(allow file-write*");
    expect(
      args.some(
        (a) =>
          a.startsWith("-DWRITABLE_ROOT_") && (a.endsWith("=/tmp") || a.endsWith("=/private/tmp")),
      ),
    ).toBe(true);
    expect(args.some((a) => a.includes("=/work"))).toBe(false);
  });

  test("no-project-write: skips temp scratch when the project lives under /tmp", () => {
    const policy: SandboxPolicy = {
      kind: "no-project-write",
      projectRoots: ["/tmp/project"],
      network: false,
    };
    const { args } = buildSeatbeltCommand(INNER, policy);
    expect(args.some((a) => a.startsWith("-DWRITABLE_ROOT_") && a.endsWith("=/tmp"))).toBe(false);
    expect(args.some((a) => a.startsWith("-DWRITABLE_ROOT_") && a.endsWith("=/private/tmp"))).toBe(
      false,
    );
    expect(args.some((a) => a.includes("=/tmp/project"))).toBe(false);
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
    // writable root + protected metadata (direct children) passed as -D bindings
    expect(args).toContain("-DWRITABLE_ROOT_0=/work");
    expect(
      args.some((a) => a.startsWith("-DWRITABLE_EXCLUDED_") && a.endsWith("=/work/.git")),
    ).toBe(true);
    expect(
      args.some((a) => a.startsWith("-DWRITABLE_EXCLUDED_") && a.endsWith("=/work/.cowork")),
    ).toBe(true);
    // /tmp is always writable scratch
    expect(args.some((a) => a.startsWith("-DWRITABLE_ROOT_") && a.endsWith("=/tmp"))).toBe(true);
  });

  test("excludes metadata BELOW the root, not ancestor segments (workspace under .cowork)", () => {
    // One-off chat workspaces live under ~/.cowork/chats/<id>; the exclusion must
    // target the root's OWN .git/.cowork (passed as -D params, relative to the
    // root), not the ancestor `.cowork` — which an absolute-path regex would match
    // and thereby deny every write under the workspace.
    const root = "/home/me/.cowork/chats/abc";
    const canonicalRoot = canonicalizeRoot(root);
    const policy: SandboxPolicy = {
      kind: "workspace-write",
      writableRoots: [root],
      network: true,
    };
    const { args } = buildSeatbeltCommand(INNER, policy);
    const policyText = args[1];
    expect(policyText).not.toContain('(require-not (regex #"/\\.cowork(/|$)"))');
    expect(args.some((a) => a.endsWith(`=${path.join(canonicalRoot, ".git")}`))).toBe(true);
    expect(args.some((a) => a.endsWith(`=${path.join(canonicalRoot, ".cowork")}`))).toBe(true);
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

  test("file-scoped writable roots do not allow a writable subpath", () => {
    const policy: SandboxPolicy = {
      kind: "workspace-write",
      writableRoots: ["/work/new.ts"],
      writableRootKinds: { ["/work/new.ts"]: "file" },
      network: true,
    };
    const { args } = buildSeatbeltCommand(INNER, policy);
    const policyText = args[1];
    expect(args).toContain("-DWRITABLE_ROOT_0=/work/new.ts");
    expect(policyText).toContain('(literal (param "WRITABLE_ROOT_0"))');
    expect(policyText).not.toContain('(subpath (param "WRITABLE_ROOT_0"))');
  });
});

describe("sandbox capability detection", () => {
  test("searches Electron resources/binaries for the Windows helper", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "win-helper-resources-"));
    const binaries = path.join(base, "binaries");
    const helperPath = path.join(binaries, "cowork-win-sandbox.exe");
    const descriptor = Object.getOwnPropertyDescriptor(process, "resourcesPath");
    const previousHelperOverride = process.env.COWORK_WIN_SANDBOX_HELPER;
    try {
      delete process.env.COWORK_WIN_SANDBOX_HELPER;
      fs.mkdirSync(binaries, { recursive: true });
      fs.writeFileSync(helperPath, "");
      Object.defineProperty(process, "resourcesPath", {
        configurable: true,
        value: base,
      });

      expect(detectCapabilities("win32").windowsHelperPath).toBe(helperPath);
    } finally {
      if (descriptor) {
        Object.defineProperty(process, "resourcesPath", descriptor);
      } else {
        Reflect.deleteProperty(process, "resourcesPath");
      }
      if (previousHelperOverride === undefined) {
        delete process.env.COWORK_WIN_SANDBOX_HELPER;
      } else {
        process.env.COWORK_WIN_SANDBOX_HELPER = previousHelperOverride;
      }
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

posixBackendDescribe("bwrap argv generation", () => {
  const allExist = { exists: () => true, program: "bwrap" };

  test("read-only: ro-bind root, unshare-net when network off", () => {
    const policy: SandboxPolicy = { kind: "read-only", network: false };
    const { file, args } = buildBwrapCommand(INNER, policy, "/work", allExist);
    expect(file).toBe("bwrap");
    expect(args).toContain("--ro-bind");
    expect(args).toContain("--unshare-net");
    // IPC isolation is always applied (covert-channel hardening).
    expect(args).toContain("--unshare-ipc");
    expect(args).not.toContain("--bind"); // no writable roots
    expect(args.slice(-4)).toEqual(["--", "/bin/bash", "-lc", "echo hi"]);
  });

  test("no-project-write: binds only temp scratch and unshares network when off", () => {
    const policy: SandboxPolicy = { kind: "no-project-write", network: false };
    const { args } = buildBwrapCommand(INNER, policy, "/work", allExist);
    const binds = joinPairs(args, "--bind");
    const tmpRoot = canonicalizeRoot("/tmp");
    expect(binds).toContain(`${tmpRoot} ${tmpRoot}`);
    expect(binds).not.toContain("/work /work");
    expect(args).toContain("--unshare-net");
  });

  test("no-project-write: does not bind /tmp scratch for /tmp projects", () => {
    const policy: SandboxPolicy = {
      kind: "no-project-write",
      projectRoots: ["/tmp/project"],
      network: false,
    };
    const { args } = buildBwrapCommand(INNER, policy, "/tmp/project", allExist);
    const binds = joinPairs(args, "--bind");
    const tmpRoot = canonicalizeRoot("/tmp");
    expect(binds).not.toContain(`${tmpRoot} ${tmpRoot}`);
    expect(binds).not.toContain("/tmp/project /tmp/project");
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

  test("workspace-write: re-freezes nested .git files as protected metadata", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "bwrap-git-file-"));
    try {
      const nested = path.join(base, "module");
      fs.mkdirSync(nested);
      const gitFile = path.join(nested, ".git");
      fs.writeFileSync(gitFile, "gitdir: ../.git/modules/module\n");
      const policy: SandboxPolicy = {
        kind: "workspace-write",
        writableRoots: [base],
        network: true,
      };
      const { args } = buildBwrapCommand(INNER, policy, base, {
        program: "bwrap",
        exists: (p) => p === "/tmp" || fs.existsSync(p),
        isDirectory: (p) => {
          if (p === "/tmp") return true;
          return fs.statSync(p).isDirectory();
        },
      });
      const canonicalGitFile = canonicalizeRoot(gitFile);
      expect(joinPairs(args, "--ro-bind")).toContain(`${canonicalGitFile} ${canonicalGitFile}`);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test("danger-full-access can still disable network", () => {
    const policy: SandboxPolicy = { kind: "danger-full-access", network: false };
    const { args } = buildBwrapCommand(INNER, policy, "/work", allExist);
    expect(joinPairs(args, "--bind")).toContain("/ /");
    expect(args).toContain("--unshare-net");
  });

  test("does not create absent protected metadata mountpoints on the host", () => {
    const policy: SandboxPolicy = {
      kind: "workspace-write",
      writableRoots: ["/work"],
      network: true,
    };
    const { args } = buildBwrapCommand(INNER, policy, "/work", {
      program: "bwrap",
      exists: (p) => p === "/work" || p === "/tmp",
      isDirectory: (p) => p === "/work" || p === "/tmp",
    });
    expect(joinPairs(args, "--ro-bind")).not.toContain("/work/.git /work/.git");
    expect(joinPairs(args, "--ro-bind")).not.toContain("/work/.cowork /work/.cowork");
    expect(args).not.toContain("--tmpfs");
    expect(args).not.toContain("--remount-ro");
  });

  test("skips nonexistent writable roots without an explicit kind hint", () => {
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
    // Missing roots are not guessed as files or dirs; callers must provide a
    // writableRootKinds hint before sandbox setup mutates the host filesystem.
    expect(created).toEqual([]);
    expect(joinPairs(args, "--bind")).not.toContain("/work/new-feature /work/new-feature");
  });

  test("does not guess dotted missing writable roots as files", () => {
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
    expect(createdDirs).not.toContain("/work/src/new.ts");
    expect(createdFiles).not.toContain("/work/src/new.ts");
    expect(joinPairs(args, "--bind")).not.toContain("/work/src/new.ts /work/src/new.ts");
  });

  test("creates explicitly hinted file roots as files", () => {
    const existing = new Set(["/tmp", "/work/src"]);
    const createdDirs: string[] = [];
    const createdFiles: string[] = [];
    const fileRoots = new Set<string>();
    const policy: SandboxPolicy = {
      kind: "workspace-write",
      writableRoots: ["/work/src/new.ts"],
      writableRootKinds: { "/work/src/new.ts": "file" },
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

  test("creates dotted roots with explicit directory intent as directories", () => {
    const existing = new Set(["/tmp", "/work", "/work/docs"]);
    const createdDirs: string[] = [];
    const createdFiles: string[] = [];
    const policy: SandboxPolicy = {
      kind: "workspace-write",
      writableRoots: ["/work/docs/v1.0"],
      writableRootKinds: { "/work/docs/v1.0": "directory" },
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
      },
    });
    expect(createdDirs).toContain("/work/docs/v1.0");
    expect(createdFiles).not.toContain("/work/docs/v1.0");
    expect(joinPairs(args, "--bind")).toContain("/work/docs/v1.0 /work/docs/v1.0");
  });

  test("binds ancestor roots before descendant roots (mask ordering)", () => {
    const policy: SandboxPolicy = {
      kind: "workspace-write",
      writableRoots: ["/repo/src", "/repo"], // child listed before parent
      network: true,
    };
    const { args } = buildBwrapCommand(INNER, policy, "/repo/src", {
      program: "bwrap",
      exists: () => true,
    });
    const binds = joinPairs(args, "--bind");
    // The parent /repo must bind BEFORE /repo/src, so a later /repo bind can't
    // shadow /repo/src's metadata masks.
    expect(binds.indexOf("/repo /repo")).toBeGreaterThanOrEqual(0);
    expect(binds.indexOf("/repo /repo")).toBeLessThan(binds.indexOf("/repo/src /repo/src"));
  });

  test("binds ancestor roots before descendants even when unrelated roots separate them", () => {
    const policy: SandboxPolicy = {
      kind: "workspace-write",
      writableRoots: ["/repo/a/b", "/x", "/repo"],
      network: true,
    };
    const { args } = buildBwrapCommand(INNER, policy, "/repo/a/b", {
      program: "bwrap",
      exists: () => true,
    });
    const binds = joinPairs(args, "--bind");
    expect(binds.indexOf("/repo /repo")).toBeLessThan(binds.indexOf("/repo/a/b /repo/a/b"));
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

  test("no-project-write: helper uses read-only mode without writable roots", () => {
    const policy: SandboxPolicy = { kind: "no-project-write", network: true };
    const { args } = buildWindowsSandboxCommand(
      INNER,
      policy,
      "/work",
      "C:/h/cowork-win-sandbox.exe",
    );
    expect(args).toContain("--mode");
    expect(args).toContain("read-only");
    expect(args).not.toContain("no-project-write");
    expect(args).not.toContain("--writable-root");
    expect(args).toContain("--allow-network");
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

  test("danger-full-access with network disabled still wraps when a backend is available", () => {
    const r = mgr.transform({
      ...INNER,
      policy: { kind: "danger-full-access", network: false },
      cwd: "/w",
      platform: "linux",
      capabilities: caps({ bwrapPath: "/usr/bin/bwrap" }),
    });
    expect(r.sandbox).toBe("linux-bwrap");
    expect(r.unsandboxed).toBe(false);
    expect(r.env[SANDBOX_NETWORK_DISABLED_ENV_VAR]).toBe("1");
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

  test("win32 refuses a helper that has not passed every requested enforcement probe", () => {
    const helper = "C:/h/cowork-win-sandbox.exe";
    const r = mgr.transform({
      ...INNER,
      policy: { kind: "workspace-write", writableRoots: ["C:/w"], network: false },
      cwd: "C:/w",
      platform: "win32",
      capabilities: caps({ windowsHelperPath: helper }),
    });
    expect(r.sandbox).toBe("none");
    expect(r.unsandboxed).toBe(true);
    expect(r.warning).toContain("not ready for filesystem, network, process, integrity");
  });

  test("win32 wraps without a degraded warning after all enforcement probes pass", () => {
    const helper = "C:/h/cowork-win-sandbox.exe";
    const enforcement = { filesystem: true, network: true, process: true, integrity: true };
    const r = mgr.transform({
      ...INNER,
      policy: { kind: "workspace-write", writableRoots: ["C:/w"], network: false },
      cwd: "C:/w",
      platform: "win32",
      capabilities: caps({
        windowsHelperPath: helper,
        windowsSandboxHome: "C:/Users/test/.cowork",
        windowsEnforcement: enforcement,
      }),
    });
    expect(r.sandbox).toBe("windows-sandbox");
    expect(r.unsandboxed).toBe(false);
    expect(r.file).toBe(helper);
    expect(r.args[0]).toBe("run");
    expect(r.args).toContain("--sandbox-home");
    expect(r.enforcement).toEqual(enforcement);
    expect(r.warning).toBeUndefined();
  });
});

describe("sandbox detection", () => {
  test("bwrap probe uses a tiny host utility instead of the current runtime executable", () => {
    const probe = findBwrapProbeCommand((p) => p === "/run/current-system/sw/bin/env");
    expect(probe).toBe("/run/current-system/sw/bin/env");
    expect(probe).not.toBe(process.execPath);
  });

  test("blocks a replaced Windows sandbox binary before probe or execution", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-sandbox-integrity-"));
    const helper = path.join(root, "cowork-win-sandbox.exe");
    const setup = path.join(root, "codex-windows-sandbox-setup.exe");
    const runner = path.join(root, "codex-command-runner.exe");
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    try {
      fs.writeFileSync(helper, "replaced");
      fs.writeFileSync(setup, "setup");
      fs.writeFileSync(runner, "runner");
      const result = probeWindowsSandboxBundle(helper, {
        COWORK_WIN_SANDBOX_HELPER_SHA256: digest("trusted-helper"),
        COWORK_WIN_SANDBOX_SETUP: setup,
        COWORK_WIN_SANDBOX_SETUP_SHA256: digest("setup"),
        COWORK_WIN_SANDBOX_COMMAND_RUNNER: runner,
        COWORK_WIN_SANDBOX_COMMAND_RUNNER_SHA256: digest("runner"),
      });
      expect(result.enforcement).toEqual({
        filesystem: false,
        network: false,
        process: false,
        integrity: false,
      });
      expect(result.warning).toContain("SHA-256 mismatch");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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

  test("ignores common non-sandbox permission failures", () => {
    expect(
      isLikelySandboxDenied({
        stdout: "",
        stderr:
          "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
        exitCode: 128,
      }),
    ).toBe(false);
  });

  test("ignores docker/sudo permission errors that are not sandbox denials", () => {
    expect(
      isLikelySandboxDenied({
        stdout: "",
        stderr: "docker: Got permission denied while trying to connect to the Docker daemon socket",
        exitCode: 1,
      }),
    ).toBe(false);
    expect(
      isLikelySandboxDenied({
        stdout: "",
        stderr: "sudo: a terminal is required to read the password",
        exitCode: 1,
      }),
    ).toBe(false);
  });

  test("treats EACCES mkdir/npm write denials as sandbox denials (escalation can fix them)", () => {
    // A sandboxed command blocked from creating a directory outside the workspace
    // reports EACCES mkdir — running it unsandboxed WOULD succeed, so the
    // escalate-on-failure prompt must be offered rather than swallowed.
    expect(
      isLikelySandboxDenied({
        stdout: "",
        stderr: "npm ERR! code EACCES\nnpm ERR! Error: EACCES: permission denied, mkdir '/usr/lib'",
        exitCode: 1,
      }),
    ).toBe(true);
  });
});

describe("classifySandboxDenial", () => {
  test("classifies filesystem denials", () => {
    expect(
      classifySandboxDenial({ stdout: "", stderr: "Operation not permitted", exitCode: 1 }),
    ).toBe("filesystem");
    expect(
      classifySandboxDenial({
        stdout: "",
        stderr: "touch: cannot touch 'x': Read-only file system",
        exitCode: 1,
      }),
    ).toBe("filesystem");
  });

  test("classifies network denials only when network is restricted", () => {
    const out = {
      stdout: "",
      stderr: "curl: (6) Could not resolve host: example.com",
      exitCode: 6,
    };
    expect(classifySandboxDenial(out, { networkRestricted: true })).toBe("network");
    // Without network restriction this is a real network error, not a denial.
    expect(classifySandboxDenial(out)).toBeNull();
  });

  test("returns null for non-denial failures and clean exits", () => {
    expect(classifySandboxDenial({ stdout: "ok", stderr: "", exitCode: 0 })).toBeNull();
    expect(
      classifySandboxDenial({ stdout: "", stderr: "some normal error", exitCode: 2 }),
    ).toBeNull();
    expect(
      classifySandboxDenial({
        stdout: "",
        stderr: "git@github.com: Permission denied (publickey).",
        exitCode: 128,
      }),
    ).toBeNull();
  });

  test("describeSandboxDenial returns safe-to-display copy per category", () => {
    expect(describeSandboxDenial("network")).toContain("network");
    expect(describeSandboxDenial("filesystem")).toContain("workspace");
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
