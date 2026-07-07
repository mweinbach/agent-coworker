import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { classifySandboxDenial, isLikelySandboxDenied } from "../../src/platform/sandbox/denied";
import {
  canonicalizeRoot,
  protectedMetadataPaths,
  type SandboxPolicy,
  scratchRoots,
} from "../../src/platform/sandbox/policy";
import { buildWindowsSandboxCommand, windowsSandboxHome } from "../../src/platform/sandbox/windows";

const INNER = { file: "/bin/bash", args: ["-lc", "echo hi"] };
const HELPER = "C:/h/cowork-win-sandbox.exe";
const SANDBOX_HOME = "C:/Users/test/.cowork";

function writableRootsOf(args: string[]): string[] {
  return args.flatMap((arg, i) => (arg === "--writable-root" ? [args[i + 1]] : []));
}

function modeOf(args: string[]): string {
  return args[args.indexOf("--mode") + 1] as string;
}

describe("scratchRoots", () => {
  test("darwin grants both /tmp spellings (firmlink alias)", () => {
    expect(scratchRoots("darwin")).toEqual(["/tmp", "/private/tmp"]);
  });

  test("linux grants /tmp only", () => {
    expect(scratchRoots("linux")).toEqual(["/tmp"]);
  });

  test("win32 grants the host temp directory", () => {
    expect(scratchRoots("win32")).toEqual([os.tmpdir()]);
  });

  test("other POSIX platforms default to /tmp", () => {
    expect(scratchRoots("freebsd")).toEqual(["/tmp"]);
    expect(scratchRoots("openbsd")).toEqual(["/tmp"]);
  });

  test("defaults to the host platform", () => {
    expect(scratchRoots()).toEqual(scratchRoots(process.platform));
  });
});

