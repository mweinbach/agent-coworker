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

describe("edit tool", () => {
  test("replaces single occurrence", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "file.txt");
    await fs.writeFile(p, "hello world", "utf-8");

    const t: any = createEditTool(makeCtx(dir));
    const res = await t.execute({
      filePath: p,
      oldString: "world",
      newString: "earth",
      replaceAll: false,
    });
    expect(res).toBe("Edit applied.");
    const content = await fs.readFile(p, "utf-8");
    expect(content).toBe("hello earth");
  });

  test("throws when oldString not found", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "file.txt");
    await fs.writeFile(p, "hello world", "utf-8");

    const t: any = createEditTool(makeCtx(dir));
    await expect(
      t.execute({ filePath: p, oldString: "missing", newString: "x", replaceAll: false }),
    ).rejects.toThrow(/oldString not found/);
  });

  test("throws when multiple occurrences without replaceAll", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "file.txt");
    await fs.writeFile(p, "foo\nfoo\n", "utf-8");

    const t: any = createEditTool(makeCtx(dir));
    await expect(
      t.execute({ filePath: p, oldString: "foo", newString: "bar", replaceAll: false }),
    ).rejects.toThrow(/found 2 times/);
  });

  test("replaces all occurrences with replaceAll", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "file.txt");
    await fs.writeFile(p, "foo\nfoo\nfoo\n", "utf-8");

    const t: any = createEditTool(makeCtx(dir));
    const res = await t.execute({
      filePath: p,
      oldString: "foo",
      newString: "bar",
      replaceAll: true,
    });
    expect(res).toBe("Edit applied.");
    const content = await fs.readFile(p, "utf-8");
    expect(content).toBe("bar\nbar\nbar\n");
  });

  test("handles empty newString (deletion)", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "file.txt");
    await fs.writeFile(p, "hello world", "utf-8");

    const t: any = createEditTool(makeCtx(dir));
    await t.execute({ filePath: p, oldString: " world", newString: "", replaceAll: false });
    const content = await fs.readFile(p, "utf-8");
    expect(content).toBe("hello");
  });

  test("throws when oldString is empty", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "file.txt");
    await fs.writeFile(p, "content", "utf-8");

    const t: any = createEditTool(makeCtx(dir));
    await expect(
      t.execute({ filePath: p, oldString: "", newString: "new", replaceAll: false }),
    ).rejects.toThrow("oldString cannot be empty");
  });

  test("case-sensitive matching", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "file.txt");
    await fs.writeFile(p, "Hello World", "utf-8");

    const t: any = createEditTool(makeCtx(dir));
    // Lowercase "hello" should not match "Hello"
    await expect(
      t.execute({ filePath: p, oldString: "hello", newString: "hi", replaceAll: false }),
    ).rejects.toThrow(/oldString not found/);
  });

  test("rejects path outside allowed directories", async () => {
    const dir = await tmpDir();
    const outsideDir = await tmpDir();
    const p = path.join(outsideDir, "blocked.txt");
    await fs.writeFile(p, "content", "utf-8");

    const t: any = createEditTool(makeCtx(dir));
    await expect(
      t.execute({ filePath: p, oldString: "content", newString: "new", replaceAll: false }),
    ).rejects.toThrow(/blocked/i);
  });

  test("rejects edit through symlink segment to outside directory", async () => {
    if (process.platform === "win32") return;

    const dir = await tmpDir();
    const outsideDir = await tmpDir();
    const outsideFile = path.join(outsideDir, "outside.txt");
    await fs.writeFile(outsideFile, "outside", "utf-8");

    const link = path.join(dir, "outside-link");
    await fs.symlink(outsideDir, link);

    const t: any = createEditTool(makeCtx(dir));
    await expect(
      t.execute({
        filePath: path.join(link, "outside.txt"),
        oldString: "outside",
        newString: "new",
        replaceAll: false,
      }),
    ).rejects.toThrow(/blocked/i);
  });

  test("preserves file content around the edit", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "file.txt");
    await fs.writeFile(p, "line1\nTARGET\nline3\n", "utf-8");

    const t: any = createEditTool(makeCtx(dir));
    await t.execute({ filePath: p, oldString: "TARGET", newString: "REPLACED", replaceAll: false });
    const content = await fs.readFile(p, "utf-8");
    expect(content).toBe("line1\nREPLACED\nline3\n");
  });

  test("replaces multiline oldString", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "file.txt");
    await fs.writeFile(p, "start\nmiddle\nend\n", "utf-8");

    const t: any = createEditTool(makeCtx(dir));
    await t.execute({
      filePath: p,
      oldString: "start\nmiddle",
      newString: "replaced",
      replaceAll: false,
    });
    const content = await fs.readFile(p, "utf-8");
    expect(content).toBe("replaced\nend\n");
  });

  test("reports correct count for three occurrences", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "file.txt");
    await fs.writeFile(p, "aaa\naaa\naaa\n", "utf-8");

    const t: any = createEditTool(makeCtx(dir));
    await expect(
      t.execute({ filePath: p, oldString: "aaa", newString: "bbb", replaceAll: false }),
    ).rejects.toThrow(/found 3 times/);
  });
});

// ---------------------------------------------------------------------------
// bash tool
// ---------------------------------------------------------------------------
