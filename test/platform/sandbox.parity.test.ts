import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildBwrapCommand } from "../../src/platform/sandbox/bwrap";
import { classifySandboxDenial, isLikelySandboxDenied } from "../../src/platform/sandbox/denied";
import {
  SANDBOX_ENV_VAR,
  SANDBOX_NETWORK_DISABLED_ENV_VAR,
  SandboxManager,
} from "../../src/platform/sandbox/index";
import {
  canonicalizeRoot,
  protectedMetadataPaths,
  type SandboxPolicy,
  scratchRoots,
} from "../../src/platform/sandbox/policy";
import { buildSeatbeltCommand } from "../../src/platform/sandbox/seatbelt";
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
    return canonicalizeRoot(root);
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

  test.each(["darwin", "win32", "linux"] as const)(
    "%s applies the platform's metadata-name case policy",
    (platform) => {
      const root = makeTree();
      try {
        const upperGit = path.join(root, "nested", ".GIT");
        const mixedCowork = path.join(root, "other", ".CoWoRk");
        fs.mkdirSync(upperGit, { recursive: true });
        fs.mkdirSync(path.dirname(mixedCowork), { recursive: true });
        fs.writeFileSync(mixedCowork, "metadata file");
        const expected = [path.join(root, ".git"), path.join(root, "vendor", "dep", ".cowork")];
        if (platform !== "linux") expected.push(upperGit, mixedCowork);
        expect(protectedMetadataPaths([root], { platform }).sort()).toEqual(expected.sort());
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test("reads each directory once across unsorted overlapping and duplicate roots", () => {
    const root = makeTree();
    const readdir = spyOn(fs, "readdirSync");
    try {
      const vendor = path.join(root, "vendor");
      const dep = path.join(vendor, "dep");
      const found = protectedMetadataPaths([dep, root, vendor, root]);
      expect(readdir.mock.calls.map(([directory]) => String(directory)).sort()).toEqual(
        [root, path.join(root, "src"), vendor, dep].sort(),
      );
      expect(found.sort()).toEqual([path.join(root, ".git"), path.join(dep, ".cowork")].sort());
    } finally {
      readdir.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("retries an overlapping root when its earlier directory read failed", () => {
    const root = makeTree();
    const readdir = spyOn(fs, "readdirSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("directory temporarily unavailable"), { code: "EIO" });
    });
    try {
      expect(protectedMetadataPaths([root, root]).sort()).toEqual(
        [path.join(root, ".git"), path.join(root, "vendor", "dep", ".cowork")].sort(),
      );
    } finally {
      readdir.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function backendProtectedPaths(
    backend: "bwrap" | "seatbelt",
    root: string,
    writableRoots: string[],
  ): string[] {
    const policy: SandboxPolicy = { kind: "workspace-write", writableRoots, network: false };
    const { args } =
      backend === "bwrap"
        ? buildBwrapCommand(INNER, policy, root)
        : buildSeatbeltCommand(INNER, policy);
    if (backend === "bwrap") {
      return args.flatMap((arg, index) =>
        arg === "--ro-bind" ? args.slice(index + 1, index + 2) : [],
      );
    }
    return args
      .filter((arg) => arg.startsWith("-DWRITABLE_EXCLUDED_"))
      .map((arg) => arg.slice(arg.indexOf("=") + 1));
  }

  test.each(["bwrap", "seatbelt"] as const)(
    "%s uses its own platform's metadata-name case policy",
    (backend) => {
      const root = makeTree();
      try {
        const upperGit = path.join(root, "nested", ".GIT");
        fs.mkdirSync(upperGit, { recursive: true });
        const protectedPaths = backendProtectedPaths(backend, root, [root]);
        if (backend === "seatbelt") expect(protectedPaths).toContain(upperGit);
        else expect(protectedPaths).not.toContain(upperGit);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test.each(["bwrap", "seatbelt"] as const)(
    "%s scans overlapping roots once while preserving every root's metadata exclusions",
    (backend) => {
      const root = makeTree();
      const vendor = path.join(root, "vendor");
      const dep = path.join(vendor, "dep");
      const gitFile = path.join(dep, ".git");
      fs.writeFileSync(gitFile, "gitdir: ../../.git/modules/dep\n");
      const readdir = spyOn(fs, "readdirSync");
      try {
        const protectedPaths = backendProtectedPaths(backend, root, [dep, root, vendor, root]);
        expect(readdir.mock.calls.map(([directory]) => String(directory)).sort()).toEqual(
          [root, path.join(root, "src"), vendor, dep].sort(),
        );
        // Every ancestor/descendant root needs its own carve-out. In bwrap a
        // descendant's writable bind would otherwise shadow an earlier mask.
        expect(protectedPaths.filter((p) => p === gitFile)).toHaveLength(3);
        expect(protectedPaths.filter((p) => p === path.join(dep, ".cowork"))).toHaveLength(3);
      } finally {
        readdir.mockRestore();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test.each(["bwrap", "seatbelt"] as const)(
    "%s discovers metadata created between command transformations",
    (backend) => {
      const root = makeTree();
      try {
        const source = path.join(root, "src");
        const nested = path.join(source, "module");
        fs.mkdirSync(nested);
        const roots = [root, source];
        const gitFile = path.join(nested, ".git");
        const coworkDir = path.join(nested, ".cowork");
        const before = backendProtectedPaths(backend, root, roots);
        expect(before).not.toContain(gitFile);
        expect(before).not.toContain(coworkDir);

        fs.writeFileSync(gitFile, "gitdir: ../../.git/modules/module\n");
        fs.mkdirSync(coworkDir);

        const after = backendProtectedPaths(backend, root, roots);
        expect(after.filter((p) => p === gitFile)).toHaveLength(2);
        expect(after.filter((p) => p === coworkDir)).toHaveLength(2);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

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

describe("sandbox network policy matrix", () => {
  const policies: Array<{ name: string; policy: SandboxPolicy; networkAllowed: boolean }> = [
    { name: "full access default", policy: { kind: "danger-full-access" }, networkAllowed: true },
    ...[true, false].flatMap((networkAllowed) => [
      {
        name: `full access network=${networkAllowed}`,
        policy: { kind: "danger-full-access" as const, network: networkAllowed },
        networkAllowed,
      },
      {
        name: `read-only network=${networkAllowed}`,
        policy: { kind: "read-only" as const, network: networkAllowed },
        networkAllowed,
      },
      {
        name: `no-project-write network=${networkAllowed}`,
        policy: { kind: "no-project-write" as const, network: networkAllowed },
        networkAllowed,
      },
      {
        name: `workspace-write network=${networkAllowed}`,
        policy: { kind: "workspace-write" as const, writableRoots: [], network: networkAllowed },
        networkAllowed,
      },
    ]),
  ];
  const platforms = [
    { platform: "darwin", backend: "macos-seatbelt" },
    { platform: "linux", backend: "linux-bwrap" },
    { platform: "win32", backend: "windows-sandbox" },
  ] as const;

  test.each(
    platforms.flatMap((platform) => policies.map((policy) => ({ ...platform, ...policy }))),
  )(
    "$platform preserves $name in the wrapper and manager",
    ({ platform, backend, policy, networkAllowed }) => {
      const cwd = path.resolve(os.tmpdir(), "cowork-network-matrix");
      const wrapped =
        platform === "darwin"
          ? buildSeatbeltCommand(INNER, policy)
          : platform === "linux"
            ? buildBwrapCommand(INNER, policy, cwd, { program: "/usr/bin/bwrap" })
            : buildWindowsSandboxCommand(INNER, policy, cwd, HELPER, SANDBOX_HOME);
      if (platform === "darwin") {
        expect(wrapped.args[1]?.includes("(allow network-outbound)")).toBe(networkAllowed);
      } else if (platform === "linux") {
        expect(wrapped.args.includes("--unshare-net")).toBe(!networkAllowed);
      } else {
        expect(wrapped.args.includes("--allow-network")).toBe(networkAllowed);
      }
      const transformed = new SandboxManager().transform({
        ...INNER,
        policy,
        cwd,
        platform,
        capabilities: {
          seatbelt: true,
          bwrapPath: "/usr/bin/bwrap",
          windowsHelperPath: HELPER,
          windowsSandboxHome: SANDBOX_HOME,
          windowsSetupRequired: false,
          windowsEnforcement: { filesystem: true, network: true, process: true, integrity: true },
        },
      });
      const bypass = policy.kind === "danger-full-access" && networkAllowed;
      expect(transformed.sandbox).toBe(bypass ? "none" : backend);
      expect(transformed.unsandboxed).toBe(bypass);
      expect(transformed.warning).toBeUndefined();
      expect({ file: transformed.file, args: transformed.args }).toEqual(bypass ? INNER : wrapped);
      expect(transformed.env).toEqual(
        bypass
          ? {}
          : {
              [SANDBOX_ENV_VAR]: backend,
              ...(!networkAllowed ? { [SANDBOX_NETWORK_DISABLED_ENV_VAR]: "1" } : {}),
            },
      );
    },
  );

  test.each([undefined, true])("full access network=%s bypasses capability access", (network) => {
    const transformed = new SandboxManager().transform({
      ...INNER,
      policy: { kind: "danger-full-access", network },
      cwd: path.resolve(os.tmpdir()),
      platform: "win32",
      get capabilities() {
        throw new Error("Full access must not inspect sandbox capabilities");
      },
    });
    expect(transformed.sandbox).toBe("none");
    expect(transformed.env).toEqual({});
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
