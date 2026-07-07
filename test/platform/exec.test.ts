import { describe, expect, test } from "bun:test";

import {
  binaryName,
  classifyExecutable,
  executableCandidates,
  resolveSpawn,
  UnsafeShimArgumentError,
  which,
} from "../../src/platform/exec";

const ALL_PLATFORMS: NodeJS.Platform[] = ["win32", "darwin", "linux"];
const POSIX_PLATFORMS: NodeJS.Platform[] = ["darwin", "linux"];

function existsFor(paths: string[]): { exists: (p: string) => boolean; calls: string[] } {
  const set = new Set(paths);
  const calls: string[] = [];
  return {
    exists: (p: string): boolean => {
      calls.push(p);
      return set.has(p);
    },
    calls,
  };
}

describe("executableCandidates", () => {
  for (const platform of POSIX_PLATFORMS) {
    test(`${platform}: returns [name] with no extension probing`, () => {
      expect(executableCandidates("git", { platform })).toEqual(["git"]);
      expect(executableCandidates("tool.cmd", { platform })).toEqual(["tool.cmd"]);
    });

    test(`${platform}: ignores PATHEXT entirely`, () => {
      const env = { PATHEXT: ".EXE;.CMD" };
      expect(executableCandidates("tool", { env, platform })).toEqual(["tool"]);
    });
  }

  test("win32: bare name first, then default PATHEXT order lowercased", () => {
    expect(executableCandidates("tool", { env: {}, platform: "win32" })).toEqual([
      "tool",
      "tool.com",
      "tool.exe",
      "tool.bat",
      "tool.cmd",
    ]);
  });

  test("win32: custom PATHEXT respected, entries trimmed and lowercased, blanks dropped", () => {
    const env = { PATHEXT: " .EXE ; ; .PS1 " };
    expect(executableCandidates("tool", { env, platform: "win32" })).toEqual([
      "tool",
      "tool.exe",
      "tool.ps1",
    ]);
  });

  test("win32: PATHEXT env key is case-insensitive", () => {
    const env = { PathExt: ".EXE" };
    expect(executableCandidates("tool", { env, platform: "win32" })).toEqual(["tool", "tool.exe"]);
  });

  test("win32: duplicate extensions dedupe case-insensitively", () => {
    const env = { PATHEXT: ".EXE;.exe;.CMD" };
    expect(executableCandidates("tool", { env, platform: "win32" })).toEqual([
      "tool",
      "tool.exe",
      "tool.cmd",
    ]);
  });

  test("win32: entries without a leading dot get one", () => {
    const env = { PATHEXT: "EXE;CMD" };
    expect(executableCandidates("tool", { env, platform: "win32" })).toEqual([
      "tool",
      "tool.exe",
      "tool.cmd",
    ]);
  });

  test("win32: empty or blank PATHEXT falls back to the default list", () => {
    for (const value of ["", "  "]) {
      expect(executableCandidates("tool", { env: { PATHEXT: value }, platform: "win32" })).toEqual([
        "tool",
        "tool.com",
        "tool.exe",
        "tool.bat",
        "tool.cmd",
      ]);
    }
  });

  test("win32: a name that already has an extension is still probed, bare form first", () => {
    const candidates = executableCandidates("codex.cmd", { env: {}, platform: "win32" });
    expect(candidates[0]).toBe("codex.cmd");
    expect(candidates).toContain("codex.cmd.exe");
  });
});

