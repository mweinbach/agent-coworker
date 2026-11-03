import { describe, expect, mock, spyOn, test } from "bun:test";
import http from "node:http";
import path from "node:path";

import { z } from "zod";
import {
  buildCodexHarnessSmokeRuns,
  buildMixedRuns,
  selectRawLoopRuns,
} from "../packages/harness/src/rawLoopScenarios";
import {
  assertRawLoopToolRequirements,
  buildRawLoopBudgetSummary,
  countObservedLoopSteps,
  wrapToolsWithTracing,
} from "../packages/harness/src/rawLoopTools";
import { serializeRawLoopTrace } from "../packages/harness/src/rawLoopUtils";
import { validateWithOptionalRepair } from "../packages/harness/src/rawLoopValidation";
import {
  applyRawLoopToolSurfaceConfig,
  buildRawLoopHarnessContext,
  buildRawLoopServerEnv,
  runRawLoopTurnViaServer,
} from "../packages/harness/src/run_raw_agent_loops";
import type { AgentConfig } from "../src/types";
import { startRustTestServer } from "./helpers/rustServerHarness";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const dir = "/tmp/raw-loop-agent-control";
  return {
    provider: "openai",
    model: "gpt-5.4",
    preferredChildModel: "gpt-5-mini",
    workingDirectory: dir,
    outputDirectory: path.join(dir, "output"),
    uploadsDirectory: path.join(dir, "uploads"),
    userName: "",
    knowledgeCutoff: "unknown",
    projectCoworkDir: path.join(dir, ".cowork"),
    userCoworkDir: path.join(dir, ".agent-user"),
    builtInDir: dir,
    builtInConfigDir: path.join(dir, "config"),
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
    ...overrides,
  };
}

