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
  createNotebookEditTool,
  createReadTool,
  createSkillTool,
  createTodoWriteTool,
  createTools,
  createWebFetchTool,
  createWebSearchTool,
  createWriteTool,
  currentTodos,
  describe,
  expect,
  fs,
  getAiCoworkerPaths,
  listSessionToolNames,
  makeConfig,
  makeCtx,
  mock,
  onTodoChange,
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

  const fakeExecFile: any = (_cmd: string, args: string[], _opts: any, cb: any) => {
    void (async () => {
      try {
        let caseInsensitive = false;
        let contextLines = 0;
        let fileGlob: string | undefined;

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
            fileGlob = rest.shift();
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
        const globRe = fileGlob ? globToRegExp(fileGlob) : null;

        const files: string[] = [];
        const walk = async (p: string) => {
          const st = await fs.stat(p);
          if (st.isFile()) {
            if (!globRe || globRe.test(path.basename(p))) files.push(p);
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
          const err: any = new Error("no matches");
          err.code = 1;
          cb(err, "", "");
          return;
        }

        cb(null, outLines.join("\n") + "\n", "");
      } catch (err) {
        cb(err, "", "");
      }
    })();
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

    const argCaptureExecFile: any = (cmd: string, args: string[], _opts: any, cb: any) => {
      capturedCmd = cmd;
      capturedArgs = [...args];
      // Simulate rg producing output so the tool returns normally
      cb(null, `${path.join(dir, "file.ts")}:1:match\n`, "");
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

  test("omits -i flag when caseSensitive is true", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "file.txt"), "data\n", "utf-8");

    let capturedArgs: string[] = [];

    const argCaptureExecFile: any = (cmd: string, args: string[], _opts: any, cb: any) => {
      capturedArgs = [...args];
      cb(null, `${path.join(dir, "file.txt")}:1:data\n`, "");
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
    expect(capturedArgs).not.toContain("--glob");
    expect(capturedArgs).not.toContain("-C");
    expect(capturedArgs).toContain("--");
    expect(capturedArgs).toContain("data");
    expect(capturedArgs).toContain(path.resolve(dir));
  });

  test("inserts -- before dash-prefixed patterns", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "flags.txt"), "--files-with-matches\n", "utf-8");

    let capturedArgs: string[] = [];
    const argCaptureExecFile: any = (_cmd: string, args: string[], _opts: any, cb: any) => {
      capturedArgs = [...args];
      cb(null, `${path.join(dir, "flags.txt")}:1:--files-with-matches\n`, "");
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

// ---------------------------------------------------------------------------
// webSearch tool
// ---------------------------------------------------------------------------
