import { codexDynamicToolSpecs } from "../../src/runtime/codexAppServer/config";
import { filterToolsForCodexDynamicBoundary } from "../../src/tools/codexBoundary";
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
  type z,
} from "./tools.harness";

describe("createTools", () => {
  test("replaces chat todos with task directives only inside task mode", async () => {
    const dir = await tmpDir();
    const taskContext = {
      id: "task-1",
      title: "Task",
      objective: "Do the work",
      status: "working" as const,
      revision: 2,
      requirements: [],
      workItems: [],
      decisions: [],
      questions: [],
      blockers: [],
      artifacts: [],
      activeThreadId: "task-thread-1",
    };
    const tools = createTools(
      makeCtx(dir, {
        taskContext,
        applyTaskDirective: async () => {
          throw new Error("not invoked");
        },
      }),
    );

    expect(tools).toHaveProperty("taskUpdate");
    expect(tools).not.toHaveProperty("todoWrite");
    expect(tools).not.toHaveProperty("AskUserQuestion");

    const chatTools = createTools(makeCtx(dir));
    expect(chatTools).toHaveProperty("todoWrite");
    expect(chatTools).not.toHaveProperty("taskUpdate");
  });

  test("taskUpdate treats provider nulls as omitted optional fields", async () => {
    const dir = await tmpDir();
    const tools = createTools(
      makeCtx(dir, {
        taskContext: {
          id: "task-1",
          title: "Task",
          objective: "Do the work",
          status: "working",
          revision: 2,
          requirements: [],
          workItems: [],
          decisions: [],
          questions: [],
          blockers: [],
          artifacts: [],
          activeThreadId: "task-thread-1",
        },
        applyTaskDirective: async () => {
          throw new Error("not invoked");
        },
      }),
    );
    const taskUpdate = tools.taskUpdate as { inputSchema: z.ZodType };

    const parsed = taskUpdate.inputSchema.safeParse({
      type: "update_plan",
      idempotencyKey: "normalize-null-optionals",
      expectedRevision: 2,
      objective: null,
      requirements: null,
      workItems: [
        {
          id: "research",
          title: "Research",
          description: null,
          dependsOn: null,
          expectedOutputs: null,
        },
      ],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) throw parsed.error;
    expect(parsed.data).toEqual({
      type: "update_plan",
      idempotencyKey: "normalize-null-optionals",
      expectedRevision: 2,
      workItems: [{ id: "research", title: "Research" }],
    });
  });

  test("offers one-shot task creation only to ordinary root chats", async () => {
    const dir = await tmpDir();
    const createTask = mock(async () => ({
      workspaceDisposition: "existing_project" as const,
      task: {
        id: "task-created",
        workspacePath: dir,
        title: "Ship task mode",
        objective: "Make task promotion dependable.",
        context: "The user wants a work-managed mode.",
        sourceSessionId: "chat-1",
        creationOrigin: "chat_tool" as const,
        status: "working" as const,
        revision: 0,
        reviewRequired: true,
        createdAt: "2026-06-19T12:00:00.000Z",
        updatedAt: "2026-06-19T12:00:00.000Z",
        threadCount: 1,
        completedWorkItemCount: 0,
        totalWorkItemCount: 1,
        activeBlockerCount: 0,
        pendingQuestionCount: 0,
        blockingQuestionCount: 0,
        requirements: [],
        threads: [
          {
            id: "task-thread-1",
            taskId: "task-created",
            sessionId: "task-session-1",
            title: "Main",
            createdBy: "coordinator" as const,
            createdAt: "2026-06-19T12:00:00.000Z",
            updatedAt: "2026-06-19T12:00:00.000Z",
          },
        ],
        workItems: [],
        decisions: [],
        questions: [],
        artifacts: [],
        blockers: [],
        activity: [],
        latestCheckpoint: null,
      },
    }));
    const tools = createTools(makeCtx(dir, { sessionId: "chat-1", createTask }));
    const tool = tools.createTask as { execute: (input: unknown) => Promise<string> };

    const output = JSON.parse(
      await tool.execute({
        idempotencyKey: "create-task-1",
        title: "Ship task mode",
        objective: "Make task promotion dependable.",
        context: "The user wants a work-managed mode.",
        requirements: [
          { kind: "acceptance_criterion", text: "Source chat is locked while work is active." },
        ],
        workItems: [
          {
            key: "implement",
            title: "Implement promotion",
            dependsOn: null,
            expectedOutputs: ["Working task promotion"],
          },
        ],
      }),
    );

    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewRounds: 3,
        workItems: [expect.objectContaining({ key: "implement", dependsOn: [] })],
      }),
    );
    expect(output).toMatchObject({
      taskId: "task-created",
      taskThreadId: "task-session-1",
      modeChanged: true,
    });
    expect(createTools(makeCtx(dir, { createTask, agentRole: "worker" }))).not.toHaveProperty(
      "createTask",
    );
  });

  test("preserves one-off chat task promotion results on the dedicated createTask tool path", async () => {
    const dir = await tmpDir();
    const createTask = mock(async () => ({
      workspaceDisposition: "promote_one_off" as const,
      task: {
        id: "task-created",
        workspacePath: dir,
        title: "Promote chat task",
        objective: "Keep one-off chat promotion on the dedicated tool path.",
        context: "The source chat established the implementation constraints.",
        sourceSessionId: "chat-1",
        creationOrigin: "chat_tool" as const,
        status: "working" as const,
        revision: 0,
        reviewRequired: true,
        createdAt: "2026-06-20T12:00:00.000Z",
        updatedAt: "2026-06-20T12:00:00.000Z",
        threadCount: 1,
        completedWorkItemCount: 0,
        totalWorkItemCount: 1,
        activeBlockerCount: 0,
        pendingQuestionCount: 0,
        blockingQuestionCount: 0,
        requirements: [],
        threads: [
          {
            id: "task-thread-1",
            taskId: "task-created",
            sessionId: "task-session-1",
            title: "Main",
            createdBy: "coordinator" as const,
            createdAt: "2026-06-20T12:00:00.000Z",
            updatedAt: "2026-06-20T12:00:00.000Z",
          },
        ],
        workItems: [],
        decisions: [],
        questions: [],
        artifacts: [],
        blockers: [],
        activity: [],
        latestCheckpoint: null,
      },
    }));
    const tool = createTools(makeCtx(dir, { sessionId: "chat-1", createTask })).createTask as {
      execute: (input: unknown) => Promise<string>;
    };

    const output = JSON.parse(
      await tool.execute({
        idempotencyKey: "promote-one-off-task",
        title: "Promote chat task",
        objective: "Keep one-off chat promotion on the dedicated tool path.",
        context: "The source chat established the implementation constraints.",
        requirements: [
          { kind: "acceptance_criterion", text: "Task mode links back to the source chat." },
        ],
        workItems: [
          {
            key: "implement",
            title: "Implement promotion",
            dependsOn: null,
            expectedOutputs: ["Working task promotion"],
          },
        ],
      }),
    );

    expect(createTask).toHaveBeenCalledTimes(1);
    expect(output).toMatchObject({
      taskId: "task-created",
      taskThreadId: "task-session-1",
      workspaceDisposition: "promote_one_off",
      modeChanged: true,
    });
  });

  test("rejects incomplete or cyclic task creation plans", async () => {
    const dir = await tmpDir();
    const createTask = mock(async () => {
      throw new Error("must not execute");
    });
    const tool = createTools(makeCtx(dir, { createTask })).createTask as {
      execute: (input: unknown) => Promise<string>;
    };

    await expect(
      tool.execute({
        idempotencyKey: "invalid-task",
        title: "Invalid task",
        objective: "Missing an acceptance criterion.",
        context: "Incomplete.",
        requirements: [{ kind: "requirement", text: "Do the work." }],
        workItems: [
          { key: "a", title: "A", dependsOn: ["b"], expectedOutputs: ["A"] },
          { key: "b", title: "B", dependsOn: ["a"] },
        ],
      }),
    ).rejects.toThrow();
    expect(createTask).not.toHaveBeenCalled();
  });

  test("taskUpdate submits bundled input requests and exposes pause state", async () => {
    const dir = await tmpDir();
    const taskContext = {
      id: "task-1",
      title: "Task",
      objective: "Do the work",
      status: "working" as const,
      revision: 2,
      requirements: [],
      workItems: [],
      decisions: [],
      questions: [],
      blockers: [],
      artifacts: [],
      activeThreadId: "task-thread-1",
    };
    const applyTaskDirective = mock(async () => ({
      continuation: "pause_for_input" as const,
      task: {
        id: "task-1",
        workspacePath: dir,
        title: "Task",
        objective: "Do the work",
        status: "blocked" as const,
        revision: 3,
        reviewRequired: true,
        createdAt: "2026-06-18T12:00:00.000Z",
        updatedAt: "2026-06-18T12:00:00.000Z",
        threadCount: 1,
        completedWorkItemCount: 0,
        totalWorkItemCount: 1,
        activeBlockerCount: 0,
        pendingQuestionCount: 2,
        blockingQuestionCount: 1,
        requirements: [],
        threads: [],
        workItems: [],
        decisions: [],
        questions: [],
        artifacts: [],
        blockers: [],
        activity: [],
        latestCheckpoint: null,
      },
    }));
    const tools = createTools(makeCtx(dir, { taskContext, applyTaskDirective }));
    const taskUpdate = tools.taskUpdate as {
      execute: (input: unknown) => Promise<string>;
    };

    const output = JSON.parse(
      await taskUpdate.execute({
        type: "request_input",
        idempotencyKey: "input-1",
        expectedRevision: 2,
        questions: [
          {
            header: "Audience",
            question: "Who is the audience?",
            blocking: true,
            urgency: "now",
          },
          {
            header: "Format",
            question: "Which format should I use?",
            blocking: false,
            urgency: "before_delivery",
            defaultAction: "Use the normal analyst brief.",
          },
        ],
      }),
    );

    expect(applyTaskDirective).toHaveBeenCalledTimes(1);
    expect(applyTaskDirective.mock.calls[0]?.[0]).toMatchObject({
      type: "request_input",
      expectedRevision: 2,
    });
    expect(output).toMatchObject({
      status: "blocked",
      revision: 3,
      pendingQuestions: 2,
      blockingQuestions: 1,
      continuation: "pause_for_input",
    });
  });

  test("returns base tool names when child-agent control is unavailable", async () => {
    const dir = await tmpDir();
    const tools = createTools(makeCtx(dir));
    const expected = [
      "bash",
      "read",
      "write",
      "edit",
      "glob",
      "grep",
      "webFetch",
      "AskUserQuestion",
      "todoWrite",
      "skill",
      "memory",
    ];
    for (const name of expected) {
      expect(tools).toHaveProperty(name);
    }
  });

  test("returns exactly 11 tools without child-agent control", async () => {
    const dir = await tmpDir();
    const tools = createTools(makeCtx(dir));
    expect(Object.keys(tools).length).toBe(11);
  });

  test("omits bash for targetPath-scoped child agents", async () => {
    const dir = await tmpDir();
    const tools = createTools(makeCtx(dir, { agentTargetPaths: ["src/auth"] }));
    expect(tools).not.toHaveProperty("bash");
    expect(tools).toHaveProperty("read");
    expect(tools).toHaveProperty("write");
    expect(tools).toHaveProperty("edit");
    expect(tools).toHaveProperty("glob");
    expect(tools).toHaveProperty("grep");
  });

  test("advanced memory swaps the memory tool for advanced memory tools", async () => {
    const dir = await tmpDir();
    const tools = createTools(makeCtx(dir, { config: makeConfig(dir, { advancedMemory: true }) }));
    expect(tools).not.toHaveProperty("memory");
    expect(tools).toHaveProperty("recallMemory");
    expect(tools).toHaveProperty("readPastConversation");
    expect(tools).toHaveProperty("manageMemory");
  });

  test("omits memory tools for targetPath-scoped child agents", async () => {
    const dir = await tmpDir();
    const tools = createTools(
      makeCtx(dir, {
        agentTargetPaths: ["src/auth"],
        config: makeConfig(dir, { advancedMemory: true }),
      }),
    );
    expect(tools).not.toHaveProperty("memory");
    expect(tools).not.toHaveProperty("recallMemory");
    expect(tools).not.toHaveProperty("readPastConversation");
    expect(tools).not.toHaveProperty("manageMemory");
  });

  test("default (advanced memory off) keeps the legacy memory tool", async () => {
    const dir = await tmpDir();
    const tools = createTools(makeCtx(dir));
    expect(tools).toHaveProperty("memory");
    expect(tools).not.toHaveProperty("recallMemory");
    expect(tools).not.toHaveProperty("readPastConversation");
    expect(tools).not.toHaveProperty("manageMemory");
  });

  test("listSessionToolNames reflects advanced memory swap", () => {
    const advanced = listSessionToolNames({
      provider: "google",
      providerOptions: {},
      enableMemory: true,
      advancedMemory: true,
    });
    expect(advanced).toContain("recallMemory");
    expect(advanced).toContain("readPastConversation");
    expect(advanced).toContain("manageMemory");
    expect(advanced).not.toContain("memory");

    const legacy = listSessionToolNames({
      provider: "google",
      providerOptions: {},
      enableMemory: true,
    });
    expect(legacy).toContain("memory");
    expect(legacy).not.toContain("recallMemory");
    expect(legacy).not.toContain("manageMemory");
  });

  test("hides legacy webSearch for codex-cli by default", async () => {
    const dir = await tmpDir();
    const tools = createTools(
      makeCtx(dir, {
        config: makeConfig(dir, {
          provider: "codex-cli",
          model: "gpt-5.2",
          preferredChildModel: "gpt-5.2",
        }),
      }),
    );

    expect(tools).not.toHaveProperty("webSearch");
    expect(tools).toHaveProperty("webFetch");
  });

  test("keeps legacy webSearch for codex-cli when exa is selected", async () => {
    const dir = await tmpDir();
    const tools = createTools(
      makeCtx(dir, {
        config: makeConfig(dir, {
          provider: "codex-cli",
          model: "gpt-5.2",
          preferredChildModel: "gpt-5.2",
          providerOptions: {
            "codex-cli": {
              webSearchBackend: "exa",
            },
          },
        }),
      }),
    );

    expect(tools).toHaveProperty("webSearch");
  });

  test("exposes legacy codex-cli webSearch through the dynamic tool boundary", async () => {
    const dir = await tmpDir();
    const rawTools = createTools(
      makeCtx(dir, {
        config: makeConfig(dir, {
          provider: "codex-cli",
          model: "gpt-5.2",
          preferredChildModel: "gpt-5.2",
          providerOptions: {
            "codex-cli": {
              webSearchBackend: "exa",
            },
          },
        }),
      }),
    );

    const dynamicTools = filterToolsForCodexDynamicBoundary(rawTools);
    expect(dynamicTools).toHaveProperty("webSearch");
    expect(codexDynamicToolSpecs(dynamicTools).map((tool) => tool.name)).toContain("webSearch");
  });

  test("exposes manageMemory through the Codex dynamic tool boundary", async () => {
    const dir = await tmpDir();
    const rawTools = createTools(
      makeCtx(dir, {
        config: makeConfig(dir, {
          provider: "codex-cli",
          model: "gpt-5.2",
          preferredChildModel: "gpt-5.2",
          advancedMemory: true,
        }),
      }),
    );

    const dynamicTools = filterToolsForCodexDynamicBoundary(rawTools);
    expect(dynamicTools).toHaveProperty("manageMemory");
    expect(codexDynamicToolSpecs(dynamicTools).map((tool) => tool.name)).toContain("manageMemory");
  });

  test("listSessionToolNames reports legacy codex-cli webSearch when configured", () => {
    const names = listSessionToolNames({
      provider: "codex-cli",
      providerOptions: {
        "codex-cli": {
          webSearchBackend: "exa",
        },
      },
      enableMemory: true,
    });

    expect(names).toContain("webSearch");
    expect(names).not.toContain("bash");
    expect(names).not.toContain("webFetch");
  });

  test("replaces local webSearch but keeps webFetch for google when native web tools are enabled", async () => {
    const dir = await tmpDir();
    const tools = createTools(
      makeCtx(dir, {
        config: makeConfig(dir, {
          provider: "google",
          model: "gemini-3-flash-preview",
          preferredChildModel: "gemini-3-flash-preview",
          providerOptions: {
            google: {
              nativeWebSearch: true,
            },
          },
        }),
      }),
    );

    expect(tools).not.toHaveProperty("webSearch");
    expect(tools).toHaveProperty("webFetch");
  });

  test("keeps local webSearch and webFetch for google when native web search is explicitly disabled", async () => {
    const dir = await tmpDir();
    const tools = createTools(
      makeCtx(dir, {
        config: makeConfig(dir, {
          provider: "google",
          model: "gemini-3-flash-preview",
          preferredChildModel: "gemini-3-flash-preview",
          providerOptions: {
            google: {
              nativeWebSearch: false,
            },
          },
        }),
      }),
    );

    expect(tools).toHaveProperty("webSearch");
    expect(tools).toHaveProperty("webFetch");
  });

  test("omits memory tool when enableMemory is false", async () => {
    const dir = await tmpDir();
    const tools = createTools(makeCtx(dir, { config: makeConfig(dir, { enableMemory: false }) }));
    expect(tools).not.toHaveProperty("memory");
    expect(Object.keys(tools).length).toBe(10);
  });

  test("includes a2ui for non-google providers when enabled", async () => {
    await withEnv("COWORK_EXPERIMENTAL_A2UI", "1", async () => {
      const dir = await tmpDir();
      const tools = createTools(
        makeCtx(dir, {
          config: makeConfig(dir, {
            provider: "openai",
            model: "gpt-5.2",
            preferredChildModel: "gpt-5.2",
            enableA2ui: true,
          }),
          applyA2uiEnvelope: () => ({ ok: true, surfaceId: "surface-1", change: "created" }),
        }),
      );

      expect(tools).toHaveProperty("a2ui");
    });
  });

  test("includes a2ui for google when enabled", async () => {
    await withEnv("COWORK_EXPERIMENTAL_A2UI", "1", async () => {
      const dir = await tmpDir();
      const tools = createTools(
        makeCtx(dir, {
          config: makeConfig(dir, {
            provider: "google",
            model: "gemini-3-flash-preview",
            preferredChildModel: "gemini-3-flash-preview",
            enableA2ui: true,
          }),
          applyA2uiEnvelope: () => ({ ok: true, surfaceId: "surface-1", change: "created" }),
        }),
      );

      expect(tools).toHaveProperty("a2ui");
    });
  });

  test("omits a2ui when explicitly disabled", async () => {
    const dir = await tmpDir();
    const tools = createTools(
      makeCtx(dir, {
        config: makeConfig(dir, {
          provider: "openai",
          model: "gpt-5.2",
          preferredChildModel: "gpt-5.2",
          enableA2ui: false,
        }),
        applyA2uiEnvelope: () => ({ ok: true, surfaceId: "surface-1", change: "created" }),
      }),
    );

    expect(tools).not.toHaveProperty("a2ui");
  });

  test("listSessionToolNames includes a2ui when the experiment is enabled", async () => {
    await withEnv("COWORK_EXPERIMENTAL_A2UI", "1", async () => {
      const dir = await tmpDir();
      const names = listSessionToolNames(
        makeConfig(dir, {
          enableA2ui: true,
        }),
      );

      expect(names).toContain("a2ui");
    });
  });

  test("listSessionToolNames includes root-session agent controls when requested", () => {
    const names = listSessionToolNames(
      {
        provider: "google",
        providerOptions: {
          google: {
            nativeWebSearch: true,
          },
        },
        enableMemory: false,
      },
      { includeAgentControl: true },
    );

    expect(names).toEqual(
      expect.arrayContaining([
        "spawnAgent",
        "listAgents",
        "sendAgentInput",
        "waitForAgent",
        "inspectAgent",
        "resumeAgent",
        "closeAgent",
      ]),
    );
    expect(names).not.toContain("memory");
    expect(names).not.toContain("webSearch");
  });

  test("listSessionToolNames reports the Codex hybrid dynamic-tool boundary", () => {
    const names = listSessionToolNames(
      {
        provider: "codex-cli",
        providerOptions: {
          "codex-cli": {
            webSearchBackend: "native",
          },
        },
        enableMemory: true,
      },
      { includeAgentControl: true },
    );

    expect(names).toEqual(
      expect.arrayContaining([
        "AskUserQuestion",
        "todoWrite",
        "skill",
        "memory",
        "spawnAgent",
        "listAgents",
        "sendAgentInput",
        "waitForAgent",
        "inspectAgent",
        "resumeAgent",
        "closeAgent",
      ]),
    );
    expect(names).not.toContain("bash");
    expect(names).not.toContain("read");
    expect(names).not.toContain("write");
    expect(names).not.toContain("edit");
    expect(names).not.toContain("glob");
    expect(names).not.toContain("grep");
    expect(names).not.toContain("webSearch");
    expect(names).not.toContain("webFetch");
    expect(names).not.toContain("usage");
  });

  test("omits child-agent lifecycle tools when child-agent control is unavailable", async () => {
    const dir = await tmpDir();
    const tools = createTools(makeCtx(dir));
    expect(tools).not.toHaveProperty("spawnAgent");
    expect(tools).not.toHaveProperty("listAgents");
    expect(tools).not.toHaveProperty("sendAgentInput");
    expect(tools).not.toHaveProperty("waitForAgent");
    expect(tools).not.toHaveProperty("inspectAgent");
    expect(tools).not.toHaveProperty("resumeAgent");
    expect(tools).not.toHaveProperty("closeAgent");
  });

  test("keeps bash but omits write tools for reviewer role", async () => {
    const dir = await tmpDir();
    const tools = createTools(
      makeCtx(dir, {
        agentRole: "reviewer",
        shellPolicy: "no_project_write",
      }),
    );

    expect(tools).toHaveProperty("bash");
    expect(tools).toHaveProperty("read");
    expect(tools).toHaveProperty("glob");
    expect(tools).toHaveProperty("grep");
    expect(tools).not.toHaveProperty("write");
    expect(tools).not.toHaveProperty("edit");
  });

  test("returns an executable webSearch tool for opencode-go", async () => {
    const dir = await tmpDir();
    const tools = createTools(
      makeCtx(dir, {
        config: makeConfig(dir, {
          provider: "opencode-go",
          model: "glm-5",
          preferredChildModel: "glm-5",
        }),
      }),
    );

    expect((tools.webSearch as any).type).toBeUndefined();
    expect(typeof (tools.webSearch as any).execute).toBe("function");
    expect((tools.webSearch as any).description).toContain("EXA_API_KEY");
  });

  test("returns an executable webSearch tool for baseten", async () => {
    const dir = await tmpDir();
    const tools = createTools(
      makeCtx(dir, {
        config: makeConfig(dir, {
          provider: "baseten",
          model: "moonshotai/Kimi-K2.5",
          preferredChildModel: "moonshotai/Kimi-K2.5",
        }),
      }),
    );

    expect((tools.webSearch as any).type).toBeUndefined();
    expect(typeof (tools.webSearch as any).execute).toBe("function");
    expect((tools.webSearch as any).description).toContain("EXA_API_KEY");
  });

  test("returns an executable webSearch tool for together", async () => {
    const dir = await tmpDir();
    const tools = createTools(
      makeCtx(dir, {
        config: makeConfig(dir, {
          provider: "together",
          model: "moonshotai/Kimi-K2.5",
          preferredChildModel: "moonshotai/Kimi-K2.5",
        }),
      }),
    );

    expect((tools.webSearch as any).type).toBeUndefined();
    expect(typeof (tools.webSearch as any).execute).toBe("function");
    expect((tools.webSearch as any).description).toContain("EXA_API_KEY");
  });

  test("returns an executable webSearch tool for nvidia", async () => {
    const dir = await tmpDir();
    const tools = createTools(
      makeCtx(dir, {
        config: makeConfig(dir, {
          provider: "nvidia",
          model: "nvidia/nemotron-3-super-120b-a12b",
          preferredChildModel: "nvidia/nemotron-3-super-120b-a12b",
        }),
      }),
    );

    expect((tools.webSearch as any).type).toBeUndefined();
    expect(typeof (tools.webSearch as any).execute).toBe("function");
    expect((tools.webSearch as any).description).toContain("EXA_API_KEY");
  });

  test("returns an executable webSearch tool for minimax", async () => {
    const dir = await tmpDir();
    const tools = createTools(
      makeCtx(dir, {
        config: makeConfig(dir, {
          provider: "minimax",
          model: "MiniMax-M3",
          preferredChildModel: "MiniMax-M3",
        }),
      }),
    );

    expect((tools.webSearch as any).type).toBeUndefined();
    expect(typeof (tools.webSearch as any).execute).toBe("function");
    expect((tools.webSearch as any).description).toContain("EXA_API_KEY");
  });

  test("each tool is executable or provider-native", async () => {
    const dir = await tmpDir();
    const tools = createTools(makeCtx(dir));
    for (const [name, tool] of Object.entries(tools)) {
      if (name === "webSearch") {
        expect(
          (tool as any).type === "provider" || typeof (tool as any).execute === "function",
        ).toBe(true);
        continue;
      }
      expect(typeof (tool as any).execute).toBe("function");
    }
  });

  test("does not include unknown tool names", async () => {
    const dir = await tmpDir();
    const tools = createTools(makeCtx(dir));
    expect(tools).not.toHaveProperty("unknown");
    expect(tools).not.toHaveProperty("foo");
  });

  test("exposes persistent agent tools when control handlers exist", async () => {
    const dir = await tmpDir();
    const spawn = mock(async () => ({
      agentId: "child",
      parentSessionId: "root",
      role: "worker" as const,
      mode: "collaborative" as const,
      depth: 1,
      effectiveModel: "gpt-5.2",
      provider: "openai" as const,
      title: "child",
      createdAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:00:00.000Z",
      lifecycleState: "active" as const,
      executionState: "running" as const,
      busy: true,
    }));
    const list = mock(async () => [
      {
        agentId: "child",
        parentSessionId: "root",
        role: "worker" as const,
        mode: "collaborative" as const,
        depth: 1,
        effectiveModel: "gpt-5.2",
        provider: "openai" as const,
        title: "child",
        createdAt: "2026-03-08T00:00:00.000Z",
        updatedAt: "2026-03-08T00:00:00.000Z",
        lifecycleState: "closed" as const,
        executionState: "idle" as const,
        busy: false,
      },
    ]);
    const sendInput = mock(async () => ({ queued: true }));
    const wait = mock(async () => ({
      timedOut: false,
      mode: "all" as const,
      agents: [
        {
          agentId: "child",
          parentSessionId: "root",
          role: "worker" as const,
          mode: "collaborative" as const,
          depth: 1,
          effectiveModel: "gpt-5.2",
          provider: "openai" as const,
          title: "child",
          createdAt: "2026-03-08T00:00:00.000Z",
          updatedAt: "2026-03-08T00:00:00.000Z",
          lifecycleState: "active" as const,
          executionState: "completed" as const,
          busy: false,
          lastMessagePreview: "done",
        },
      ],
      readyAgentIds: ["child"],
    }));
    const inspect = mock(async () => ({
      agent: {
        agentId: "child",
        parentSessionId: "root",
        role: "worker" as const,
        mode: "collaborative" as const,
        depth: 1,
        effectiveModel: "gpt-5.2",
        provider: "openai" as const,
        title: "child",
        createdAt: "2026-03-08T00:00:00.000Z",
        updatedAt: "2026-03-08T00:00:00.000Z",
        lifecycleState: "active" as const,
        executionState: "completed" as const,
        busy: false,
        lastMessagePreview: "done",
      },
      latestAssistantText:
        'Done.\n\n<agent_report>{"status":"completed","summary":"Finished"}</agent_report>',
      parsedReport: {
        status: "completed" as const,
        summary: "Finished",
      },
      reportRequired: true,
      reportFound: true,
      reportValid: true,
      reportBlockCount: 1,
      reportDiagnostic: null,
      sessionUsage: null,
      lastTurnUsage: null,
    }));
    const resume = mock(async () => ({
      agentId: "child",
      parentSessionId: "root",
      role: "worker" as const,
      mode: "collaborative" as const,
      depth: 1,
      effectiveModel: "gpt-5.2",
      provider: "openai" as const,
      title: "child",
      createdAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:00:00.000Z",
      lifecycleState: "active" as const,
      executionState: "idle" as const,
      busy: false,
    }));
    const close = mock(async () => ({
      agentId: "child",
      parentSessionId: "root",
      role: "worker" as const,
      mode: "collaborative" as const,
      depth: 1,
      effectiveModel: "gpt-5.2",
      provider: "openai" as const,
      title: "child",
      createdAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:00:00.000Z",
      lifecycleState: "closed" as const,
      executionState: "idle" as const,
      busy: false,
    }));

    const ctx = makeCtx(dir, {
      agentControl: {
        spawn,
        list,
        sendInput,
        wait,
        inspect,
        resume,
        close,
      },
    });
    const tools = createTools(ctx);

    expect(tools.spawnAgent).toBeDefined();
    const spawnTool: any = tools.spawnAgent;
    const listTool: any = tools.listAgents;
    const sendTool: any = tools.sendAgentInput;
    const waitTool: any = tools.waitForAgent;
    const inspectTool: any = tools.inspectAgent;
    const resumeTool: any = tools.resumeAgent;
    const closeTool: any = tools.closeAgent;

    await expect(spawnTool.execute({ message: "Inspect" })).resolves.toMatchObject({
      agentId: "child",
    });
    expect(spawn).toHaveBeenCalled();

    await expect(listTool.execute({})).resolves.toHaveLength(1);
    await expect(sendTool.execute({ agentId: "child", message: "next" })).resolves.toEqual({
      agentId: "child",
      queued: true,
    });
    await expect(
      waitTool.execute({ agentIds: ["child"], timeoutMs: 10, mode: "all" }),
    ).resolves.toEqual({
      timedOut: false,
      mode: "all",
      agents: [
        expect.objectContaining({
          agentId: "child",
          executionState: "completed",
          busy: false,
          lastMessagePreview: "done",
        }),
      ],
      readyAgentIds: ["child"],
    });
    await expect(inspectTool.execute({ agentId: "child" })).resolves.toEqual(
      expect.objectContaining({
        agent: expect.objectContaining({ agentId: "child" }),
        latestAssistantText: expect.stringContaining("Done."),
        parsedReport: expect.objectContaining({ status: "completed", summary: "Finished" }),
      }),
    );
    await expect(resumeTool.execute({ agentId: "child" })).resolves.toMatchObject({
      agentId: "child",
      lifecycleState: "active",
    });
    await expect(closeTool.execute({ agentId: "child" })).resolves.toMatchObject({
      agentId: "child",
      lifecycleState: "closed",
    });
  });
});