describe("which — POSIX", () => {
  for (const platform of POSIX_PLATFORMS) {
    test(`${platform}: finds the first match in PATH order`, () => {
      const { exists } = existsFor(["/usr/local/bin/git", "/usr/bin/git"]);
      const env = { PATH: "/opt/bin:/usr/local/bin:/usr/bin" };
      expect(which("git", { env, platform, exists })).toBe("/usr/local/bin/git");
    });

    test(`${platform}: returns null when nothing on PATH exists`, () => {
      const { exists } = existsFor([]);
      expect(which("git", { env: { PATH: "/usr/bin:/bin" }, platform, exists })).toBeNull();
    });

    test(`${platform}: splits PATH on ':' only and never probes extensions`, () => {
      const { exists, calls } = existsFor([]);
      which("tool", { env: { PATH: "/a:/b" }, platform, exists });
      expect(calls).toEqual(["/a/tool", "/b/tool"]);
    });

    test(`${platform}: unset or empty PATH yields null`, () => {
      const { exists } = existsFor(["/usr/bin/git"]);
      expect(which("git", { env: {}, platform, exists })).toBeNull();
      expect(which("git", { env: { PATH: "" }, platform, exists })).toBeNull();
    });

    test(`${platform}: absolute candidate passthrough — existence-checked, no PATH scan`, () => {
      const found = existsFor(["/opt/tool"]);
      expect(
        which("/opt/tool", { env: { PATH: "/usr/bin" }, platform, exists: found.exists }),
      ).toBe("/opt/tool");
      expect(found.calls).toEqual(["/opt/tool"]);

      const missing = existsFor([]);
      expect(
        which("/opt/tool", { env: { PATH: "/usr/bin" }, platform, exists: missing.exists }),
      ).toBeNull();
      expect(missing.calls).toEqual(["/opt/tool"]);
    });

    test(`${platform}: relative candidate with separator resolves against cwd`, () => {
      const { exists } = existsFor(["/proj/bin/tool"]);
      expect(which("./bin/tool", { cwd: "/proj", env: {}, platform, exists })).toBe(
        "/proj/bin/tool",
      );
    });

    test(`${platform}: relative candidate with separator and no cwd is checked as-is`, () => {
      const { exists, calls } = existsFor(["bin/tool"]);
      expect(which("bin/tool", { env: { PATH: "/usr/bin" }, platform, exists })).toBe("bin/tool");
      expect(calls).toEqual(["bin/tool"]);
    });

    test(`${platform}: skipDirs comparison is exact and case-sensitive`, () => {
      const { exists } = existsFor(["/a/b/tool"]);
      expect(which("tool", { env: { PATH: "/a/b" }, platform, exists, skipDirs: ["/A/B"] })).toBe(
        "/a/b/tool",
      );
      expect(
        which("tool", { env: { PATH: "/a/b" }, platform, exists, skipDirs: ["/a/b"] }),
      ).toBeNull();
    });
  }

  for (const platform of ALL_PLATFORMS) {
    test(`${platform}: empty name yields null`, () => {
      const { exists } = existsFor([]);
      expect(which("", { env: { PATH: "/usr/bin" }, platform, exists })).toBeNull();
    });
  }
});

describe("which — win32", () => {
  test("splits PATH on ';' and probes PATHEXT candidates per directory", () => {
    const { exists } = existsFor(["C:\\tools\\tool.exe"]);
    const env = { PATH: "C:\\bin;C:\\tools" };
    expect(which("tool", { env, platform: "win32", exists })).toBe("C:\\tools\\tool.exe");
  });

  test("directory order wins over extension order (dir-major search)", () => {
    const { exists } = existsFor(["C:\\first\\tool.cmd", "C:\\second\\tool.exe"]);
    const env = { PATH: "C:\\first;C:\\second" };
    expect(which("tool", { env, platform: "win32", exists })).toBe("C:\\first\\tool.cmd");
  });

  test("within one directory, PATHEXT order decides (.exe before .cmd by default)", () => {
    const { exists } = existsFor(["C:\\bin\\tool.exe", "C:\\bin\\tool.cmd"]);
    const env = { PATH: "C:\\bin" };
    expect(which("tool", { env, platform: "win32", exists })).toBe("C:\\bin\\tool.exe");
  });

  test("bare-name candidate is probed before extension candidates", () => {
    const { exists, calls } = existsFor(["C:\\bin\\tool"]);
    const env = { PATH: "C:\\bin" };
    expect(which("tool", { env, platform: "win32", exists })).toBe("C:\\bin\\tool");
    expect(calls).toEqual(["C:\\bin\\tool"]);
  });

  test("PATH env key lookup is case-insensitive (inherited 'Path' spelling)", () => {
    const { exists } = existsFor(["C:\\bin\\tool.exe"]);
    expect(which("tool", { env: { Path: "C:\\bin" }, platform: "win32", exists })).toBe(
      "C:\\bin\\tool.exe",
    );
  });

  test("quote-aware PATH split: a quoted entry containing ';' stays one directory", () => {
    const { exists } = existsFor(["C:\\weird;dir\\tool.exe"]);
    const env = { PATH: '"C:\\weird;dir";C:\\plain' };
    expect(which("tool", { env, platform: "win32", exists })).toBe("C:\\weird;dir\\tool.exe");
  });

  test("absolute candidate without extension is probed with PATHEXT", () => {
    const { exists } = existsFor(["C:\\tools\\codex.cmd"]);
    expect(which("C:\\tools\\codex", { env: {}, platform: "win32", exists })).toBe(
      "C:\\tools\\codex.cmd",
    );
  });

  test("absolute candidate passthrough returns null when nothing exists, without PATH scan", () => {
    const { exists, calls } = existsFor([]);
    const env = { PATH: "C:\\bin", PATHEXT: ".EXE" };
    expect(which("C:\\tools\\codex", { env, platform: "win32", exists })).toBeNull();
    expect(calls).toEqual(["C:\\tools\\codex", "C:\\tools\\codex.exe"]);
  });

  test("relative candidate with separator resolves against cwd with PATHEXT probing", () => {
    const { exists } = existsFor(["C:\\proj\\bin\\tool.cmd"]);
    expect(which("bin\\tool", { cwd: "C:\\proj", env: {}, platform: "win32", exists })).toBe(
      "C:\\proj\\bin\\tool.cmd",
    );
  });

  test("skipDirs excludes a PATH directory (the node_modules/.bin rule)", () => {
    const { exists } = existsFor(["C:\\proj\\node_modules\\.bin\\rg.cmd", "C:\\bin\\rg.exe"]);
    const env = { PATH: "C:\\proj\\node_modules\\.bin;C:\\bin" };
    expect(
      which("rg", {
        env,
        platform: "win32",
        exists,
        skipDirs: ["C:\\proj\\node_modules\\.bin"],
      }),
    ).toBe("C:\\bin\\rg.exe");
  });

  test("skipDirs comparison is case-folded and separator/trailing-slash normalized", () => {
    const { exists } = existsFor(["C:\\Proj\\NODE_MODULES\\.bin\\rg.cmd"]);
    const env = { PATH: "C:\\Proj\\NODE_MODULES\\.bin" };
    expect(
      which("rg", {
        env,
        platform: "win32",
        exists,
        skipDirs: ["c:/proj/node_modules/.bin/"],
      }),
    ).toBeNull();
  });
});

