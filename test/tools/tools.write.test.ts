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

describe("write tool", () => {
  test("creates file with content", async () => {
    const dir = await tmpDir();
    const t: any = createWriteTool(makeCtx(dir));
    const p = path.join(dir, "new.txt");
    const res: string = await t.execute({ filePath: p, content: "hello world" });
    expect(res).toContain("11"); // 11 chars
    const written = await fs.readFile(p, "utf-8");
    expect(written).toBe("hello world");
  });

  test("creates parent directories recursively", async () => {
    const dir = await tmpDir();
    const t: any = createWriteTool(makeCtx(dir));
    const p = path.join(dir, "a", "b", "c", "deep.txt");
    await t.execute({ filePath: p, content: "deep" });
    const written = await fs.readFile(p, "utf-8");
    expect(written).toBe("deep");
  });

  test("cleans parent directories if the mutation gate closes after mkdir", async () => {
    const dir = await tmpDir();
    let gateChecks = 0;
    const t: any = createWriteTool(
      makeCtx(dir, {
        assertCanMutate: () => {
          gateChecks += 1;
          if (gateChecks > 1) throw new Error("terminal task write gate closed");
        },
      }),
    );
    const nestedDir = path.join(dir, "terminal", "race");
    const p = path.join(nestedDir, "blocked.txt");

    await expect(t.execute({ filePath: p, content: "blocked" })).rejects.toThrow(
      /write gate closed/,
    );
    await expect(fs.access(p)).rejects.toThrow();
    await expect(fs.access(nestedDir)).rejects.toThrow();
  });

  test("overwrites existing file", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "exist.txt");
    await fs.writeFile(p, "old content", "utf-8");

    const t: any = createWriteTool(makeCtx(dir));
    await t.execute({ filePath: p, content: "new content" });
    const written = await fs.readFile(p, "utf-8");
    expect(written).toBe("new content");
  });

  test("appends to existing file when mode is append", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "append.txt");
    await fs.writeFile(p, "first\n", "utf-8");

    const t: any = createWriteTool(makeCtx(dir));
    const res: string = await t.execute({ filePath: p, content: "second\n", mode: "append" });
    expect(res).toContain("Appended");
    const written = await fs.readFile(p, "utf-8");
    expect(written).toBe("first\nsecond\n");
  });

  test("creates file when appending to a missing path", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "missing", "append.txt");

    const t: any = createWriteTool(makeCtx(dir));
    await t.execute({ filePath: p, content: "chunk\n", mode: "append" });
    const written = await fs.readFile(p, "utf-8");
    expect(written).toBe("chunk\n");
  });

  test("writes empty string", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "empty.txt");

    const t: any = createWriteTool(makeCtx(dir));
    const res: string = await t.execute({ filePath: p, content: "" });
    expect(res).toContain("0 chars");
    const written = await fs.readFile(p, "utf-8");
    expect(written).toBe("");
  });

  test("rejects paths outside allowed directories", async () => {
    const dir = await tmpDir();
    const outsideDir = await tmpDir();

    const t: any = createWriteTool(makeCtx(dir));
    await expect(
      t.execute({ filePath: path.join(outsideDir, "bad.txt"), content: "nope" }),
    ).rejects.toThrow(/blocked/i);
  });

  test("rejects writes when sandbox policy is explicitly read-only", async () => {
    const dir = await tmpDir();
    const t: any = createWriteTool(
      makeCtx(dir, { sandboxPolicy: { kind: "read-only", network: false } }),
    );
    await expect(t.execute({ filePath: "blocked.txt", content: "nope" })).rejects.toThrow(
      /sandbox mode is read-only/i,
    );
    await expect(fs.readFile(path.join(dir, "blocked.txt"), "utf-8")).rejects.toThrow();
  });

  test("rejects writes when sandbox policy is no-project-write", async () => {
    const dir = await tmpDir();
    const t: any = createWriteTool(
      makeCtx(dir, { sandboxPolicy: { kind: "no-project-write", network: false } }),
    );
    await expect(t.execute({ filePath: "blocked.txt", content: "nope" })).rejects.toThrow(
      /sandbox mode is no-project-write/i,
    );
    await expect(fs.readFile(path.join(dir, "blocked.txt"), "utf-8")).rejects.toThrow();
  });

  test("enforces child agent targetPaths for writes", async () => {
    const dir = await tmpDir();
    await fs.mkdir(path.join(dir, "src", "foo"), { recursive: true });
    await fs.mkdir(path.join(dir, "src", "bar"), { recursive: true });

    const t: any = createWriteTool(makeCtx(dir, { agentTargetPaths: ["src/foo"] }));
    await expect(t.execute({ filePath: "src/foo/allowed.ts", content: "ok" })).resolves.toContain(
      "Wrote",
    );
    await expect(t.execute({ filePath: "src/bar/blocked.ts", content: "nope" })).rejects.toThrow(
      /targetPaths/,
    );
    await expect(fs.readFile(path.join(dir, "src", "foo", "allowed.ts"), "utf-8")).resolves.toBe(
      "ok",
    );
    await expect(
      fs.readFile(path.join(dir, "src", "bar", "blocked.ts"), "utf-8"),
    ).rejects.toThrow();
  });

  test("returns descriptive result string", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "desc.txt");
    const t: any = createWriteTool(makeCtx(dir));
    const res: string = await t.execute({ filePath: p, content: "abc" });
    expect(res).toContain("Wrote");
    expect(res).toContain("3 chars");
    expect(res).toContain(p);
  });

  test("writes multiline content", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "multi.txt");
    const t: any = createWriteTool(makeCtx(dir));
    await t.execute({ filePath: p, content: "line1\nline2\nline3" });
    const written = await fs.readFile(p, "utf-8");
    expect(written).toBe("line1\nline2\nline3");
  });

  test("writes to output directory", async () => {
    const dir = await tmpDir();
    const outDir = path.join(dir, "output");
    await fs.mkdir(outDir, { recursive: true });
    const p = path.join(outDir, "result.txt");

    const t: any = createWriteTool(makeCtx(dir));
    await t.execute({ filePath: p, content: "output content" });
    const written = await fs.readFile(p, "utf-8");
    expect(written).toBe("output content");
  });

  test("rejects write through symlink segment to outside directory", async () => {
    if (process.platform === "win32") return;

    const dir = await tmpDir();
    const outsideDir = await tmpDir();
    const link = path.join(dir, "outside-link");
    await fs.symlink(outsideDir, link);

    const t: any = createWriteTool(makeCtx(dir));
    await expect(
      t.execute({ filePath: path.join(link, "blocked.txt"), content: "nope" }),
    ).rejects.toThrow(/blocked/i);
  });

  test("refuses to plant a .git hook under the project root", async () => {
    const dir = await tmpDir();
    await fs.mkdir(path.join(dir, ".git", "hooks"), { recursive: true });
    const hook = path.join(dir, ".git", "hooks", "pre-commit");

    const t: any = createWriteTool(makeCtx(dir));
    await expect(t.execute({ filePath: hook, content: "#!/bin/sh\necho pwned\n" })).rejects.toThrow(
      /read-only/i,
    );
    await expect(fs.readFile(hook, "utf-8")).rejects.toThrow();
  });

  test("refuses to write project .cowork config metadata", async () => {
    const dir = await tmpDir();
    const configPath = path.join(dir, ".cowork", "config.json");

    const t: any = createWriteTool(makeCtx(dir));
    await expect(
      t.execute({ filePath: configPath, content: '{"provider":"evil"}' }),
    ).rejects.toThrow(/read-only/i);
    await expect(fs.readFile(configPath, "utf-8")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// edit tool
// ---------------------------------------------------------------------------