describe("raw loop trace serialization", () => {
  test("omits configuration credentials while preserving intentional trace payloads", () => {
    const config = makeConfig({
      observabilityEnabled: true,
      observability: {
        provider: "langfuse",
        baseUrl: "https://telemetry.example.test",
        otelEndpoint: "https://telemetry.example.test/api/public/otel/v1/traces",
        publicKey: "dummy-public-key",
        secretKey: "dummy-langfuse-secret",
        recordInputs: true,
        recordOutputs: true,
      },
      providerOptions: {
        vendor: {
          apiKey: "dummy-provider-secret",
          headers: {
            Authorization: "Bearer dummy-authorization-secret",
            Cookie: "session=dummy-cookie-secret",
            "x-custom": "Bearer dummy-custom-secret",
          },
          nested: [{ credentials: { password: "dummy-password-secret" } }],
          endpoint: "https://demo:dummy-url-password@provider.example.test",
          maxOutputTokens: 1024,
        },
      },
    });
    const serialized = serializeRawLoopTrace({
      config,
      userPrompt: "Intentional research prompt",
      result: { text: "Intentional raw response" },
    });

    for (const secret of [
      "dummy-langfuse-secret",
      "dummy-provider-secret",
      "dummy-authorization-secret",
      "dummy-cookie-secret",
      "dummy-custom-secret",
      "dummy-password-secret",
      "dummy-url-password",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    const parsed = JSON.parse(serialized);
    expect(parsed.userPrompt).toBe("Intentional research prompt");
    expect(parsed.result.text).toBe("Intentional raw response");
    expect(parsed.config.model).toBe(config.model);
    expect(parsed.config.observability.recordInputs).toBe(true);
    expect(config.observability?.secretKey).toBe("dummy-langfuse-secret");
    expect(config.providerOptions?.vendor.apiKey).toBe("dummy-provider-secret");
  });
});

describe("raw loop scenario selection", () => {
  test.each([
    ["mixed", 11],
    ["codex-gpt-5.4-smoke", 1],
  ] as const)("constructs only %s contracts", (scenario, count) => {
    const objects = spyOn(z, "object");
    try {
      const runs = selectRawLoopRuns({ scenario, onlyRunIds: [], onlyModels: [] });
      expect(runs).toHaveLength(count);
      expect(objects).toHaveBeenCalledTimes(count);
      for (const run of runs) {
        expect(run.finalContract?.format).toBe("json");
        expect(
          run.prompt({ runId: run.id, runDir: "/tmp/raw-loop", repoDir: "/tmp/repo" }),
        ).toContain('"end": "<<END_RUN>>"');
      }
    } finally {
      objects.mockRestore();
    }
  });

  test("intersects run and model filters without changing scenario order or contracts", () => {
    const mixed = buildMixedRuns();
    const selected = selectRawLoopRuns({
      scenario: "mixed",
      onlyRunIds: ["run-03", "run-02"],
      onlyModels: [],
    });
    expect(selected.map((run) => run.id)).toEqual(["run-02", "run-03"]);
    const model = selected[0]!.model;
    const filtered = selectRawLoopRuns({
      scenario: "mixed",
      onlyRunIds: ["run-03", "run-02"],
      onlyModels: [model],
    });
    expect(filtered.map((run) => run.id)).toEqual(["run-02"]);
    for (const run of selected) {
      const original = mixed.find((candidate) => candidate.id === run.id)!;
      const context = { runId: run.id, runDir: "/tmp/raw-loop", repoDir: "/tmp/repo" };
      expect(run.prompt(context)).toBe(original.prompt(context));
      expect(run.finalContract?.artifactAssertions).toEqual(
        original.finalContract?.artifactAssertions,
      );
      expect(z.toJSONSchema(run.finalContract!.schema)).toEqual(
        z.toJSONSchema(original.finalContract!.schema),
      );
      expect(run.maxAttempts).toBe(original.maxAttempts);
      expect(run.maxSteps).toBe(original.maxSteps);
    }
  });

  test("preserves the empty selection diagnostic", () => {
    expect(() =>
      selectRawLoopRuns({ scenario: "mixed", onlyRunIds: ["not-a-run"], onlyModels: [] }),
    ).toThrow(
      'No runs selected for scenario="mixed". Try --only-run/--only-model values that exist in this scenario.',
    );
  });
});

describe("raw loop tool evidence", () => {
  const trace = (toolName: string) => ({
    scope: "tool-call",
    step: { type: "tool-call", toolName },
  });

  test("scans each evidence source once", () => {
    const steps = [trace("write"), trace("skill")];
    const logs = ["tool> todoWrite {}", "tool> skill {}", "tool> bash {}"];
    const traceScans = mock(steps[Symbol.iterator].bind(steps));
    const logScans = mock(logs[Symbol.iterator].bind(logs));
    steps[Symbol.iterator] = traceScans;
    logs[Symbol.iterator] = logScans;

    assertRawLoopToolRequirements({ requiredToolCalls: ["write", "bash"] }, steps, logs);

    expect(traceScans).toHaveBeenCalledTimes(1);
    expect(logScans).toHaveBeenCalledTimes(1);
  });

  test("uses nested trace evidence when logs contain no tool calls", () => {
    assertRawLoopToolRequirements(
      { requiredToolCalls: ["skill"] },
      [{ scope: "nested", step: { content: [trace("todoWrite").step, trace("skill").step] } }],
      ["tool< skill result", "ordinary log"],
    );
  });

  test("reports missing tools once, in requirement order", () => {
    expect(() =>
      assertRawLoopToolRequirements(
        { requiredToolCalls: ["write", "read", "write"] },
        [],
        ["tool> bash {}"],
      ),
    ).toThrow("Missing required tool call(s): write, read, write");
  });

  test("does not scan evidence when no requirements are configured", () => {
    const steps = [trace("write")];
    const logs = ["tool> write {}"];
    const traceScans = mock(steps[Symbol.iterator].bind(steps));
    const logScans = mock(logs[Symbol.iterator].bind(logs));
    steps[Symbol.iterator] = traceScans;
    logs[Symbol.iterator] = logScans;
    assertRawLoopToolRequirements({ requiredToolCalls: [] }, steps, logs);
    expect(traceScans).not.toHaveBeenCalled();
    expect(logScans).not.toHaveBeenCalled();
  });

  test.each(["successful", "failed"] as const)(
    "recomputes log-only budgets after %s repair",
    async (outcome) => {
      const fails = outcome === "failed";
      const logs = ["tool> bash {}", "tool> bash {}", "tool< bash result", "ordinary log"];
      assertRawLoopToolRequirements({ requiredToolCalls: ["write"] }, [trace("write")], logs);
      expect(buildRawLoopBudgetSummary(logs, 2, 0)).toEqual({
        toolCalls: 2,
        bashCalls: 2,
        webCalls: 0,
        spawnedAgents: 0,
        totalSteps: 2,
        repairPassCount: 0,
      });
      const result = await validateWithOptionalRepair({
        finalText: "invalid",
        runDir: "/tmp/raw-loop",
        trace: {},
        strictMode: false,
        repairFinalOutput: async () => {
          await Promise.resolve();
          logs.push("tool> webFetch {}", "tool> spawnAgent {}");
          if (fails) throw new Error("repair failed");
          return { finalText: "<<END_RUN>>" };
        },
      });
      expect(result.repairAttempted).toBe(true);
      expect(result.repairSucceeded).toBe(!fails);
      expect(buildRawLoopBudgetSummary(logs, 3, 1)).toEqual({
        toolCalls: 4,
        bashCalls: 2,
        webCalls: 1,
        spawnedAgents: 1,
        totalSteps: 3,
        repairPassCount: 1,
      });
    },
  );
});

describe("raw loop scripted spawnAgent prompts", () => {
  test("use the current spawnAgent handle contract", () => {
    const mixedRun = buildMixedRuns().find((run) => run.id === "run-08");
    expect(mixedRun).toBeDefined();

    const mixedPrompt = mixedRun!.prompt({
      runId: mixedRun!.id,
      runDir: "/tmp/raw-loop",
      repoDir: "/tmp/repo",
    });

    expect(mixedRun!.requiredToolCalls).toEqual(
      expect.arrayContaining(["spawnAgent", "waitForAgent"]),
    );

    expect(mixedPrompt).toContain('role="research" and message:');
    expect(mixedPrompt).toContain("waitForAgent");
    expect(mixedPrompt).toContain("erroredAgentIds");
    expect(mixedPrompt).toContain("lastMessagePreview JSON");
    expect(mixedPrompt).not.toContain(" task:");
  });

  test("use platform-specific shell commands in scripted bash steps", () => {
    const mixedRuns = buildMixedRuns("win32");
    const notesRun = mixedRuns.find((run) => run.id === "run-02");
    const workbookRun = mixedRuns.find((run) => run.id === "run-03");
    const quickRefRun = mixedRuns.find((run) => run.id === "run-09");

    expect(notesRun).toBeDefined();
    expect(workbookRun).toBeDefined();
    expect(quickRefRun).toBeDefined();

    const notesPrompt = notesRun!.prompt({
      runId: notesRun!.id,
      runDir: "C:/raw-loop",
      repoDir: "C:/repo",
    });
    const workbookPrompt = workbookRun!.prompt({
      runId: workbookRun!.id,
      runDir: "C:/raw-loop",
      repoDir: "C:/repo",
    });
    const quickRefPrompt = quickRefRun!.prompt({
      runId: quickRefRun!.id,
      runDir: "C:/raw-loop",
      repoDir: "C:/repo",
    });

    expect(notesPrompt).toContain("Use bash to run: (Get-Location).Path");
    expect(notesPrompt).toContain("Use bash to run: Get-ChildItem -Force");
    expect(workbookPrompt).toContain("Use bash to run: python 'build_amortization.py'");
    expect(quickRefPrompt).toContain(
      "Use bash to run: (Get-Content 'ws_quickref.md' | Measure-Object -Line).Lines",
    );

    for (const prompt of [notesPrompt, workbookPrompt, quickRefPrompt]) {
      expect(prompt).not.toContain("python3 build_");
      expect(prompt).not.toContain("ls -la");
      expect(prompt).not.toContain("wc -l ws_quickref.md");
      expect(prompt).not.toContain("Use bash to run: pwd");
      expect(prompt).not.toContain("Use bash to run command: pwd");
    }
  });

  test("standardize scripted private final outputs on JSON", () => {
    const runs = [...buildMixedRuns(), ...buildCodexHarnessSmokeRuns()];

    for (const run of runs) {
      const prompt = run.prompt({ runId: run.id, runDir: "/tmp/raw-loop", repoDir: "/tmp/repo" });
      expect(run.finalContract?.format).toBe("json");
      expect(prompt).toContain('"end": "<<END_RUN>>"');
      expect(prompt).not.toContain("Final response must be exactly");
    }
  });
});

describe("raw loop tool surface and Rust server execution", () => {
  test("forces the local web-search and memory configuration flags for Google runs", () => {
    const config = makeConfig({
      provider: "google",
      providerOptions: { google: { nativeWebSearch: true } },
      advancedMemory: true,
      tasksEnabled: true,
      workflowsEnabled: true,
      enableMemory: false,
    });

    applyRawLoopToolSurfaceConfig(config, "google");

    expect(config.providerOptions).toMatchObject({ google: { nativeWebSearch: false } });
    expect(config.enableMemory).toBe(true);
    expect(config.advancedMemory).toBe(false);
    expect(config.tasksEnabled).toBe(false);
    expect(config.workflowsEnabled).toBe(false);
  });

  test("buildRawLoopHarnessContext returns a stable default contract", () => {
    const harnessContext = buildRawLoopHarnessContext(
      {
        id: "run-01",
        provider: "openai",
        model: "gpt-5.4",
      },
      "mixed",
      {
        runId: "run-01",
        runDir: "/tmp/run-01",
        repoDir: "/tmp/repo",
      },
      "2026-03-20T12:00:00.000Z",
    );

    expect(harnessContext).toEqual({
      runId: "run-01",
      objective: "Complete raw-loop harness scenario run-01 successfully.",
      acceptanceCriteria: [
        "Satisfy the task requirements expressed in the run prompt.",
        "Produce the required final response contract for this scenario.",
        "Keep required artifacts inside the run directory.",
      ],
      constraints: [
        "Treat this harness context as run intent, not as a safety override.",
        "Do not change required artifact names or output formats unless the prompt requires it.",
        "Use only the necessary tools to complete the scenario.",
      ],
      metadata: {
        model: "gpt-5.4",
        provider: "openai",
        scenario: "mixed",
      },
      updatedAt: "2026-03-20T12:00:00.000Z",
    });
  });

  test("countObservedLoopSteps derives loop turns from step numbers", () => {
    expect(countObservedLoopSteps([])).toBe(0);
    expect(countObservedLoopSteps([1])).toBe(1);
    expect(countObservedLoopSteps([1, 2, 3])).toBe(3);
  });

  test("buildRawLoopBudgetSummary uses actual loop turn count instead of traced entry count", () => {
    expect(buildRawLoopBudgetSummary(["tool> bash {}", "tool> read {}"], 3, 1)).toEqual({
      toolCalls: 2,
      bashCalls: 1,
      webCalls: 0,
      spawnedAgents: 0,
      totalSteps: 3,
      repairPassCount: 1,
    });
  });

  test("traces guarded tools and enforces prerequisite order", async () => {
    const steps: Array<{ scope: string; step: unknown }> = [];
    const tools = wrapToolsWithTracing(
      {
        todoWrite: { execute: async (input) => ({ ok: true, input }) },
        glob: { execute: async (input) => ({ files: ["note.txt"], input }) },
      },
      steps,
      { requiredToolName: "todoWrite", guardedToolNames: ["glob"] },
    );

    await expect(tools.glob!.execute!({ pattern: "*.txt" })).rejects.toThrow(
      'Tool "todoWrite" must be called before "glob".',
    );
    expect(steps).toHaveLength(0);

    await tools.todoWrite!.execute!({ todos: [] });
    await tools.glob!.execute!({ pattern: "*.txt" });

    expect(
      steps
        .filter((entry) => entry.scope === "tool-call")
        .map((entry) => (entry.step as { toolName: string }).toolName),
    ).toEqual(["todoWrite", "glob"]);
  });

  test("pins the spawned server repo root and disables tasks and workflows via env", () => {
    const env = buildRawLoopServerEnv({
      PATH: "/usr/bin",
      COWORK_ENABLE_TASKS: "1",
      COWORK_ENABLE_WORKFLOWS: "true",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.COWORK_REPO_ROOT).toBe(path.resolve(import.meta.dir, ".."));
    expect(env.COWORK_ENABLE_TASKS).toBe("0");
    expect(env.COWORK_ENABLE_WORKFLOWS).toBe("0");
    expect(env.COWORK_DESKTOP_PARENT_MANAGED).toBe("1");
    expect(env.COWORK_DISABLE_BUILTIN_SKILLS).toBe("1");
    expect(buildRawLoopServerEnv({ COWORK_REPO_ROOT: " /custom/root " }).COWORK_REPO_ROOT).toBe(
      "/custom/root",
    );
  });

  test("forwards maxSteps and rejects the turn when the server socket closes mid-turn", async () => {
    const configSets: unknown[] = [];
    const fakeServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        return srv.upgrade(req) ? undefined : new Response("upgrade required", { status: 426 });
      },
      websocket: {
        message(ws, raw) {
          const msg = JSON.parse(String(raw)) as { id?: number; method: string; params?: any };
          if (msg.id === undefined) return;
          if (msg.method === "cowork/session/config/set") configSets.push(msg.params.config);
          if (msg.method === "turn/start") {
            ws.send(JSON.stringify({ id: msg.id, result: {} }));
            // Simulate cowork-server exiting before `turn/completed`.
            ws.close(1011, "server exited");
            return;
          }
          const result = msg.method === "thread/start" ? { thread: { id: "thread-1" } } : {};
          ws.send(JSON.stringify({ id: msg.id, result }));
        },
      },
    });
    try {
      const turn = runRawLoopTurnViaServer({
        wsUrl: `ws://127.0.0.1:${String(fakeServer.port)}`,
        cwd: "/tmp/raw-loop",
        provider: "openai",
        model: "gpt-test",
        prompt: "hi",
        maxSteps: 42,
      });
      await expect(turn).rejects.toThrow("cowork-server WebSocket closed unexpectedly");
      expect(configSets).toEqual([{ enableMemory: true, advancedMemory: false, maxSteps: 42 }]);
    } finally {
      fakeServer.stop(true);
    }
  });

  test("executes a raw-loop turn end-to-end against Rust cowork-server", async () => {
    const mockModel = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const sse = [
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"{\\"end\\":\\"<<END_RUN>>\\"}"}}]}',
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
        "data: [DONE]",
      ].join("\n\n");
      res.end(`${sse}\n\n`);
    });
    await new Promise<void>((resolve) => mockModel.listen(0, "127.0.0.1", () => resolve()));
    const modelPort = (mockModel.address() as { port: number }).port;

    const server = await startRustTestServer({
      env: {
        COWORK_LMSTUDIO_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
      },
    });
    try {
      const harnessContext = buildRawLoopHarnessContext(
        { id: "smoke-1", provider: "lmstudio", model: "mock-local" },
        "mixed",
        { runId: "smoke-1", runDir: server.workspaceDir, repoDir: server.workspaceDir },
      );
      const out = await runRawLoopTurnViaServer({
        wsUrl: server.wsUrl,
        cwd: server.workspaceDir,
        provider: "lmstudio",
        model: "mock-local",
        prompt: "Reply with the sentinel JSON.",
        harnessContext,
        providerOptions: {
          lmstudio: { baseUrl: `http://127.0.0.1:${modelPort}/v1` },
        },
      });
      expect(out.text).toBe('{"end":"<<END_RUN>>"}');
      expect(out.totalSteps).toBeGreaterThanOrEqual(1);
    } finally {
      await server.stop();
      await new Promise<void>((resolve) => mockModel.close(() => resolve()));
    }
  });

  test("captures projected Rust toolCall names and arguments across multi-step turns", async () => {
    let completionCallIndex = 0;
    const mockModel = http.createServer((req, res) => {
      if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [{ id: "mock-local", object: "model", owned_by: "local" }],
          }),
        );
        return;
      }
      completionCallIndex += 1;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (completionCallIndex === 1) {
        const sse = [
          'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_write_1","type":"function","function":{"name":"write","arguments":"{\\"filePath\\":\\"hello.txt\\",\\"content\\":\\"ok\\"}"}}]}}]}',
          'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":10,"total_tokens":20}}',
          "data: [DONE]",
        ].join("\n\n");
        res.end(`${sse}\n\n`);
        return;
      }
      const sse = [
        'data: {"id":"chatcmpl-2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"{\\"end\\":\\"<<END_RUN>>\\"}"}}]}',
        'data: {"id":"chatcmpl-2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":15,"completion_tokens":6,"total_tokens":21}}',
        "data: [DONE]",
      ].join("\n\n");
      res.end(`${sse}\n\n`);
    });
    await new Promise<void>((resolve) => mockModel.listen(0, "127.0.0.1", () => resolve()));
    const modelPort = (mockModel.address() as { port: number }).port;

    const server = await startRustTestServer({
      env: {
        LM_STUDIO_BASE_URL: `http://127.0.0.1:${modelPort}`,
      },
    });
    try {
      const out = await runRawLoopTurnViaServer({
        wsUrl: server.wsUrl,
        cwd: server.workspaceDir,
        provider: "lmstudio",
        model: "mock-local",
        prompt: "Write hello.txt then finish.",
        providerOptions: {
          lmstudio: { baseUrl: `http://127.0.0.1:${modelPort}` },
        },
      });
      assertRawLoopToolRequirements({ requiredToolCalls: ["write"] }, out.steps, out.toolLogLines);
      expect(out.toolLogLines.some((line) => line.startsWith("tool> write "))).toBe(true);
      expect(out.text).toBe('{"end":"<<END_RUN>>"}');
    } finally {
      await server.stop();
      await new Promise<void>((resolve) => mockModel.close(() => resolve()));
    }
  });
});