describe("classifyExecutable", () => {
  test("win32: .cmd and .bat (any case) are batch shims", () => {
    expect(classifyExecutable("C:\\bin\\tool.cmd", "win32")).toBe("batch-shim");
    expect(classifyExecutable("C:\\bin\\TOOL.CMD", "win32")).toBe("batch-shim");
    expect(classifyExecutable("C:\\bin\\tool.bat", "win32")).toBe("batch-shim");
    expect(classifyExecutable("tool.BAT", "win32")).toBe("batch-shim");
  });

  test("win32: .ps1 (any case) is a powershell script", () => {
    expect(classifyExecutable("C:\\s\\run.ps1", "win32")).toBe("powershell-script");
    expect(classifyExecutable("RUN.PS1", "win32")).toBe("powershell-script");
  });

  test("win32: .exe, .com, and extensionless are native", () => {
    expect(classifyExecutable("C:\\bin\\tool.exe", "win32")).toBe("native");
    expect(classifyExecutable("C:\\bin\\tool.com", "win32")).toBe("native");
    expect(classifyExecutable("C:\\bin\\tool", "win32")).toBe("native");
  });

  for (const platform of POSIX_PLATFORMS) {
    test(`${platform}: everything is native, even Windows-looking extensions`, () => {
      for (const p of ["/bin/tool", "/bin/tool.cmd", "/bin/tool.bat", "/bin/run.ps1"]) {
        expect(classifyExecutable(p, platform)).toBe("native");
      }
    });
  }

  test("default platform parameter yields a valid kind", () => {
    expect(["native", "batch-shim", "powershell-script", "script"]).toContain(
      classifyExecutable("tool.cmd"),
    );
  });
});

describe("binaryName", () => {
  test("win32: appends .exe to a bare base name", () => {
    expect(binaryName("rg", "win32")).toBe("rg.exe");
  });

  test("win32: idempotent when .exe already present, any case, spelling kept", () => {
    expect(binaryName("rg.exe", "win32")).toBe("rg.exe");
    expect(binaryName("RG.EXE", "win32")).toBe("RG.EXE");
  });

  for (const platform of POSIX_PLATFORMS) {
    test(`${platform}: returns the base name unchanged`, () => {
      expect(binaryName("rg", platform)).toBe("rg");
      expect(binaryName("rg.exe", platform)).toBe("rg.exe");
    });
  }
});

