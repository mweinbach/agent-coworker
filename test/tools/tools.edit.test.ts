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

  test("rejects edits when sandbox policy is explicitly read-only", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "file.txt");
    await fs.writeFile(p, "hello world", "utf-8");

    const t: any = createEditTool(
      makeCtx(dir, { sandboxPolicy: { kind: "read-only", network: false } }),
    );
    await expect(
      t.execute({ filePath: p, oldString: "world", newString: "earth", replaceAll: false }),
    ).rejects.toThrow(/sandbox mode is read-only/i);
    await expect(fs.readFile(p, "utf-8")).resolves.toBe("hello world");
  });

  test("rejects edits when sandbox policy is no-project-write", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "file.txt");
    await fs.writeFile(p, "hello world", "utf-8");

    const t: any = createEditTool(
      makeCtx(dir, { sandboxPolicy: { kind: "no-project-write", network: false } }),
    );
    await expect(
      t.execute({ filePath: p, oldString: "world", newString: "earth", replaceAll: false }),
    ).rejects.toThrow(/sandbox mode is no-project-write/i);
    await expect(fs.readFile(p, "utf-8")).resolves.toBe("hello world");
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

  test("enforces child agent targetPaths for edits", async () => {
    const dir = await tmpDir();
    await fs.mkdir(path.join(dir, "src", "foo"), { recursive: true });
    await fs.mkdir(path.join(dir, "src", "bar"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "foo", "allowed.ts"), "old", "utf-8");
    await fs.writeFile(path.join(dir, "src", "bar", "blocked.ts"), "old", "utf-8");

    const t: any = createEditTool(makeCtx(dir, { agentTargetPaths: ["src/foo"] }));
    await expect(
      t.execute({
        filePath: "src/foo/allowed.ts",
        oldString: "old",
        newString: "new",
      }),
    ).resolves.toBe("Edit applied.");
    await expect(
      t.execute({
        filePath: "src/bar/blocked.ts",
        oldString: "old",
        newString: "new",
      }),
    ).rejects.toThrow(/targetPaths/);
    await expect(fs.readFile(path.join(dir, "src", "foo", "allowed.ts"), "utf-8")).resolves.toBe(
      "new",
    );
    await expect(fs.readFile(path.join(dir, "src", "bar", "blocked.ts"), "utf-8")).resolves.toBe(
      "old",
    );
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

  test("refuses to edit protected project .cowork metadata", async () => {
    const dir = await tmpDir();
    const configPath = path.join(dir, ".cowork", "config.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, '{"provider":"google"}', "utf-8");

    const t: any = createEditTool(makeCtx(dir));
    await expect(
      t.execute({
        filePath: configPath,
        oldString: "google",
        newString: "evil",
        replaceAll: false,
      }),
    ).rejects.toThrow(/read-only/i);
    // The protected file must be left untouched.
    expect(await fs.readFile(configPath, "utf-8")).toBe('{"provider":"google"}');
  });

  test("refuses to edit an existing .git hook", async () => {
    const dir = await tmpDir();
    const hook = path.join(dir, ".git", "hooks", "pre-commit");
    await fs.mkdir(path.dirname(hook), { recursive: true });
    await fs.writeFile(hook, "#!/bin/sh\necho ok\n", "utf-8");

    const t: any = createEditTool(makeCtx(dir));
    await expect(
      t.execute({
        filePath: hook,
        oldString: "echo ok",
        newString: "echo pwned",
        replaceAll: false,
      }),
    ).rejects.toThrow(/read-only/i);
    expect(await fs.readFile(hook, "utf-8")).toBe("#!/bin/sh\necho ok\n");
  });
});

// ---------------------------------------------------------------------------
// bash tool
// ---------------------------------------------------------------------------
