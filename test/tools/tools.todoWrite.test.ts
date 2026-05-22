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

describe("todoWrite tool", () => {
  test("updates todo state and returns summary", async () => {
    const dir = await tmpDir();
    const t: any = createTodoWriteTool(makeCtx(dir));
    const todos = [
      { content: "Do thing", status: "in_progress" as const, activeForm: "Doing thing" },
      { content: "Other task", status: "pending" as const, activeForm: "Other tasking" },
    ];

    const res: string = await t.execute({ todos });
    expect(res).toContain("Todo list updated");
    expect(res).toContain("[in_progress] Do thing");
    expect(res).toContain("[pending] Other task");
  });

  test("calls updateTodos callback when provided", async () => {
    const dir = await tmpDir();
    const updateFn = mock((_todos: any) => {});
    const ctx = makeCtx(dir);
    ctx.updateTodos = updateFn;

    const t: any = createTodoWriteTool(ctx);
    const todos = [{ content: "Step 1", status: "completed" as const, activeForm: "Stepping" }];
    await t.execute({ todos });
    expect(updateFn).toHaveBeenCalledTimes(1);
    expect(updateFn).toHaveBeenCalledWith(todos);
  });

  test("handles empty todo list", async () => {
    const dir = await tmpDir();
    const t: any = createTodoWriteTool(makeCtx(dir));
    const res: string = await t.execute({ todos: [] });
    expect(res).toContain("Todo list updated");
  });

  test("handles all status types", async () => {
    const dir = await tmpDir();
    const t: any = createTodoWriteTool(makeCtx(dir));
    const todos = [
      { content: "A", status: "pending" as const, activeForm: "Doing A" },
      { content: "B", status: "in_progress" as const, activeForm: "Doing B" },
      { content: "C", status: "completed" as const, activeForm: "Doing C" },
    ];
    const res: string = await t.execute({ todos });
    expect(res).toContain("[pending] A");
    expect(res).toContain("[in_progress] B");
    expect(res).toContain("[completed] C");
  });

  test("overwrites previous todos completely", async () => {
    const dir = await tmpDir();
    const t: any = createTodoWriteTool(makeCtx(dir));

    // First call
    await t.execute({
      todos: [{ content: "Old task", status: "pending" as const, activeForm: "Old tasking" }],
    });

    // Second call with different todos
    const res: string = await t.execute({
      todos: [{ content: "New task", status: "in_progress" as const, activeForm: "New tasking" }],
    });
    expect(res).toContain("[in_progress] New task");
    expect(res).not.toContain("Old task");
  });
});

// ---------------------------------------------------------------------------
// notebookEdit tool
// ---------------------------------------------------------------------------