describe("resolveSpawn — POSIX identity", () => {
  for (const platform of POSIX_PLATFORMS) {
    test(`${platform}: passes file and args through untouched as native`, () => {
      const args = ["commit", "-m", 'msg with "quotes" and %CD% and \\'];
      const plan = resolveSpawn("git", args, { platform });
      expect(plan).toEqual({ file: "git", args, kind: "native" });
      expect(plan.windowsVerbatimArguments).toBeUndefined();
    });

    test(`${platform}: identity even for a .cmd-suffixed path`, () => {
      const plan = resolveSpawn("./tool.cmd", ["a"], { platform });
      expect(plan).toEqual({ file: "./tool.cmd", args: ["a"], kind: "native" });
    });

    test(`${platform}: returned args are a fresh copy`, () => {
      const args = ["a"];
      const plan = resolveSpawn("git", args, { platform });
      expect(plan.args).not.toBe(args);
      expect(plan.args).toEqual(args);
    });
  }
});

describe("resolveSpawn — win32 pass-through", () => {
  test("native .exe passes through untouched", () => {
    const { exists } = existsFor(["C:\\apps\\node.exe"]);
    const plan = resolveSpawn("C:\\apps\\node.exe", ["-v"], { platform: "win32", exists });
    expect(plan).toEqual({ file: "C:\\apps\\node.exe", args: ["-v"], kind: "native" });
    expect(plan.windowsVerbatimArguments).toBeUndefined();
  });

  test(".ps1 passes through untouched as powershell-script", () => {
    const { exists } = existsFor(["C:\\s\\run.ps1"]);
    const plan = resolveSpawn("C:\\s\\run.ps1", ["-Flag"], { platform: "win32", exists });
    expect(plan).toEqual({
      file: "C:\\s\\run.ps1",
      args: ["-Flag"],
      kind: "powershell-script",
    });
  });

  test("unresolvable bare name without shim extension passes through as native", () => {
    const { exists } = existsFor([]);
    const plan = resolveSpawn("nonexistent", ["x"], {
      env: { PATH: "" },
      platform: "win32",
      exists,
    });
    expect(plan).toEqual({ file: "nonexistent", args: ["x"], kind: "native" });
  });

  test("bare name resolving to a native .exe keeps the original name untouched", () => {
    const { exists } = existsFor(["C:\\bin\\node.exe"]);
    const env = { PATH: "C:\\bin" };
    const plan = resolveSpawn("node", ["-v"], { env, platform: "win32", exists });
    expect(plan).toEqual({ file: "node", args: ["-v"], kind: "native" });
  });
});

