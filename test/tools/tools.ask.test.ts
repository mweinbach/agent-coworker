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

describe("ask tool", () => {
  test("exports a provider-compatible top-level object input schema", async () => {
    const dir = await tmpDir();
    const t: any = createAskTool(makeCtx(dir));
    const schema = z.toJSONSchema(t.inputSchema) as Record<string, unknown>;

    expect(schema.type).toBe("object");
  });

  test("calls askUser with question", async () => {
    const dir = await tmpDir();
    const askFn = mock(async (q: string) => "user answer");
    const ctx = makeCtx(dir);
    ctx.askUser = askFn;

    const t: any = createAskTool(ctx);
    const res: string = await t.execute({ question: "What color?" });
    expect(askFn).toHaveBeenCalledWith("What color?", undefined);
    expect(res).toBe("user answer");
  });

  test("returns user's answer", async () => {
    const dir = await tmpDir();
    const ctx = makeCtx(dir);
    ctx.askUser = async () => "42";

    const t: any = createAskTool(ctx);
    const res: string = await t.execute({ question: "How many?" });
    expect(res).toBe("42");
  });

  test("rejects empty single-question prompt", async () => {
    const dir = await tmpDir();
    const askFn = mock(async (_q: string) => "unused");
    const ctx = makeCtx(dir);
    ctx.askUser = askFn;

    const t: any = createAskTool(ctx);
    await expect(t.execute({ question: "" })).rejects.toThrow();
    expect(askFn).not.toHaveBeenCalled();
  });

  test("rejects whitespace-only structured question prompt", async () => {
    const dir = await tmpDir();
    const askFn = mock(async (_q: string) => "unused");
    const ctx = makeCtx(dir);
    ctx.askUser = askFn;

    const t: any = createAskTool(ctx);
    await expect(
      t.execute({
        questions: [{ question: "   " }],
      }),
    ).rejects.toThrow();
    expect(askFn).not.toHaveBeenCalled();
  });

  test("passes options when provided", async () => {
    const dir = await tmpDir();
    const askFn = mock(async (q: string, opts?: string[]) => "option B");
    const ctx = makeCtx(dir);
    ctx.askUser = askFn;

    const t: any = createAskTool(ctx);
    const res: string = await t.execute({
      question: "Pick one:",
      options: ["option A", "option B", "option C"],
    });
    expect(askFn).toHaveBeenCalledWith("Pick one:", ["option A", "option B", "option C"]);
    expect(res).toBe("option B");
  });

  test("handles empty string answer", async () => {
    const dir = await tmpDir();
    const ctx = makeCtx(dir);
    ctx.askUser = async () => "";

    const t: any = createAskTool(ctx);
    const res: string = await t.execute({ question: "Anything?" });
    expect(res).toBe("");
  });

  test("handles long answer", async () => {
    const dir = await tmpDir();
    const longAnswer = "a".repeat(5000);
    const ctx = makeCtx(dir);
    ctx.askUser = async () => longAnswer;

    const t: any = createAskTool(ctx);
    const res: string = await t.execute({ question: "Tell me everything" });
    expect(res).toBe(longAnswer);
  });

  test("supports AskUserQuestion structured payloads", async () => {
    const dir = await tmpDir();
    const askFn = mock(async (_q: string, _opts?: string[]) => "Organize & tidy");
    const ctx = makeCtx(dir);
    ctx.askUser = askFn;

    const t: any = createAskTool(ctx);
    const res: any = await t.execute({
      questions: [
        {
          question: "What kind of cleanup are you looking for?",
          header: "Cleanup scope",
          options: [
            { label: "Delete everything", description: "Remove all files" },
            { label: "Organize & tidy", description: "Keep files, improve layout" },
          ],
          multiSelect: false,
        },
      ],
    });

    expect(askFn).toHaveBeenCalledWith("What kind of cleanup are you looking for?", [
      "Delete everything",
      "Organize & tidy",
    ]);
    expect(res.answers).toEqual({
      "What kind of cleanup are you looking for?": "Organize & tidy",
    });
    expect(Array.isArray(res.questions)).toBeTrue();
  });

  test("asks each structured question in sequence", async () => {
    const dir = await tmpDir();
    const askFn = mock(async (q: string) => (q.includes("first") ? "A" : "B"));
    const ctx = makeCtx(dir);
    ctx.askUser = askFn;

    const t: any = createAskTool(ctx);
    const res: any = await t.execute({
      questions: [
        {
          question: "Pick first option?",
          header: "Q1",
          options: [
            { label: "A", description: "A" },
            { label: "B", description: "B" },
          ],
          multiSelect: false,
        },
        {
          question: "Pick second option?",
          header: "Q2",
          options: [
            { label: "A", description: "A" },
            { label: "B", description: "B" },
          ],
          multiSelect: false,
        },
      ],
    });

    expect(askFn).toHaveBeenCalledTimes(2);
    expect(res.answers).toEqual({
      "Pick first option?": "A",
      "Pick second option?": "B",
    });
  });
});

// ---------------------------------------------------------------------------
// todoWrite tool
// ---------------------------------------------------------------------------
