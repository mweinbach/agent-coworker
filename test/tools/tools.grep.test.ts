import { binaryName } from "../../src/platform/exec";
import { hostPlatform } from "../../src/platform/host";
import { ensureRipgrep } from "../../src/utils/ripgrep";
import {
  afterEach,
  bashInternal,
  beforeEach,
  createAskTool,
  createBashTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createMemoryTool,
  createReadTool,
  createSkillTool,
  createTodoWriteTool,
  createTools,
  createWebFetchTool,
  createWebSearchTool,
  createWriteTool,
  describe,
  expect,
  fs,
  getAiCoworkerPaths,
  listSessionToolNames,
  makeConfig,
  makeCtx,
  mock,
  os,
  path,
  test,
  tmpDir,
  webFetchInternal,
  webSafetyInternal,
  withAuthHome,
  withEnv,
  writeConnectionStore,
  z,
} from "./tools.harness";

describe("grep tool", () => {
  const fakeEnsureRipgrep: any = async () => "rg";

  function globToRegExp(glob: string): RegExp {
    // Minimal glob support for tests (enough for patterns like "*.ts").
    const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const re = "^" + escaped.replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
    return new RegExp(re);
  }

  const fakeExecFile: any = async (_cmd: string, args: string[], _opts: any) => {
    try {
      {
        let caseInsensitive = false;
        let contextLines = 0;
        const includeGlobs: string[] = [];
        const excludeGlobs: string[] = [];

        const rest = [...args];
        while (rest.length > 0) {
          const a = rest[0];
          if (a === "--line-number") {
            rest.shift();
            continue;
          }
          if (a === "-i") {
            rest.shift();
            caseInsensitive = true;
            continue;
          }
          if (a === "-C") {
            rest.shift();
            const v = rest.shift();
            contextLines = v ? Number(v) : 0;
            continue;
          }
          if (a === "--glob") {
            rest.shift();
            const glob = rest.shift();
            if (glob?.startsWith("!")) excludeGlobs.push(glob.slice(1));
            else if (glob) includeGlobs.push(glob);
            continue;
          }
          if (a === "--") {
            rest.shift();
            break;
          }
          break;
        }

        const pattern = rest.shift();
        const searchPath = rest.shift();
        if (!pattern || !searchPath) throw new Error("fake rg: missing pattern or searchPath");

        const re = new RegExp(pattern, caseInsensitive ? "i" : "");
        const includeRes = includeGlobs.map(globToRegExp);
        const excludeRes = excludeGlobs.map(globToRegExp);

        const files: string[] = [];
        const walk = async (p: string) => {
          const st = await fs.stat(p);
          if (st.isFile()) {
            const relative = path.relative(searchPath, p).replace(/\\/g, "/");
            const basename = path.basename(p);
            const included =
              includeRes.length === 0 ||
              includeRes.some((globRe) => globRe.test(basename) || globRe.test(relative));
            const excluded = excludeRes.some(
              (globRe) => globRe.test(basename) || globRe.test(relative),
            );
            if (included && !excluded) files.push(p);
            return;
          }
          if (!st.isDirectory()) return;
          const entries = await fs.readdir(p, { withFileTypes: true });
          for (const e of entries) {
            if (e.isSymbolicLink()) continue;
            await walk(path.join(p, e.name));
          }
        };

        await walk(searchPath);

        const outLines: string[] = [];
        for (const filePath of files) {
          const raw = await fs.readFile(filePath, "utf-8");
          const lines = raw.split("\n");

          const addLine = (idx: number) => {
            if (idx < 0 || idx >= lines.length) return;
            const lineNo = idx + 1;
            outLines.push(`${filePath}:${lineNo}:${lines[idx]}`);
          };

          for (let i = 0; i < lines.length; i++) {
            if (!re.test(lines[i] ?? "")) continue;
            for (let j = i - contextLines; j <= i + contextLines; j++) addLine(j);
          }
        }

        if (outLines.length === 0) {
          return { stdout: "", stderr: "", exitCode: 1 };
        }

        return { stdout: outLines.join("\n") + "\n", stderr: "", exitCode: 0 };
      }
    } catch (err) {
      return { stdout: "", stderr: String(err), exitCode: 2 };
    }
  };

  test("returns matches for pattern", async () => {
    const dir = await tmpDir();
    await fs.writeFile(
      path.join(dir, "haystack.txt"),
      "needle in the haystack\nno match here\nneedle again\n",
      "utf-8",
    );

    const t: any = createGrepTool(makeCtx(dir), {
      execFileImpl: fakeExecFile,
      ensureRipgrepImpl: fakeEnsureRipgrep,
    });
    const res: string = await t.execute({
      pattern: "needle",
      path: dir,
      caseSensitive: true,
    });
    expect(res).toContain("needle");
    expect(res).toContain("haystack.txt");
  });

  test("does not auto-download ripgrep for no-write roles", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "haystack.txt"), "needle\n", "utf-8");
    const calls: unknown[] = [];
    const t: any = createGrepTool(makeCtx(dir, { shellPolicy: "no_project_write" }), {
      execFileImpl: fakeExecFile,
      ensureRipgrepImpl: async (opts: unknown) => {
        calls.push(opts);
        return "rg";
      },
    });

    const res: string = await t.execute({
      pattern: "needle",
      path: dir,
      caseSensitive: true,
    });

    expect(res).toContain("needle");
    expect(calls).toEqual([expect.objectContaining({ disableDownload: true })]);
  });

  test("rejects grep path outside allowed directories", async () => {
    const dir = await tmpDir();
    const outsideDir = await tmpDir();
    await fs.writeFile(path.join(outsideDir, "file.txt"), "secret\n", "utf-8");

    const t: any = createGrepTool(makeCtx(dir), {
      execFileImpl: fakeExecFile,
      ensureRipgrepImpl: fakeEnsureRipgrep,
    });
    await expect(
      t.execute({
        pattern: "secret",
        path: outsideDir,
        caseSensitive: true,
      }),
    ).rejects.toThrow(/blocked/i);
  });

  test("enforces child agent targetPaths for grep path", async () => {
    const dir = await tmpDir();
    const allowedDir = path.join(dir, "src", "foo");
    const blockedDir = path.join(dir, "src", "bar");
    await fs.mkdir(allowedDir, { recursive: true });
    await fs.mkdir(blockedDir, { recursive: true });
    await fs.writeFile(path.join(allowedDir, "allowed.txt"), "needle\n", "utf-8");
    await fs.writeFile(path.join(blockedDir, "blocked.txt"), "needle\n", "utf-8");

    const t: any = createGrepTool(makeCtx(dir, { agentTargetPaths: ["src/foo"] }), {
      execFileImpl: fakeExecFile,
      ensureRipgrepImpl: fakeEnsureRipgrep,
    });
    await expect(
      t.execute({
        pattern: "needle",
        path: allowedDir,
        caseSensitive: true,
      }),
    ).resolves.toContain("allowed.txt");
    await expect(
      t.execute({
        pattern: "needle",
        path: blockedDir,
        caseSensitive: true,
      }),
    ).rejects.toThrow(/targetPaths/);
  });

  test("skips credential directories when recursively searching an allowed ancestor", async () => {
    const dir = await tmpDir();
    const coworkDir = path.join(dir, ".cowork");
    await fs.mkdir(path.join(coworkDir, "auth"), { recursive: true });
    await fs.mkdir(path.join(coworkDir, "notes"), { recursive: true });
    await fs.writeFile(path.join(coworkDir, "auth", "token.txt"), "needle secret-token\n", "utf-8");
    await fs.writeFile(
      path.join(coworkDir, "notes", "note.txt"),
      "needle ordinary-note\n",
      "utf-8",
    );

    const t: any = createGrepTool(makeCtx(dir), {
      execFileImpl: fakeExecFile,
      ensureRipgrepImpl: fakeEnsureRipgrep,
    });
    const res: string = await t.execute({
      pattern: "needle",
      path: coworkDir,
      caseSensitive: true,
    });

    expect(res).toContain("ordinary-note");
    expect(res).not.toContain("secret-token");
    expect(res).not.toContain(`${path.sep}auth${path.sep}`);
  });

  test("returns 'No matches' on no results", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "file.txt"), "some content\n", "utf-8");

    const t: any = createGrepTool(makeCtx(dir), {
      execFileImpl: fakeExecFile,
      ensureRipgrepImpl: fakeEnsureRipgrep,
    });
    const res: string = await t.execute({
      pattern: "zzz_impossible_pattern_zzz",
      path: dir,
      caseSensitive: true,
    });
    expect(res).toContain("No matches found.");
  });

  test("handles case-insensitive flag", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "file.txt"), "Hello World\n", "utf-8");

    const t: any = createGrepTool(makeCtx(dir), {
      execFileImpl: fakeExecFile,
      ensureRipgrepImpl: fakeEnsureRipgrep,
    });
    const res: string = await t.execute({
      pattern: "hello",
      path: dir,
      caseSensitive: false,
    });
    expect(res).toContain("Hello World");
  });

  test("case-sensitive search does not match wrong case", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "file.txt"), "Hello World\n", "utf-8");

    const t: any = createGrepTool(makeCtx(dir), {
      execFileImpl: fakeExecFile,
      ensureRipgrepImpl: fakeEnsureRipgrep,
    });
    const res: string = await t.execute({
      pattern: "hello",
      path: dir,
      caseSensitive: true,
    });
    expect(res).toContain("No matches found.");
  });

  test("uses workingDirectory as default search path", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "found.txt"), "target_pattern\n", "utf-8");

    const t: any = createGrepTool(makeCtx(dir), {
      execFileImpl: fakeExecFile,
      ensureRipgrepImpl: fakeEnsureRipgrep,
    });
    const res: string = await t.execute({
      pattern: "target_pattern",
      caseSensitive: true,
    });
    expect(res).toContain("target_pattern");
  });

  test("respects fileGlob filter", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "match.ts"), "pattern_here\n", "utf-8");
    await fs.writeFile(path.join(dir, "skip.js"), "pattern_here\n", "utf-8");

    const t: any = createGrepTool(makeCtx(dir), {
      execFileImpl: fakeExecFile,
      ensureRipgrepImpl: fakeEnsureRipgrep,
    });
    const res: string = await t.execute({
      pattern: "pattern_here",
      path: dir,
      fileGlob: "*.ts",
      caseSensitive: true,
    });
    expect(res).toContain("match.ts");
    expect(res).not.toContain("skip.js");
  });

  test("includes context lines when specified", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "ctx.txt"), "before\ntarget\nafter\n", "utf-8");

    const t: any = createGrepTool(makeCtx(dir), {
      execFileImpl: fakeExecFile,
      ensureRipgrepImpl: fakeEnsureRipgrep,
    });
    const res: string = await t.execute({
      pattern: "target",
      path: dir,
      contextLines: 1,
      caseSensitive: true,
    });
    expect(res).toContain("before");
    expect(res).toContain("target");
    expect(res).toContain("after");
  });

  test("includes line numbers in output", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "numbered.txt"), "aaa\nbbb\nccc\n", "utf-8");

    const t: any = createGrepTool(makeCtx(dir), {
      execFileImpl: fakeExecFile,
      ensureRipgrepImpl: fakeEnsureRipgrep,
    });
    const res: string = await t.execute({
      pattern: "bbb",
      path: dir,
      caseSensitive: true,
    });
    // rg with --line-number should include ":2:" in output
    expect(res).toContain("2:");
  });

  test("constructs correct rg flags for fileGlob, case-insensitive, and contextLines", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "file.ts"), "match\n", "utf-8");

    let capturedCmd = "";
    let capturedArgs: string[] = [];

    const argCaptureExecFile: any = async (cmd: string, args: string[], _opts: any) => {
      capturedCmd = cmd;
      capturedArgs = [...args];
      // Simulate rg producing output so the tool returns normally
      return { stdout: `${path.join(dir, "file.ts")}:1:match\n`, stderr: "", exitCode: 0 };
    };

    const t: any = createGrepTool(makeCtx(dir), {
      execFileImpl: argCaptureExecFile,
      ensureRipgrepImpl: fakeEnsureRipgrep,
    });
    await t.execute({
      pattern: "foo",
      path: dir,
      fileGlob: "*.ts",
      contextLines: 3,
      caseSensitive: false,
    });

    expect(capturedCmd).toBe("rg");
    // Verify all expected flags are present
    expect(capturedArgs).toContain("--line-number");
    expect(capturedArgs).toContain("-i");
    expect(capturedArgs).toContain("-C");
    expect(capturedArgs).toContain("3");
    expect(capturedArgs).toContain("--glob");
    expect(capturedArgs).toContain("*.ts");
    expect(capturedArgs).toContain("--");

    // Pattern and path should be the last two positional args
    const patternIdx = capturedArgs.indexOf("foo");
    expect(patternIdx).toBeGreaterThan(-1);

    const searchPathArg = capturedArgs[patternIdx + 1];
    expect(searchPathArg).toBe(path.resolve(dir));
  });

  test("passes abort signal and timeout to ripgrep", async () => {
    const dir = await tmpDir();
    const controller = new AbortController();
    let capturedOpts: any;

    const argCaptureExecFile: any = async (_cmd: string, _args: string[], opts: any) => {
      capturedOpts = opts;
      return { stdout: "match\n", stderr: "", exitCode: 0 };
    };

    const t: any = createGrepTool(makeCtx(dir, { abortSignal: controller.signal }), {
      execFileImpl: argCaptureExecFile,
      ensureRipgrepImpl: fakeEnsureRipgrep,
    });
    await t.execute({
      pattern: "match",
      path: dir,
      caseSensitive: true,
      timeoutSeconds: 7,
    });

    expect(capturedOpts.signal).toBe(controller.signal);
    expect(capturedOpts.timeoutMs).toBe(7000);
  });

  test("returns an aborted message when ripgrep is cancelled", async () => {
    const dir = await tmpDir();
    const abortingExecFile: any = async (_cmd: string, _args: string[], _opts: any) => {
      return { stdout: "", stderr: "", exitCode: 130, errorCode: "ABORT_ERR" };
    };

    const t: any = createGrepTool(makeCtx(dir), {
      execFileImpl: abortingExecFile,
      ensureRipgrepImpl: fakeEnsureRipgrep,
    });
    const res: string = await t.execute({ pattern: "match", path: dir, caseSensitive: true });

    expect(res).toContain("grep aborted");
  });

  test("includes ripgrep stderr diagnostics on failures", async () => {
    const dir = await tmpDir();
    const failingExecFile: any = async (_cmd: string, _args: string[], _opts: any) => {
      return { stdout: "", stderr: "regex parse error: missing ]", exitCode: 2 };
    };

    const t: any = createGrepTool(makeCtx(dir), {
      execFileImpl: failingExecFile,
      ensureRipgrepImpl: fakeEnsureRipgrep,
    });
    const res: string = await t.execute({ pattern: "[", path: dir, caseSensitive: true });

    expect(res).toContain("regex parse error");
  });

  test("validates contextLines bounds when execute is called directly", async () => {
    const dir = await tmpDir();
    const t: any = createGrepTool(makeCtx(dir), {
      execFileImpl: fakeExecFile,
      ensureRipgrepImpl: fakeEnsureRipgrep,
    });

    await expect(
      t.execute({ pattern: "match", path: dir, contextLines: 51, caseSensitive: true }),
    ).rejects.toThrow(/grep invalid input/);
  });

  test("omits -i flag when caseSensitive is true", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "file.txt"), "data\n", "utf-8");

    let capturedArgs: string[] = [];

    const argCaptureExecFile: any = async (_cmd: string, args: string[], _opts: any) => {
      capturedArgs = [...args];
      return { stdout: `${path.join(dir, "file.txt")}:1:data\n`, stderr: "", exitCode: 0 };
    };

    const t: any = createGrepTool(makeCtx(dir), {
      execFileImpl: argCaptureExecFile,
      ensureRipgrepImpl: fakeEnsureRipgrep,
    });
    await t.execute({
      pattern: "data",
      path: dir,
      caseSensitive: true,
    });

    expect(capturedArgs).toContain("--line-number");
    expect(capturedArgs).not.toContain("-i");
    expect(capturedArgs).not.toContain("*.ts");
    expect(capturedArgs).not.toContain("-C");
    expect(capturedArgs).toContain("--");
    expect(capturedArgs).toContain("data");
    expect(capturedArgs).toContain(path.resolve(dir));
  });

  test("inserts -- before dash-prefixed patterns", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "flags.txt"), "--files-with-matches\n", "utf-8");

    let capturedArgs: string[] = [];
    const argCaptureExecFile: any = async (_cmd: string, args: string[], _opts: any) => {
      capturedArgs = [...args];
      return {
        stdout: `${path.join(dir, "flags.txt")}:1:--files-with-matches\n`,
        stderr: "",
        exitCode: 0,
      };
    };

    const t: any = createGrepTool(makeCtx(dir), {
      execFileImpl: argCaptureExecFile,
      ensureRipgrepImpl: fakeEnsureRipgrep,
    });

    const res: string = await t.execute({
      pattern: "--files-with-matches",
      path: dir,
      caseSensitive: true,
    });

    expect(res).toContain("--files-with-matches");
    expect(capturedArgs).toContain("--");
    const delimiterIdx = capturedArgs.indexOf("--");
    expect(capturedArgs[delimiterIdx + 1]).toBe("--files-with-matches");
  });

  test("emits credential deny globs with forward slashes only", async () => {
    const dir = await tmpDir();
    await fs.mkdir(path.join(dir, ".cowork", "auth"), { recursive: true });
    await fs.mkdir(path.join(dir, ".agent-user", "auth"), { recursive: true });
    await fs.writeFile(path.join(dir, "file.txt"), "needle\n", "utf-8");

    let capturedArgs: string[] = [];
    const argCaptureExecFile: any = async (_cmd: string, args: string[], _opts: any) => {
      capturedArgs = [...args];
      return { stdout: `${path.join(dir, "file.txt")}:1:needle\n`, stderr: "", exitCode: 0 };
    };

    const t: any = createGrepTool(makeCtx(dir), {
      execFileImpl: argCaptureExecFile,
      ensureRipgrepImpl: fakeEnsureRipgrep,
    });
    await t.execute({ pattern: "needle", path: dir, caseSensitive: true });

    const globValues: string[] = [];
    for (let i = 0; i < capturedArgs.length - 1; i++) {
      if (capturedArgs[i] === "--glob") globValues.push(capturedArgs[i + 1] as string);
    }
    expect(globValues).toContain("!.cowork/auth");
    expect(globValues).toContain("!.cowork/auth/**");
    expect(globValues).toContain("!.agent-user/auth");
    for (const value of globValues) {
      expect(value).not.toContain("\\");
    }
  });

  test("normalizes fileGlob separators per platform contract", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "file.txt"), "needle\n", "utf-8");

    let capturedArgs: string[] = [];
    const argCaptureExecFile: any = async (_cmd: string, args: string[], _opts: any) => {
      capturedArgs = [...args];
      return { stdout: `${path.join(dir, "file.txt")}:1:needle\n`, stderr: "", exitCode: 0 };
    };

    const t: any = createGrepTool(makeCtx(dir), {
      execFileImpl: argCaptureExecFile,
      ensureRipgrepImpl: fakeEnsureRipgrep,
    });
    await t.execute({
      pattern: "needle",
      path: dir,
      fileGlob: "src\\**\\*.ts",
      caseSensitive: true,
    });

    const globIdx = capturedArgs.indexOf("--glob");
    const expected = hostPlatform() === "win32" ? "src/**/*.ts" : "src\\**\\*.ts";
    expect(capturedArgs[globIdx + 1]).toBe(expected);
  });

  test("wraps a .cmd ripgrep shim in a cmd.exe batch-shim spawn plan", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "file.txt"), "needle\n", "utf-8");
    const shimPath = "C:\\fake-tools\\rg.cmd";

    let capturedCmd = "";
    let capturedArgs: string[] = [];
    let capturedOptions: Record<string, unknown> = {};
    const argCaptureRun: any = async (cmd: string, args: string[], options: any) => {
      capturedCmd = cmd;
      capturedArgs = [...args];
      capturedOptions = options;
      return { stdout: `${path.join(dir, "file.txt")}:1:needle\n`, stderr: "", exitCode: 0 };
    };

    const t: any = createGrepTool(makeCtx(dir), {
      ensureRipgrepImpl: async () => shimPath,
      platform: "win32",
      runImpl: argCaptureRun,
    } as any);
    const res: string = await t.execute({ pattern: "needle", path: dir, caseSensitive: true });

    expect(res).toContain("needle");
    expect(capturedCmd.toLowerCase()).toMatch(/cmd(\.exe)?$/);
    expect(capturedArgs.slice(0, 4)).toEqual(["/d", "/s", "/v:off", "/c"]);
    expect(capturedArgs[4]).toContain("rg.cmd");
    expect(capturedOptions.windowsVerbatimArguments).toBe(true);
    expect(capturedOptions.platform).toBe("win32");
  });

  test("returns a typed shim error instead of mangling unsafe batch-shim args", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "file.txt"), 'say "hi"\n', "utf-8");
    const shimPath = "C:\\fake-tools\\rg.cmd";

    let spawned = false;
    const t: any = createGrepTool(makeCtx(dir), {
      ensureRipgrepImpl: async () => shimPath,
      platform: "win32",
      runImpl: (async () => {
        spawned = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      }) as any,
    } as any);
    const res: string = await t.execute({
      pattern: 'say "hi"',
      path: dir,
      caseSensitive: true,
    });

    expect(spawned).toBe(false);
    expect(res).toContain("batch shim");
    expect(res).toContain("cannot be passed to it safely");
  });

  test("searches in subdirectories", async () => {
    const dir = await tmpDir();
    await fs.mkdir(path.join(dir, "sub"), { recursive: true });
    await fs.writeFile(path.join(dir, "sub", "deep.txt"), "deep_match\n", "utf-8");

    const t: any = createGrepTool(makeCtx(dir), {
      execFileImpl: fakeExecFile,
      ensureRipgrepImpl: fakeEnsureRipgrep,
    });
    const res: string = await t.execute({
      pattern: "deep_match",
      path: dir,
      caseSensitive: true,
    });
    expect(res).toContain("deep_match");
    expect(res).toContain("deep.txt");
  });
});