describe("resolveSpawn — win32 batch-shim wrapping", () => {
  test("absolute .cmd is wrapped as cmd.exe /d /s /v:off /c with a quoted payload", () => {
    const { exists } = existsFor(["C:\\shims\\tool.cmd"]);
    const plan = resolveSpawn("C:\\shims\\tool.cmd", ["a b"], {
      env: { PATH: "" },
      platform: "win32",
      exists,
    });
    expect(plan.file).toBe("cmd.exe");
    expect(plan.kind).toBe("batch-shim");
    expect(plan.windowsVerbatimArguments).toBe(true);
    expect(plan.args).toEqual(["/d", "/s", "/v:off", "/c", `""C:\\shims\\tool.cmd" "a b""`]);
  });

  test("COMSPEC is honored, including a case-variant key spelling", () => {
    const { exists } = existsFor(["C:\\shims\\tool.cmd"]);
    const env = { ComSpec: "C:\\WINDOWS\\system32\\cmd.exe", PATH: "" };
    const plan = resolveSpawn("C:\\shims\\tool.cmd", [], { env, platform: "win32", exists });
    expect(plan.file).toBe("C:\\WINDOWS\\system32\\cmd.exe");
  });

  test("no-argument shim payload is just the quoted script inside the /s wrapper", () => {
    const { exists } = existsFor(["C:\\shims\\tool.cmd"]);
    const plan = resolveSpawn("C:\\shims\\tool.cmd", [], {
      env: { PATH: "" },
      platform: "win32",
      exists,
    });
    expect(plan.args[4]).toBe(`""C:\\shims\\tool.cmd""`);
  });

  test("bare name resolves via which (PATH + PATHEXT) to the shim before wrapping", () => {
    const { exists } = existsFor(["C:\\bin\\codex.cmd"]);
    const env = { PATH: "C:\\bin" };
    const plan = resolveSpawn("codex", ["--version"], { env, platform: "win32", exists });
    expect(plan.file).toBe("cmd.exe");
    expect(plan.args[4]).toBe(`""C:\\bin\\codex.cmd" "--version""`);
  });

  test("skipDirs is threaded through resolution (node_modules/.bin shim skipped)", () => {
    const { exists } = existsFor(["C:\\p\\node_modules\\.bin\\rg.cmd", "C:\\bin\\rg.exe"]);
    const env = { PATH: "C:\\p\\node_modules\\.bin;C:\\bin" };
    const plan = resolveSpawn("rg", ["-n"], {
      env,
      platform: "win32",
      exists,
      skipDirs: ["C:\\p\\node_modules\\.bin"],
    });
    expect(plan).toEqual({ file: "rg", args: ["-n"], kind: "native" });
  });

  test("unresolvable name with .cmd extension still wraps using the given name", () => {
    const { exists } = existsFor([]);
    const plan = resolveSpawn("tool.cmd", ["a"], { env: { PATH: "" }, platform: "win32", exists });
    expect(plan.file).toBe("cmd.exe");
    expect(plan.kind).toBe("batch-shim");
    expect(plan.args[4]).toBe(`""tool.cmd" "a""`);
  });

  test("BatBadBut quoting table: safe arguments", () => {
    const shim = "C:\\s\\t.cmd";
    const { exists } = existsFor([shim]);
    const run = (args: string[]): string =>
      resolveSpawn(shim, args, { env: { PATH: "" }, platform: "win32", exists }).args[4] ?? "";
    // Plain, spaced, and empty args are always quoted.
    expect(run(["plain"])).toBe(`""${shim}" "plain""`);
    expect(run(["has space"])).toBe(`""${shim}" "has space""`);
    expect(run([""])).toBe(`""${shim}" """`);
    // cmd metacharacters are literal inside quotes — no escaping, no throw.
    expect(run(["a&b|c<d>e^f"])).toBe(`""${shim}" "a&b|c<d>e^f""`);
    // A lone % cannot form an expansion.
    expect(run(["50%"])).toBe(`""${shim}" "50%""`);
    // ! is pinned literal by /v:off.
    expect(run(["hello!"])).toBe(`""${shim}" "hello!""`);
    // Multiple args each quoted, space-joined.
    expect(run(["a", "b c"])).toBe(`""${shim}" "a" "b c""`);
  });

  test("trailing backslashes are doubled so the closing quote survives", () => {
    const shim = "C:\\s\\t.cmd";
    const { exists } = existsFor([shim]);
    const run = (args: string[]): string =>
      resolveSpawn(shim, args, { env: { PATH: "" }, platform: "win32", exists }).args[4] ?? "";
    expect(run(["C:\\dir\\"])).toBe(`""${shim}" "C:\\dir\\\\""`);
    expect(run(["a\\\\"])).toBe(`""${shim}" "a\\\\\\\\""`);
    // Internal backslashes are untouched.
    expect(run(["C:\\a\\b"])).toBe(`""${shim}" "C:\\a\\b""`);
  });

  test("BatBadBut quoting table: unsafe arguments throw typed UnsafeShimArgumentError", () => {
    const shim = "C:\\s\\t.cmd";
    const { exists } = existsFor([shim]);
    const run = (arg: string): void => {
      resolveSpawn(shim, [arg], { env: { PATH: "" }, platform: "win32", exists });
    };
    for (const unsafe of ['has "quote"', "%CD%", "%%", "a%b%c", "line\nbreak", "line\rbreak"]) {
      let caught: unknown;
      try {
        run(unsafe);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(UnsafeShimArgumentError);
      const typed = caught as UnsafeShimArgumentError;
      expect(typed.name).toBe("UnsafeShimArgumentError");
      expect(typed.argument).toBe(unsafe);
      expect(typed.message).toContain(JSON.stringify(unsafe));
    }
  });

  test("a hazardous shim path itself throws instead of being mangled", () => {
    const shim = "C:\\%FAKE%\\t.cmd";
    const { exists } = existsFor([shim]);
    expect(() => resolveSpawn(shim, [], { env: { PATH: "" }, platform: "win32", exists })).toThrow(
      UnsafeShimArgumentError,
    );
  });

  test("original args array is never mutated by wrapping", () => {
    const shim = "C:\\s\\t.cmd";
    const { exists } = existsFor([shim]);
    const args = ["a b", "c\\"];
    resolveSpawn(shim, args, { env: { PATH: "" }, platform: "win32", exists });
    expect(args).toEqual(["a b", "c\\"]);
  });
});