describe("protectedMetadataPaths", () => {
  function makeTree(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-protected-meta-"));
    fs.mkdirSync(path.join(root, ".git", "hooks"), { recursive: true });
    fs.mkdirSync(path.join(root, "vendor", "dep", ".cowork"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "main.ts"), "export {};\n");
    return root;
  }

  test("finds direct and nested .git/.cowork paths", () => {
    const root = makeTree();
    try {
      const found = protectedMetadataPaths([root]).sort();
      expect(found).toEqual(
        [path.join(root, ".git"), path.join(root, "vendor", "dep", ".cowork")].sort(),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("deduplicates results across overlapping roots", () => {
    const root = makeTree();
    try {
      const found = protectedMetadataPaths([root, root]);
      expect(found.filter((p) => p === path.join(root, ".git"))).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns empty for missing roots, file roots, and injected exists=false", () => {
    const root = makeTree();
    try {
      expect(protectedMetadataPaths([path.join(root, "nope")])).toEqual([]);
      expect(protectedMetadataPaths([path.join(root, "src", "main.ts")])).toEqual([]);
      expect(protectedMetadataPaths([root], { exists: () => false })).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not follow symlinks/junctions out of the tree", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-protected-link-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-protected-out-"));
    try {
      fs.mkdirSync(path.join(outside, ".git"));
      // Junction on win32 (privilege-free), dir symlink elsewhere.
      fs.symlinkSync(
        outside,
        path.join(root, "escape"),
        process.platform === "win32" ? "junction" : "dir",
      );
      expect(protectedMetadataPaths([root])).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("windowsSandboxHome", () => {
  test("honors COWORK_WIN_SANDBOX_HOME (trimmed, resolved)", () => {
    const target = path.join(os.tmpdir(), "win-sandbox-home");
    expect(windowsSandboxHome({ COWORK_WIN_SANDBOX_HOME: `  ${target}  ` })).toBe(
      path.resolve(target),
    );
  });

  test("whitespace-only override falls back to the cowork home", () => {
    const home = path.join(os.tmpdir(), "cowork-home-a");
    expect(windowsSandboxHome({ COWORK_WIN_SANDBOX_HOME: "   ", COWORK_HOME_OVERRIDE: home })).toBe(
      path.resolve(path.join(home, ".cowork")),
    );
  });

  test("defaults to ~/.cowork via paths.coworkHome (COWORK_HOME_OVERRIDE lever applies)", () => {
    const home = path.join(os.tmpdir(), "cowork-home-b");
    expect(windowsSandboxHome({ COWORK_HOME_OVERRIDE: home })).toBe(
      path.resolve(path.join(home, ".cowork")),
    );
  });
});

describe("windows scratch parity", () => {
  test("no-project-write grants temp scratch as the only writable root", () => {
    const policy: SandboxPolicy = { kind: "no-project-write", network: true };
    const { args } = buildWindowsSandboxCommand(INNER, policy, "C:/work", HELPER, SANDBOX_HOME);
    // Scratch requires the helper's workspace-write mode: its read-only
    // profile ignores --writable-root entirely.
    expect(modeOf(args)).toBe("workspace-write");
    expect(writableRootsOf(args)).toEqual([canonicalizeRoot(os.tmpdir())]);
  });

  test("no-project-write with a temp-resident project falls back to fully read-only", () => {
    // The temp scratch dir is an ancestor of the project, so granting it would
    // hand the whole project tree back as "scratch". The helper must fall back
    // to read-only mode (NOT workspace-write with zero roots, which the helper
    // widens to a writable cwd).
    const project = path.join(os.tmpdir(), "cowork-temp-project");
    const policy: SandboxPolicy = {
      kind: "no-project-write",
      projectRoots: [project],
      network: true,
    };
    const { args } = buildWindowsSandboxCommand(INNER, policy, project, HELPER, SANDBOX_HOME);
    expect(modeOf(args)).toBe("read-only");
    expect(writableRootsOf(args)).toEqual([]);
  });

  test("explicit read-only stays fully immutable (no temp scratch on any platform)", () => {
    const policy: SandboxPolicy = { kind: "read-only", network: true };
    const { args } = buildWindowsSandboxCommand(INNER, policy, "C:/work", HELPER, SANDBOX_HOME);
    expect(modeOf(args)).toBe("read-only");
    expect(writableRootsOf(args)).toEqual([]);
    expect(args).toContain("--allow-network");
  });

  test("workspace-write keeps the policy's writable roots (no implicit extras)", () => {
    const policy: SandboxPolicy = {
      kind: "workspace-write",
      writableRoots: ["C:/work"],
      network: true,
    };
    const { args } = buildWindowsSandboxCommand(INNER, policy, "C:/work", HELPER, SANDBOX_HOME);
    expect(modeOf(args)).toBe("workspace-write");
    expect(writableRootsOf(args)).toEqual([path.resolve("C:/work")]);
  });
});

describe("windows network flag (policyAllowsNetwork inversion fix)", () => {
  test("danger-full-access without explicit network gets --allow-network", () => {
    // Raw `policy.network` is undefined here — the old check dropped the flag
    // and silently network-restricted a full-access policy.
    const policy: SandboxPolicy = { kind: "danger-full-access" };
    const { args } = buildWindowsSandboxCommand(INNER, policy, "C:/work", HELPER, SANDBOX_HOME);
    expect(modeOf(args)).toBe("network-only");
    expect(args).toContain("--allow-network");
  });

  test("danger-full-access with network:false stays restricted", () => {
    const policy: SandboxPolicy = { kind: "danger-full-access", network: false };
    const { args } = buildWindowsSandboxCommand(INNER, policy, "C:/work", HELPER, SANDBOX_HOME);
    expect(modeOf(args)).toBe("network-only");
    expect(args).not.toContain("--allow-network");
  });

  test("restricted kinds follow their explicit network flag", () => {
    const on: SandboxPolicy = { kind: "no-project-write", network: true };
    const off: SandboxPolicy = { kind: "no-project-write", network: false };
    expect(buildWindowsSandboxCommand(INNER, on, "C:/work", HELPER, SANDBOX_HOME).args).toContain(
      "--allow-network",
    );
    expect(
      buildWindowsSandboxCommand(INNER, off, "C:/work", HELPER, SANDBOX_HOME).args,
    ).not.toContain("--allow-network");
  });
});

describe("win32 denial markers", () => {
  const win32 = { platform: "win32" as const };
  const linux = { platform: "linux" as const };

  test(".NET 'Access to the path ... is denied' classifies as filesystem on win32 only", () => {
    const output = {
      stdout: "",
      stderr: "Set-Content : Access to the path 'C:\\Program Files\\x.txt' is denied.",
      exitCode: 1,
    };
    expect(classifySandboxDenial(output, win32)).toBe("filesystem");
    expect(isLikelySandboxDenied(output, win32)).toBe(true);
    // POSIX tables are unchanged: no win32-only marker leaks into them.
    expect(classifySandboxDenial(output, linux)).toBeNull();
  });

  test("plain 'Access is denied' still matches on every platform (base marker)", () => {
    const output = { stdout: "", stderr: "Access is denied.", exitCode: 1 };
    expect(classifySandboxDenial(output, win32)).toBe("filesystem");
    expect(classifySandboxDenial(output, linux)).toBe("filesystem");
  });

  test("WinSock/.NET network phrasings classify as network only when restricted", () => {
    const samples = [
      "curl: (6) getaddrinfo() thread failed to start: No such host is known.",
      "Invoke-WebRequest : The remote name could not be resolved: 'example.com'",
      "socket error WSAHOST_NOT_FOUND",
      "connect failed: WSAECONNREFUSED",
      "No connection could be made because the target machine actively refused it 127.0.0.1:443",
    ];
    for (const stderr of samples) {
      const output = { stdout: "", stderr, exitCode: 1 };
      expect(classifySandboxDenial(output, { ...win32, networkRestricted: true })).toBe("network");
      // Without a network-restricted policy these are real network errors.
      expect(classifySandboxDenial(output, win32)).toBeNull();
      // And they are win32 phrasings: the POSIX table does not gain them.
      expect(classifySandboxDenial(output, { ...linux, networkRestricted: true })).toBeNull();
    }
  });

  test("base POSIX network markers still fire on win32 (shared base table)", () => {
    const output = {
      stdout: "",
      stderr: "curl: (6) Could not resolve host: example.com",
      exitCode: 6,
    };
    expect(classifySandboxDenial(output, { ...win32, networkRestricted: true })).toBe("network");
    expect(classifySandboxDenial(output, { ...linux, networkRestricted: true })).toBe("network");
  });

  test("filesystem markers take precedence over network markers", () => {
    const output = {
      stdout: "",
      stderr: "Access is denied.\nNo such host is known.",
      exitCode: 1,
    };
    expect(classifySandboxDenial(output, { ...win32, networkRestricted: true })).toBe("filesystem");
  });

  test("clean exits and command-not-found never classify, even with win32 markers", () => {
    expect(
      classifySandboxDenial({ stdout: "No such host is known.", stderr: "", exitCode: 0 }, win32),
    ).toBeNull();
    expect(
      classifySandboxDenial(
        { stdout: "", stderr: "Access to the path 'C:\\x' is denied.", exitCode: 127 },
        win32,
      ),
    ).toBeNull();
  });
});
