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

describe("memory tool", () => {
  test("imports AGENT.md into sqlite memory on read", async () => {
    const dir = await tmpDir();
    const agentDir = path.join(dir, ".cowork");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, "AGENT.md"), "# Hot cache content", "utf-8");

    const t: any = createMemoryTool(makeCtx(dir));
    const res: string = await t.execute({ action: "read" });
    expect(res).toContain("Hot cache content");
  });

  test("reads imported AGENT.md using hot-cache aliases", async () => {
    const dir = await tmpDir();
    const agentDir = path.join(dir, ".cowork");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, "AGENT.md"), "Hot via AGENT.md key", "utf-8");

    const t: any = createMemoryTool(makeCtx(dir));
    expect(await t.execute({ action: "read", key: "hot" })).toBe("Hot via AGENT.md key");
    expect(await t.execute({ action: "read", key: "AGENT.md" })).toBe("Hot via AGENT.md key");
  });

  test("returns no hot cache when store is empty", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(makeCtx(dir));
    const res: string = await t.execute({ action: "read" });
    expect(res).toBe("No hot cache found.");
  });

  test("writes named memory key", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(makeCtx(dir));
    const res: string = await t.execute({
      action: "write",
      key: "people/sarah",
      content: "Sarah is a developer.",
    });
    expect(res).toContain("Memory written");

    const readBack: string = await t.execute({ action: "read", key: "people/sarah" });
    expect(readBack).toBe("Sarah is a developer.");
  });

  test("reads named memory key with .md extension", async () => {
    const dir = await tmpDir();
    const memDir = path.join(dir, ".cowork", "memory");
    await fs.mkdir(memDir, { recursive: true });
    await fs.writeFile(path.join(memDir, "notes.md"), "My notes", "utf-8");

    const t: any = createMemoryTool(makeCtx(dir));
    const res: string = await t.execute({ action: "read", key: "notes.md" });
    expect(res).toBe("My notes");
  });

  test("returns not found for missing memory key", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(makeCtx(dir));
    const res: string = await t.execute({ action: "read", key: "missing" });
    expect(res).toContain("not found");
  });

  test("returns no hot cache found for missing AGENT.md alias", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(makeCtx(dir));
    const res: string = await t.execute({ action: "read", key: "AGENT.md" });
    expect(res).toBe("No hot cache found.");
  });

  test("rejects write when content is missing", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(makeCtx(dir));
    await expect(t.execute({ action: "write", key: "test" })).rejects.toThrow(
      /content is required/,
    );
  });

  test("searches sqlite-backed memory entries", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(makeCtx(dir));
    await t.execute({
      action: "write",
      key: "stack",
      content: "The project uses TypeScript and Bun runtime.",
    });

    const res: string = await t.execute({ action: "search", query: "TypeScript" });
    expect(res).toContain("TypeScript");
  });

  test("search returns no memory found when nothing matches", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(makeCtx(dir));
    const res: string = await t.execute({
      action: "search",
      query: "zzz_impossible_query_zzz",
    });
    expect(res).toContain("No memory found");
  });

  test("search throws when query is missing", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(makeCtx(dir));
    await expect(t.execute({ action: "search" })).rejects.toThrow(/query is required/);
  });

  test("delete removes saved memory", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(makeCtx(dir));
    await t.execute({ action: "write", key: "temp", content: "temporary" });
    const delRes: string = await t.execute({ action: "delete", key: "temp" });
    expect(delRes).toContain("deleted");
    const readRes: string = await t.execute({ action: "read", key: "temp" });
    expect(readRes).toContain("not found");
  });

  test("reads from user agent dir as fallback via legacy import", async () => {
    const dir = await tmpDir();
    const userCoworkDir = path.join(dir, ".agent-user");
    await fs.mkdir(userCoworkDir, { recursive: true });
    await fs.writeFile(path.join(userCoworkDir, "AGENT.md"), "User-level hot cache", "utf-8");

    const t: any = createMemoryTool(makeCtx(dir));
    const res: string = await t.execute({ action: "read" });
    expect(res).toContain("User-level hot cache");
  });

  test("write without key updates the hot cache", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(makeCtx(dir));

    await t.execute({ action: "write", content: "First hot cache entry" });
    await t.execute({ action: "write", content: "Second hot cache entry" });

    const res: string = await t.execute({ action: "read" });
    expect(res).not.toContain("First hot cache entry");
    expect(res).toContain("Second hot cache entry");
  });

  test("write with AGENT.md alias updates the hot cache", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(makeCtx(dir));

    await t.execute({ action: "write", key: "AGENT.md", content: "Alias hot cache entry" });

    const res: string = await t.execute({ action: "read", key: "hot" });
    expect(res).toBe("Alias hot cache entry");
  });

  test("returns disabled message when enableMemory is false", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(
      makeCtx(dir, { config: makeConfig(dir, { enableMemory: false }) }),
    );
    const res: string = await t.execute({ action: "read" });
    expect(res).toContain("disabled");
  });

  test("prompts for approval when memoryRequireApproval is true and approves", async () => {
    const dir = await tmpDir();
    let prompted = false;
    const t: any = createMemoryTool(
      makeCtx(dir, {
        config: makeConfig(dir, { memoryRequireApproval: true }),
        askUser: async () => {
          prompted = true;
          return "approve";
        },
      }),
    );
    const res: string = await t.execute({ action: "write", key: "pref", content: "Dark mode" });
    expect(prompted).toBe(true);
    expect(res).toContain("Memory written");
  });

  test("denies write when memoryRequireApproval is true and user denies", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(
      makeCtx(dir, {
        config: makeConfig(dir, { memoryRequireApproval: true }),
        askUser: async () => "deny",
      }),
    );
    const res: string = await t.execute({ action: "write", key: "pref", content: "Light mode" });
    expect(res).toContain("denied");
  });

  test("legacy import deduplicates files normalizing to the same id", async () => {
    const dir = await tmpDir();
    const memDir = path.join(dir, ".cowork", "memory");
    await fs.mkdir(memDir, { recursive: true });
    // Both normalize to "foo-bar"
    await fs.writeFile(path.join(memDir, "foo bar.md"), "First content", "utf-8");
    await fs.writeFile(path.join(memDir, "foo-bar.md"), "Second content", "utf-8");

    const t: any = createMemoryTool(makeCtx(dir));
    // Should not throw SQLITE_CONSTRAINT_PRIMARYKEY
    const res: string = await t.execute({ action: "read", key: "foo-bar" });
    expect(["First content", "Second content"]).toContain(res);
  });
});

// ---------------------------------------------------------------------------
// createTools (index)
// ---------------------------------------------------------------------------
