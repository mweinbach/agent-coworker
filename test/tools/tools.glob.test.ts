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

describe("glob tool", () => {
  test("finds files matching pattern", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "a.ts"), "", "utf-8");
    await fs.writeFile(path.join(dir, "b.ts"), "", "utf-8");
    await fs.writeFile(path.join(dir, "c.js"), "", "utf-8");

    const t: any = createGlobTool(makeCtx(dir));
    const res: string = await t.execute({ pattern: "*.ts" });
    expect(res).toContain("a.ts");
    expect(res).toContain("b.ts");
    expect(res).not.toContain("c.js");
  });

  test("returns empty message for no matches", async () => {
    const dir = await tmpDir();
    const t: any = createGlobTool(makeCtx(dir));
    const res: string = await t.execute({ pattern: "*.xyz" });
    expect(res).toBe("No files found.");
  });

  test("uses workingDirectory as default cwd", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "test.txt"), "", "utf-8");

    const t: any = createGlobTool(makeCtx(dir));
    const res: string = await t.execute({ pattern: "*.txt" });
    expect(res).toContain("test.txt");
  });

  test("handles recursive patterns", async () => {
    const dir = await tmpDir();
    await fs.mkdir(path.join(dir, "sub", "deep"), { recursive: true });
    await fs.writeFile(path.join(dir, "sub", "deep", "file.ts"), "", "utf-8");

    const t: any = createGlobTool(makeCtx(dir));
    const res: string = await t.execute({ pattern: "**/*.ts" });
    expect(res).toContain("sub/deep/file.ts");
  });

  test("respects custom cwd argument", async () => {
    const dir = await tmpDir();
    const subDir = path.join(dir, "subdir");
    await fs.mkdir(subDir, { recursive: true });
    await fs.writeFile(path.join(subDir, "inner.txt"), "", "utf-8");
    await fs.writeFile(path.join(dir, "outer.txt"), "", "utf-8");

    const t: any = createGlobTool(makeCtx(dir));
    const res: string = await t.execute({ pattern: "*.txt", cwd: subDir });
    expect(res).toContain("inner.txt");
    expect(res).not.toContain("outer.txt");
  });

  test("treats brace patterns literally when brace expansion is disabled", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "a.ts"), "", "utf-8");
    await fs.writeFile(path.join(dir, "b.js"), "", "utf-8");
    await fs.writeFile(path.join(dir, "c.py"), "", "utf-8");

    const t: any = createGlobTool(makeCtx(dir));
    const res: string = await t.execute({ pattern: "*.{ts,js}" });
    expect(res).toBe("No files found.");
  });

  test("does not expand brace patterns containing absolute paths", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "a.ts"), "", "utf-8");

    const t: any = createGlobTool(makeCtx(dir));
    const res: string = await t.execute({ pattern: "{/etc/passwd,*.ts}" });
    expect(res).toBe("No files found.");
    expect(res).not.toContain("/etc/passwd");
  });

  test("rejects glob with cwd outside allowed directories", async () => {
    const dir = await tmpDir();
    const outsideDir = await tmpDir();
    await fs.writeFile(path.join(outsideDir, "x.ts"), "", "utf-8");

    const t: any = createGlobTool(makeCtx(dir));
    await expect(t.execute({ pattern: "*.ts", cwd: outsideDir })).rejects.toThrow(/blocked/i);
  });

  test("rejects matches that escape allowed scope via symlink path segments", async () => {
    const dir = await tmpDir();
    const outsideDir = await tmpDir();
    const linkPath = path.join(dir, "link");
    await fs.writeFile(path.join(outsideDir, "secret.txt"), "", "utf-8");

    try {
      const symlinkType = process.platform === "win32" ? "junction" : "dir";
      await fs.symlink(outsideDir, linkPath, symlinkType);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") return;
      throw err;
    }

    const t: any = createGlobTool(makeCtx(dir));
    await expect(t.execute({ pattern: "link/*.txt" })).rejects.toThrow(/blocked/i);
  });

  test("rejects glob with parent-relative pattern escaping cwd", async () => {
    const dir = await tmpDir();

    const t: any = createGlobTool(makeCtx(dir));
    await expect(t.execute({ pattern: "../outside/*.ts" })).rejects.toThrow(/blocked/i);
  });

  test("supports glob with absolute pattern by converting it", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "match.ts"), "", "utf-8");
    const absolutePattern = path.join(dir, "*.ts");

    const t: any = createGlobTool(makeCtx(dir));
    const res: string = await t.execute({ pattern: absolutePattern });
    expect(res).toContain("match.ts");
  });

  test("limits results when maxResults is provided", async () => {
    const dir = await tmpDir();
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(path.join(dir, `f${i}.txt`), "", "utf-8");
    }

    const t: any = createGlobTool(makeCtx(dir));
    const res: string = await t.execute({ pattern: "*.txt", maxResults: 2 });
    const lines = res.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(res).toContain("truncated to 2 matches");
  });
});

// ---------------------------------------------------------------------------
// grep tool
// ---------------------------------------------------------------------------