describe("ensureRipgrep resolution", () => {
  async function withScrubbedRipgrepEnv<T>(pathValue: string, run: () => Promise<T>): Promise<T> {
    return await withEnv("COWORK_RIPGREP_PATH", undefined, async () => {
      return await withEnv("PATH", pathValue, run);
    });
  }

  test("no longer probes .cmd/.bat managed-install candidates", async () => {
    const homedir = await tmpDir();
    const binDir = path.join(homedir, ".cowork", "bin");
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(path.join(binDir, "rg.cmd"), "@echo off\r\n", "utf-8");
    await fs.writeFile(path.join(binDir, "rg.bat"), "@echo off\r\n", "utf-8");
    const emptyPathDir = await tmpDir();

    await withScrubbedRipgrepEnv(emptyPathDir, async () => {
      await expect(ensureRipgrep({ homedir, disableDownload: true })).rejects.toThrow(
        /downloads are disabled/,
      );
    });
  });

  test("returns the managed native binary when installed", async () => {
    const homedir = await tmpDir();
    const binDir = path.join(homedir, ".cowork", "bin");
    await fs.mkdir(binDir, { recursive: true });
    const managed = path.join(binDir, binaryName("rg"));
    await fs.writeFile(managed, "", "utf-8");
    const emptyPathDir = await tmpDir();

    await withScrubbedRipgrepEnv(emptyPathDir, async () => {
      await expect(ensureRipgrep({ homedir, disableDownload: true })).resolves.toBe(managed);
    });
  });

  test("returns a native rg discovered on PATH", async () => {
    const homedir = await tmpDir();
    const toolDir = await tmpDir();
    const native = path.join(toolDir, binaryName("rg"));
    await fs.writeFile(native, "", "utf-8");
    if (hostPlatform() !== "win32") await fs.chmod(native, 0o755);

    await withScrubbedRipgrepEnv(toolDir, async () => {
      await expect(ensureRipgrep({ homedir, disableDownload: true })).resolves.toBe(native);
    });
  });

  test.if(hostPlatform() === "win32")(
    "skips a PATH rg.cmd shim in favor of the managed rg.exe",
    async () => {
      const homedir = await tmpDir();
      const binDir = path.join(homedir, ".cowork", "bin");
      await fs.mkdir(binDir, { recursive: true });
      const managed = path.join(binDir, "rg.exe");
      await fs.writeFile(managed, "", "utf-8");

      const shimDir = await tmpDir();
      await fs.writeFile(path.join(shimDir, "rg.cmd"), "@echo off\r\n", "utf-8");

      const logs: string[] = [];
      await withScrubbedRipgrepEnv(shimDir, async () => {
        await expect(
          ensureRipgrep({ homedir, disableDownload: true, log: (line) => logs.push(line) }),
        ).resolves.toBe(managed);
      });
      expect(logs.some((line) => line.includes("non-native rg shim"))).toBe(true);
    },
  );

  test.if(hostPlatform() === "win32")(
    "throws instead of returning a PATH rg.cmd shim when no native rg exists",
    async () => {
      const homedir = await tmpDir();
      const shimDir = await tmpDir();
      await fs.writeFile(path.join(shimDir, "rg.cmd"), "@echo off\r\n", "utf-8");

      await withScrubbedRipgrepEnv(shimDir, async () => {
        await expect(ensureRipgrep({ homedir, disableDownload: true })).rejects.toThrow(
          /downloads are disabled/,
        );
      });
    },
  );
});

// ---------------------------------------------------------------------------
// webSearch tool
// ---------------------------------------------------------------------------
