import {
  AdvancedMemoryStore,
  CHATS_FOLDER,
  MEMORY_INDEX_FILE,
  resolveMemoryFolderName,
} from "../../src/advancedMemory/store";
import {
  afterEach,
  beforeEach,
  createManageMemoryTool,
  describe,
  expect,
  fs,
  makeConfig,
  makeCtx,
  mock,
  os,
  path,
  test,
} from "./tools.harness";

let dir: string;
let memoriesDir: string;
let store: AdvancedMemoryStore;

type ListResult = {
  activeFolder: string;
  writableFolder: string;
  readableFolders: string[];
  writeRoots: string[];
  readRoots: string[];
  folders: Array<{
    folder: string;
    writable: boolean;
    memories: Array<{ slug: string }>;
  }>;
};

type ToolResult = Record<string, unknown>;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "manage-memory-tool-"));
  memoriesDir = path.join(dir, "memories");
  store = new AdvancedMemoryStore(memoriesDir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function makeTool(overrides: Parameters<typeof makeCtx>[1] = {}) {
  const config = makeConfig(dir, { advancedMemory: true, memoriesDir });
  return createManageMemoryTool(
    makeCtx(dir, {
      config,
      sessionId: "sess-tool",
      ...overrides,
    }),
  );
}

describe("manageMemory tool", () => {
  test("lists active and chats folders with summaries and access roots", async () => {
    const config = makeConfig(dir, { advancedMemory: true, memoriesDir });
    const activeFolder = resolveMemoryFolderName(config);
    await store.writeMemory(activeFolder, {
      name: "Workspace rule",
      description: "Project-specific memory",
      type: "project",
      body: "Keep this in the active folder.",
    });
    await store.writeMemory(CHATS_FOLDER, {
      name: "Chat rule",
      description: "Shared chat memory",
      type: "feedback",
      body: "Shared context.",
    });

    const tool = createManageMemoryTool(makeCtx(dir, { config }));
    const result = (await tool.execute({ action: "list" })) as ListResult;

    expect(result.activeFolder).toBe(activeFolder);
    expect(result.writableFolder).toBe(activeFolder);
    expect(result.readableFolders).toEqual([activeFolder, CHATS_FOLDER]);
    expect(result.writeRoots).toEqual([path.join(memoriesDir, activeFolder)]);
    expect(result.readRoots).toEqual([
      path.join(memoriesDir, activeFolder),
      path.join(memoriesDir, CHATS_FOLDER),
    ]);
    expect(result.folders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          folder: activeFolder,
          writable: true,
          memories: [expect.objectContaining({ slug: "workspace-rule" })],
        }),
        expect.objectContaining({
          folder: CHATS_FOLDER,
          writable: false,
          memories: [expect.objectContaining({ slug: "chat-rule" })],
        }),
      ]),
    );
  });

  test("creates an active-folder memory with originSessionId and rejects duplicates", async () => {
    const onAdvancedMemoryChanged = mock(async () => {});
    const tool = makeTool({ onAdvancedMemoryChanged });
    const activeFolder = resolveMemoryFolderName(makeConfig(dir, { advancedMemory: true }));

    const result = (await tool.execute({
      action: "create",
      name: "Preference note",
      description: "Remember the user's UI preference",
      type: "feedback",
      body: "Use compact settings controls.",
    })) as ToolResult;

    expect(result).toMatchObject({
      ok: true,
      action: "create",
      folder: activeFolder,
      memory: {
        slug: "preference-note",
        name: "Preference note",
        description: "Remember the user's UI preference",
        type: "feedback",
        originSessionId: "sess-tool",
      },
    });
    expect(onAdvancedMemoryChanged).toHaveBeenCalledWith(activeFolder);
    const stored = await store.readMemory(activeFolder, "preference-note");
    expect(stored?.originSessionId).toBe("sess-tool");
    expect(stored?.body).toBe("Use compact settings controls.");
    await expect(
      tool.execute({
        action: "create",
        name: "Preference note",
        description: "Duplicate",
        body: "Nope.",
      }),
    ).rejects.toThrow("already exists");
    await expect(
      tool.execute({
        action: "create",
        source: "chats",
        name: "Shared write",
        description: "Should stay read-only",
        body: "Nope.",
      }),
    ).rejects.toThrow("read-only");
  });

  test("rejects mutating actions when sandbox policy is read-only", async () => {
    const config = makeConfig(dir, { advancedMemory: true, memoriesDir });
    const activeFolder = resolveMemoryFolderName(config);
    await store.writeMemory(activeFolder, {
      name: "Existing",
      description: "Existing memory",
      body: "Original body.",
    });
    const tool = createManageMemoryTool(
      makeCtx(dir, {
        config,
        sandboxPolicy: { kind: "read-only", network: false },
      }),
    );

    const listResult = (await tool.execute({ action: "list" })) as ListResult;
    expect(listResult.activeFolder).toBe(activeFolder);
    await expect(
      tool.execute({
        action: "create",
        name: "Nope",
        description: "Should not write",
        body: "Blocked.",
      }),
    ).rejects.toThrow(/read-only/);
    await expect(
      tool.execute({ action: "edit", slug: "existing", body: "Blocked." }),
    ).rejects.toThrow(/read-only/);
    await expect(tool.execute({ action: "refresh_index" })).rejects.toThrow(/read-only/);
    expect((await store.readMemory(activeFolder, "existing"))?.body).toBe("Original body.");
  });

  test("reads active memories first and can target chats read-only context", async () => {
    const config = makeConfig(dir, { advancedMemory: true, memoriesDir });
    const activeFolder = resolveMemoryFolderName(config);
    await store.writeMemory(activeFolder, {
      name: "Shared name",
      description: "Active copy",
      body: "active body",
    });
    await store.writeMemory(CHATS_FOLDER, {
      name: "Shared name",
      description: "Chats copy",
      body: "chat body",
    });
    const tool = createManageMemoryTool(makeCtx(dir, { config }));

    const auto = (await tool.execute({ action: "read", name: "Shared name" })) as ToolResult;
    expect(auto).toMatchObject({
      found: true,
      folder: activeFolder,
      writable: true,
      memory: { body: "active body" },
    });

    const chats = (await tool.execute({
      action: "read",
      name: "Shared name",
      source: "chats",
    })) as ToolResult;
    expect(chats).toMatchObject({
      found: true,
      folder: CHATS_FOLDER,
      writable: false,
      memory: { body: "chat body" },
    });
  });

  test("edits only the active folder and preserves unspecified fields", async () => {
    const config = makeConfig(dir, { advancedMemory: true, memoriesDir });
    const activeFolder = resolveMemoryFolderName(config);
    await store.writeMemory(activeFolder, {
      name: "Project rule",
      description: "Original description",
      type: "project",
      originSessionId: "sess-old",
      body: "Original body.",
    });
    await store.writeMemory(CHATS_FOLDER, {
      slug: "shared-only",
      name: "Shared only",
      description: "Chats memory",
      body: "Do not edit.",
    });
    const onAdvancedMemoryChanged = mock(async () => {});
    const tool = createManageMemoryTool(
      makeCtx(dir, { config, sessionId: "sess-edit", onAdvancedMemoryChanged }),
    );

    const edited = (await tool.execute({
      action: "edit",
      slug: "project-rule",
      body: "Updated body.",
    })) as ToolResult;
    expect(edited).toMatchObject({
      ok: true,
      folder: activeFolder,
      memory: {
        slug: "project-rule",
        description: "Original description",
        type: "project",
        originSessionId: "sess-edit",
      },
    });
    expect((await store.readMemory(activeFolder, "project-rule"))?.body).toBe("Updated body.");
    expect(onAdvancedMemoryChanged).toHaveBeenCalledWith(activeFolder);

    const missing = (await tool.execute({
      action: "edit",
      slug: "shared-only",
      body: "Should not touch chats.",
    })) as ToolResult;
    expect(missing).toMatchObject({
      ok: false,
      folder: activeFolder,
      slug: "shared-only",
      reason: "not_found",
    });
    expect((await store.readMemory(CHATS_FOLDER, "shared-only"))?.body).toBe("Do not edit.");
  });

  test("refresh_index regenerates the active MEMORY.md", async () => {
    const config = makeConfig(dir, { advancedMemory: true, memoriesDir });
    const activeFolder = resolveMemoryFolderName(config);
    await store.writeMemory(activeFolder, {
      name: "Index me",
      description: "Appears in the index",
      body: "body",
    });
    const indexPath = path.join(memoriesDir, activeFolder, MEMORY_INDEX_FILE);
    await fs.rm(indexPath, { force: true });
    const onAdvancedMemoryChanged = mock(async () => {});
    const tool = createManageMemoryTool(makeCtx(dir, { config, onAdvancedMemoryChanged }));

    const result = (await tool.execute({ action: "refresh_index" })) as ToolResult;

    expect(result).toMatchObject({
      ok: true,
      action: "refresh_index",
      folder: activeFolder,
      indexPath,
    });
    expect(await fs.readFile(indexPath, "utf-8")).toContain("[Index me](index-me.md)");
    expect(onAdvancedMemoryChanged).toHaveBeenCalledWith(activeFolder);
  });
});
