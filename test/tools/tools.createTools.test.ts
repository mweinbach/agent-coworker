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

describe("createTools", () => {
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
      "ask",
      "AskUserQuestion",
      "todoWrite",
      "notebookEdit",
      "skill",
      "memory",
      "usage",
    ];
    for (const name of expected) {
      expect(tools).toHaveProperty(name);
    }
  });

  test("returns exactly 15 tools without child-agent control", async () => {
    const dir = await tmpDir();
    const tools = createTools(makeCtx(dir));
    expect(Object.keys(tools).length).toBe(14);
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
    expect(Object.keys(tools).length).toBe(13);
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
        "ask",
        "todoWrite",
        "skill",
        "memory",
        "usage",
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
    expect(names).not.toContain("notebookEdit");
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
