import { spyOn } from "bun:test";
import { MemoryStore } from "../../src/memoryStore";
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

describe("memory tool", () => {
  test("create-only writes reject normalized name collisions while intentional edits remain valid", async () => {
    const dir = await tmpDir();
    const store = new MemoryStore(
      path.join(dir, "workspace.sqlite"),
      path.join(dir, "user.sqlite"),
    );
    const original = await store.upsert("workspace", {
      id: "Project Guidance",
      content: "keep the original",
      mode: "create",
    });
    await expect(
      store.upsert("workspace", {
        id: "project-guidance.md",
        content: "accidental replacement",
        mode: "create",
      }),
    ).rejects.toThrow("already exists");
    expect(await store.getById(original.id, "workspace")).toEqual(original);
    const edited = await store.upsert("workspace", {
      id: original.id,
      content: "intentional edit",
      mode: "upsert",
    });
    expect(edited.content).toBe("intentional edit");
    expect(edited.createdAt).toBe(original.createdAt);
  });

  test("concurrent create-only writes can create a memory only once", async () => {
    const dir = await tmpDir();
    const store = new MemoryStore(
      path.join(dir, "workspace.sqlite"),
      path.join(dir, "user.sqlite"),
    );
    await store.list("workspace");
    const results = await Promise.allSettled(
      ["first", "second"].map((content) =>
        store.upsert("workspace", { id: "same-title", content, mode: "create" }),
      ),
    );
    const saved = results.filter((result) => result.status === "fulfilled");
    expect(saved).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await store.getById("same-title", "workspace"))?.content).toBe(saved[0]?.value.content);
  });

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

  test("rejects writing memory content over the size cap", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(makeCtx(dir));
    const oversized = "x".repeat(50_001);
    const parsed = t.inputSchema.safeParse({ action: "write", key: "hot", content: oversized });
    expect(parsed.success).toBe(false);
    const okSized = t.inputSchema.safeParse({
      action: "write",
      key: "hot",
      content: "x".repeat(50_000),
    });
    expect(okSized.success).toBe(true);
  });

  test("truncates an oversized hot cache when rendering the prompt section", async () => {
    const dir = await tmpDir();
    const store = new MemoryStore(
      path.join(dir, "project-memory.sqlite"),
      path.join(dir, "user-memory.sqlite"),
    );
    // Simulate a DB written out-of-band / by an older build without the cap.
    await store.upsert("workspace", { id: "hot", content: "Z".repeat(40_000) });
    const section = await store.renderPromptSection();
    expect(section).toContain("hot cache truncated at 16000 characters");
    expect(section.length).toBeLessThan(20_000);
  });

  test("rejects mutating actions when sandbox policy is read-only", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(
      makeCtx(dir, { sandboxPolicy: { kind: "read-only", network: false } }),
    );

    await expect(t.execute({ action: "write", key: "pref", content: "No writes" })).rejects.toThrow(
      /read-only/,
    );
    await expect(t.execute({ action: "delete", key: "pref" })).rejects.toThrow(/read-only/);
    expect(await t.execute({ action: "read", key: "pref" })).toContain("not found");
  });

  test("rejects mutating actions when sandbox policy is no-project-write", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(
      makeCtx(dir, { sandboxPolicy: { kind: "no-project-write", network: false } }),
    );

    await expect(t.execute({ action: "write", key: "pref", content: "No writes" })).rejects.toThrow(
      /no-project-write/,
    );
    await expect(t.execute({ action: "delete", key: "pref" })).rejects.toThrow(/no-project-write/);
    expect(await t.execute({ action: "read", key: "pref" })).toContain("not found");
  });

  test("checks the mutation gate again after memory write approval", async () => {
    const dir = await tmpDir();
    let locked = false;
    const t: any = createMemoryTool(
      makeCtx(dir, {
        config: makeConfig(dir, { memoryRequireApproval: true }),
        askUser: async () => {
          locked = true;
          return "approve";
        },
        assertCanMutate: () => {
          if (locked) {
            throw new Error("task locked before memory write");
          }
        },
      }),
    );

    await expect(
      t.execute({ action: "write", key: "pref", content: "Should not persist" }),
    ).rejects.toThrow("task locked");
    expect(await t.execute({ action: "read", key: "pref" })).toContain("not found");
  });

  test("blocks memory deletes through the mutation gate", async () => {
    const dir = await tmpDir();
    const writer: any = createMemoryTool(makeCtx(dir));
    await writer.execute({ action: "write", key: "pref", content: "Keep this" });
    const t: any = createMemoryTool(
      makeCtx(dir, {
        assertCanMutate: () => {
          throw new Error("task locked before memory delete");
        },
      }),
    );

    await expect(t.execute({ action: "delete", key: "pref" })).rejects.toThrow("task locked");
    expect(await writer.execute({ action: "read", key: "pref" })).toBe("Keep this");
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

  test("a legacy hot-cache read failure leaves the migration retryable", async () => {
    const dir = await tmpDir();
    const hotPath = path.join(dir, "AGENT.md");
    await fs.mkdir(hotPath);
    const store = new MemoryStore(
      path.join(dir, "workspace.sqlite"),
      path.join(dir, "user.sqlite"),
    );

    await expect(store.list("workspace")).rejects.toMatchObject({ code: "EISDIR" });
    await fs.rmdir(hotPath);
    await fs.writeFile(hotPath, "recovered hot cache");
    expect(await store.list("workspace")).toEqual([
      expect.objectContaining({ id: "hot", content: "recovered hot cache" }),
    ]);
  });

  test("legacy directory and stat errors do not permanently skip deep memory", async () => {
    const dir = await tmpDir();
    const memoryDir = path.join(dir, "memory");
    await fs.writeFile(memoryDir, "temporarily not a directory");
    const store = new MemoryStore(
      path.join(dir, "workspace.sqlite"),
      path.join(dir, "user.sqlite"),
    );
    await expect(store.list("workspace")).rejects.toMatchObject({ code: "ENOTDIR" });

    await fs.rm(memoryDir);
    await fs.mkdir(memoryDir);
    const memoryPath = path.join(memoryDir, "notes.md");
    await fs.writeFile(memoryPath, "recover this memory");
    const originalStat = fs.stat;
    const failure = Object.assign(new Error("simulated legacy storage read error"), {
      code: "EIO",
    });
    const stat = spyOn(fs, "stat").mockImplementation(
      async (...args: Parameters<typeof fs.stat>) => {
        if (String(args[0]) === memoryPath) throw failure;
        return originalStat(...args);
      },
    );
    try {
      await expect(store.list("workspace")).rejects.toBe(failure);
    } finally {
      stat.mockRestore();
    }
    expect(await store.list("workspace")).toEqual([
      expect.objectContaining({ id: "notes", content: "recover this memory" }),
    ]);
  });

  test("legacy traversal imports each directory once when symlinks form a cycle", async () => {
    const dir = await tmpDir();
    const memoryDir = path.join(dir, "memory");
    await fs.mkdir(path.join(memoryDir, "nested"), { recursive: true });
    await fs.writeFile(path.join(memoryDir, "notes.md"), "one memory");
    await fs.symlink(memoryDir, path.join(memoryDir, "nested", "cycle"), "dir");
    const store = new MemoryStore(
      path.join(dir, "workspace.sqlite"),
      path.join(dir, "user.sqlite"),
    );

    expect(await store.list("workspace")).toEqual([
      expect.objectContaining({ id: "notes", content: "one memory" }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// createTools (index)
// ---------------------------------------------------------------------------
