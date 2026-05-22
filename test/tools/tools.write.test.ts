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
});

// ---------------------------------------------------------------------------
// edit tool
// ---------------------------------------------------------------------------
