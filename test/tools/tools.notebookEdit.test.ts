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

describe("notebookEdit tool", () => {
  function makeNotebook(cells: Array<{ cell_type: string; source: string[] | string }>) {
    return JSON.stringify(
      {
        nbformat: 4,
        nbformat_minor: 2,
        metadata: {},
        cells: cells.map((c) => ({
          cell_type: c.cell_type,
          source: c.source,
          metadata: {},
          ...(c.cell_type === "code" ? { outputs: [], execution_count: null } : {}),
        })),
      },
      null,
      1,
    );
  }

  test("replaces cell source", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "nb.ipynb");
    await fs.writeFile(
      p,
      makeNotebook([
        { cell_type: "code", source: ["print('old')\n"] },
        { cell_type: "markdown", source: ["# Title\n"] },
      ]),
    );

    const t: any = createNotebookEditTool(makeCtx(dir));
    const res: string = await t.execute({
      notebookPath: p,
      cellIndex: 0,
      newSource: "print('new')",
      editMode: "replace",
    });
    expect(res).toContain("replace");

    const nb = JSON.parse(await fs.readFile(p, "utf-8"));
    expect(nb.cells[0].source).toEqual(["print('new')"]);
  });

  test("accepts string-form notebook cell sources", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "nb.ipynb");
    await fs.writeFile(
      p,
      makeNotebook([
        { cell_type: "code", source: "print('old')" },
        { cell_type: "markdown", source: ["# Title\n"] },
      ]),
    );

    const t: any = createNotebookEditTool(makeCtx(dir));
    await t.execute({
      notebookPath: p,
      cellIndex: 0,
      newSource: "print('new')",
      editMode: "replace",
    });

    const nb = JSON.parse(await fs.readFile(p, "utf-8"));
    expect(nb.cells[0].source).toEqual(["print('new')"]);
  });

  test("inserts new cell", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "nb.ipynb");
    await fs.writeFile(p, makeNotebook([{ cell_type: "code", source: ["x = 1\n"] }]));

    const t: any = createNotebookEditTool(makeCtx(dir));
    const res: string = await t.execute({
      notebookPath: p,
      cellIndex: 0,
      newSource: "# Inserted cell",
      cellType: "markdown",
      editMode: "insert",
    });
    expect(res).toContain("insert");

    const nb = JSON.parse(await fs.readFile(p, "utf-8"));
    expect(nb.cells.length).toBe(2);
    expect(nb.cells[0].cell_type).toBe("markdown");
    expect(nb.cells[0].source).toEqual(["# Inserted cell"]);
  });

  test("deletes cell", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "nb.ipynb");
    await fs.writeFile(
      p,
      makeNotebook([
        { cell_type: "code", source: ["a = 1\n"] },
        { cell_type: "code", source: ["b = 2\n"] },
        { cell_type: "code", source: ["c = 3\n"] },
      ]),
    );

    const t: any = createNotebookEditTool(makeCtx(dir));
    const res: string = await t.execute({
      notebookPath: p,
      cellIndex: 1,
      newSource: "",
      editMode: "delete",
    });
    expect(res).toContain("delete");

    const nb = JSON.parse(await fs.readFile(p, "utf-8"));
    expect(nb.cells.length).toBe(2);
    expect(nb.cells[1].source).toEqual(["c = 3\n"]);
  });

  test("throws on index out of range for replace", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "nb.ipynb");
    await fs.writeFile(p, makeNotebook([{ cell_type: "code", source: ["x = 1\n"] }]));

    const t: any = createNotebookEditTool(makeCtx(dir));
    await expect(
      t.execute({
        notebookPath: p,
        cellIndex: 5,
        newSource: "won't work",
        editMode: "replace",
      }),
    ).rejects.toThrow(/out of range/);
  });

  test("rejects non-.ipynb file paths", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "notebook.json");
    await fs.writeFile(p, makeNotebook([{ cell_type: "code", source: ["x = 1\n"] }]));

    const t: any = createNotebookEditTool(makeCtx(dir));
    await expect(
      t.execute({
        notebookPath: p,
        cellIndex: 0,
        newSource: "x = 2",
        editMode: "replace",
      }),
    ).rejects.toThrow(/expected a \.ipynb file/i);
  });

  test("rejects invalid notebook JSON", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "nb.ipynb");
    await fs.writeFile(p, "{ not-valid-json", "utf-8");

    const t: any = createNotebookEditTool(makeCtx(dir));
    await expect(
      t.execute({
        notebookPath: p,
        cellIndex: 0,
        newSource: "x = 2",
        editMode: "replace",
      }),
    ).rejects.toThrow(/Invalid notebook JSON/);
  });

  test("rejects path outside allowed dirs", async () => {
    const dir = await tmpDir();
    const outsideDir = await tmpDir();
    const p = path.join(outsideDir, "nb.ipynb");
    await fs.writeFile(p, makeNotebook([{ cell_type: "code", source: ["x = 1\n"] }]));

    const t: any = createNotebookEditTool(makeCtx(dir));
    await expect(
      t.execute({
        notebookPath: p,
        cellIndex: 0,
        newSource: "nope",
        editMode: "replace",
      }),
    ).rejects.toThrow(/blocked/i);
  });

  test("rejects notebook edits through symlink segment", async () => {
    if (process.platform === "win32") return;

    const dir = await tmpDir();
    const outsideDir = await tmpDir();
    const outsideNotebook = path.join(outsideDir, "outside.ipynb");
    await fs.writeFile(
      outsideNotebook,
      makeNotebook([{ cell_type: "code", source: ["print('x')\n"] }]),
    );

    const link = path.join(dir, "outside-link");
    await fs.symlink(outsideDir, link);

    const t: any = createNotebookEditTool(makeCtx(dir));
    await expect(
      t.execute({
        notebookPath: path.join(link, "outside.ipynb"),
        cellIndex: 0,
        newSource: "print('nope')",
        editMode: "replace",
      }),
    ).rejects.toThrow(/blocked/i);
  });

  test("insert creates code cell by default", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "nb.ipynb");
    await fs.writeFile(p, makeNotebook([{ cell_type: "code", source: ["x = 1\n"] }]));

    const t: any = createNotebookEditTool(makeCtx(dir));
    await t.execute({
      notebookPath: p,
      cellIndex: 1,
      newSource: "y = 2",
      editMode: "insert",
    });

    const nb = JSON.parse(await fs.readFile(p, "utf-8"));
    expect(nb.cells.length).toBe(2);
    expect(nb.cells[1].cell_type).toBe("code");
    expect(nb.cells[1].outputs).toEqual([]);
    expect(nb.cells[1].execution_count).toBeNull();
  });

  test("replaces cell type when cellType is provided in replace mode", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "nb.ipynb");
    await fs.writeFile(p, makeNotebook([{ cell_type: "code", source: ["x = 1\n"] }]));

    const t: any = createNotebookEditTool(makeCtx(dir));
    await t.execute({
      notebookPath: p,
      cellIndex: 0,
      newSource: "# Now markdown",
      cellType: "markdown",
      editMode: "replace",
    });

    const nb = JSON.parse(await fs.readFile(p, "utf-8"));
    expect(nb.cells[0].cell_type).toBe("markdown");
  });

  test("splits newSource into lines correctly", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "nb.ipynb");
    await fs.writeFile(p, makeNotebook([{ cell_type: "code", source: ["old\n"] }]));

    const t: any = createNotebookEditTool(makeCtx(dir));
    await t.execute({
      notebookPath: p,
      cellIndex: 0,
      newSource: "line1\nline2\nline3",
      editMode: "replace",
    });

    const nb = JSON.parse(await fs.readFile(p, "utf-8"));
    // Source lines should have \n except last
    expect(nb.cells[0].source).toEqual(["line1\n", "line2\n", "line3"]);
  });

  test("preserves notebook metadata on edit", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "nb.ipynb");
    const original = {
      nbformat: 4,
      nbformat_minor: 2,
      metadata: { kernelspec: { name: "python3" } },
      cells: [
        {
          cell_type: "code",
          source: ["x = 1\n"],
          metadata: {},
          outputs: [],
          execution_count: null,
        },
      ],
    };
    await fs.writeFile(p, JSON.stringify(original, null, 1));

    const t: any = createNotebookEditTool(makeCtx(dir));
    await t.execute({
      notebookPath: p,
      cellIndex: 0,
      newSource: "x = 2",
      editMode: "replace",
    });

    const nb = JSON.parse(await fs.readFile(p, "utf-8"));
    expect(nb.metadata.kernelspec.name).toBe("python3");
    expect(nb.nbformat).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// skill tool
// ---------------------------------------------------------------------------
