import { describe, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { z } from "zod";
import type { RunSpec } from "../packages/harness/src/rawLoopScenarios";
import {
  buildCodexHarnessSmokeRuns,
  buildMixedRuns,
  selectRawLoopRuns,
} from "../packages/harness/src/rawLoopScenarios";
import {
  assertRawLoopToolOrder,
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
  executeRawLoopRun,
  loadRawLoopHarnessSettings,
  prepareRawLoopServerHome,
  RAW_LOOP_REPAIR_MAX_STEPS,
  RawLoopTurnError,
  type RawLoopTurnOptions,
  releaseRawLoopServerHome,
  resolveRawLoopHarnessConfig,
  runRawLoopTurnViaServer,
  type ServerTurnTraceResult,
  startRawLoopServer,
} from "../packages/harness/src/run_raw_agent_loops";
import { scratchRoots } from "../src/platform/scratchRoots";
import type { AgentConfig } from "../src/types";
import {
  connectRustJsonRpc,
  resolveRustBinaryPath,
  startRustTestServer,
} from "./helpers/rustServerHarness";

/**
 * Answers the LM Studio model-listing endpoints the server may probe before inference: the
 * OpenAI-compatible `/v1/models` and the native `/api/v1/models` used to prepare the model.
 */
function serveMockLmStudioModels(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (req.method !== "GET") return false;
  if (req.url?.startsWith("/api/v1/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        models: [{ key: "mock-local", type: "llm", loaded_instances: [{ id: "mock-local" }] }],
      }),
    );
    return true;
  }
  if (req.url?.startsWith("/v1/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        object: "list",
        data: [{ id: "mock-local", object: "model", owned_by: "local" }],
      }),
    );
    return true;
  }
  return false;
}

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

  test("pins the spawned server repo root and disables tasks, workflows, MCP and advanced memory via env", () => {
    const env = buildRawLoopServerEnv({
      PATH: "/usr/bin",
      COWORK_ENABLE_TASKS: "1",
      COWORK_ENABLE_WORKFLOWS: "true",
      AGENT_ENABLE_MCP: "1",
      AGENT_ADVANCED_MEMORY: "true",
      COWORK_HOME_OVERRIDE: "/developer/home",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.COWORK_REPO_ROOT).toBe(path.resolve(import.meta.dir, ".."));
    expect(env.COWORK_ENABLE_TASKS).toBe("0");
    expect(env.COWORK_ENABLE_WORKFLOWS).toBe("0");
    expect(env.AGENT_ENABLE_MCP).toBe("0");
    expect(env.AGENT_ADVANCED_MEMORY).toBe("0");
    expect(env.COWORK_HOME_OVERRIDE).toBe("/developer/home");
    expect(
      buildRawLoopServerEnv({ COWORK_HOME_OVERRIDE: "/developer/home" }, { homeDir: "/run/home" })
        .COWORK_HOME_OVERRIDE,
    ).toBe("/run/home");
    expect(env.COWORK_DESKTOP_PARENT_MANAGED).toBe("1");
    expect(env.COWORK_DISABLE_BUILTIN_SKILLS).toBe("1");
    expect(env.COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP).toBe("1");
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
      // `advancedMemory` is pinned through the server env; the session config never carries
      // it, because root-session config writes persist it to the user tier.
      expect(configSets).toEqual([{ enableMemory: true, maxSteps: 42 }]);
    } finally {
      fakeServer.stop(true);
    }
  });

  test("executes a raw-loop turn end-to-end against Rust cowork-server", async () => {
    const mockModel = http.createServer((req, res) => {
      if (serveMockLmStudioModels(req, res)) return;
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
      if (serveMockLmStudioModels(req, res)) return;
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

async function makeTempDir(prefix: string): Promise<string> {
  const scratch = scratchRoots()[0] ?? "/tmp";
  const base = fs.existsSync(scratch) ? fs.realpathSync(scratch) : scratch;
  return fs.realpathSync(await fsp.mkdtemp(path.join(base, prefix)));
}

function tracedCall(toolName: string, output: unknown = { ok: true }, state?: string) {
  return [
    { scope: "tool-call", step: { type: "tool-call", toolName, input: {} } },
    {
      scope: "tool-result",
      step: { type: "tool-result", toolName, output, ...(state ? { state } : {}) },
    },
  ];
}

function fakeTurnResult(
  toolNames: string[],
  text: string,
  threadId = "thread-1",
): ServerTurnTraceResult {
  return {
    threadId,
    text,
    steps: toolNames.flatMap((name) => tracedCall(name)),
    toolLogLines: toolNames.map((name) => `tool> ${name} {}`),
    todos: [],
    totalSteps: toolNames.length + 1,
  };
}

function fakeRun(overrides: Partial<RunSpec> = {}): RunSpec {
  // No `finalContract`: the final text must contain the `<<END_RUN>>` sentinel.
  return {
    id: "fake-run",
    provider: "openai",
    model: "gpt-test",
    maxSteps: 40,
    prompt: ({ runDir }) => `Work in ${runDir}`,
    ...overrides,
  };
}

/** Executes a run against scripted turns instead of a live server and model. */
async function executeFakeRun(
  run: RunSpec,
  turns: Array<
    (opts: RawLoopTurnOptions) => ServerTurnTraceResult | Promise<ServerTurnTraceResult>
  >,
  opts: { strictMode?: boolean } = {},
) {
  const rootOutDir = await makeTempDir("raw-loop-run-");
  const calls: RawLoopTurnOptions[] = [];
  const sleeps: number[] = [];
  let serverStarts = 0;
  let serverStops = 0;
  const result = await executeRawLoopRun(run, {
    rootOutDir,
    scenario: "mixed",
    strictMode: opts.strictMode ?? false,
    deps: {
      startServer: async () => {
        serverStarts += 1;
        return {
          wsUrl: "ws://fake",
          stop: async () => {
            serverStops += 1;
          },
        };
      },
      runTurn: async (turnOpts) => {
        calls.push(turnOpts);
        const next = turns[calls.length - 1];
        if (!next) throw new Error(`unexpected turn ${String(calls.length)}`);
        return await next(turnOpts);
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      retryDelayMs: (_error, attempt) => attempt * 10,
      log: () => {
        // Keep test output quiet.
      },
    },
  });
  const readJson = (name: string) =>
    JSON.parse(fs.readFileSync(path.join(result.runDir, name), "utf-8"));
  return {
    ...result,
    calls,
    sleeps,
    rootOutDir,
    readJson,
    get serverStarts() {
      return serverStarts;
    },
    get serverStops() {
      return serverStops;
    },
  };
}

describe("raw loop tool order", () => {
  const run11 = buildMixedRuns().find((run) => run.id === "run-11")!;

  test("run-11 keeps its webSearch-before-write/read requirement", () => {
    expect(run11.requiredToolBeforeTools).toBe("webSearch");
    expect(run11.guardedToolsBeforeRequiredTool).toEqual(["write", "read"]);
  });

  test("rejects a trace that writes and reads before the search", () => {
    const steps = ["todoWrite", "write", "read", "webSearch"].flatMap((name) => tracedCall(name));
    expect(() => assertRawLoopToolOrder(run11, steps)).toThrow(
      'Tool order violation: "webSearch" must succeed before "write", but "write" ran first.',
    );
  });

  test("accepts guarded tools once the required tool succeeded", () => {
    const steps = ["todoWrite", "webSearch", "write", "read", "todoWrite"].flatMap((name) =>
      tracedCall(name),
    );
    expect(() => assertRawLoopToolOrder(run11, steps)).not.toThrow();
  });

  test("a failed search does not unlock guarded tools, and failed guarded calls are not violations", () => {
    const failedSearchThenWrite = [
      ...tracedCall("webSearch", { error: "rate limited" }),
      ...tracedCall("write"),
      ...tracedCall("webSearch"),
    ];
    expect(() => assertRawLoopToolOrder(run11, failedSearchThenWrite)).toThrow(
      "Tool order violation",
    );

    const failedWriteThenSearch = [
      ...tracedCall("write", null, "output-error"),
      ...tracedCall("webSearch"),
      ...tracedCall("write"),
      ...tracedCall("read"),
    ];
    expect(() => assertRawLoopToolOrder(run11, failedWriteThenSearch)).not.toThrow();
  });

  test("a mock run that writes before the search fails every attempt", async () => {
    const outOfOrder = () =>
      fakeTurnResult(["todoWrite", "write", "read", "webSearch"], "<<END_RUN>>");
    const out = await executeFakeRun(
      fakeRun({
        id: "order-run",
        maxAttempts: 2,
        requiredToolCalls: ["todoWrite", "webSearch", "write", "read"],
        requiredToolBeforeTools: "webSearch",
        guardedToolsBeforeRequiredTool: ["write", "read"],
      }),
      [outOfOrder, outOfOrder],
    );
    expect(out.ok).toBe(false);
    expect(out.attempts.map((attempt) => attempt.ok)).toEqual([false, false]);
    expect(out.attempts[0]!.error).toContain("Tool order violation");
    expect(out.readJson("run_meta.json").error).toContain("Tool order violation");
  });
});

describe("raw loop strict mode resolution", () => {
  async function seedConfigs(opts: { project?: unknown; user?: unknown; builtIn?: unknown }) {
    const root = await makeTempDir("raw-loop-strict-");
    const repoRoot = path.join(root, "repo");
    const userCoworkHome = path.join(root, "home", ".cowork");
    const write = async (file: string, value: unknown) => {
      if (value === undefined) return;
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, JSON.stringify(value));
    };
    await write(path.join(repoRoot, ".cowork", "config.json"), opts.project);
    await write(path.join(userCoworkHome, "config", "config.json"), opts.user);
    await write(
      path.join(repoRoot, "config", "defaults.json"),
      opts.builtIn ?? {
        harness: { reportOnly: true, strictMode: false },
      },
    );
    return { repoRoot, userCoworkHome };
  }

  const strictModeFor = (
    settings: ReturnType<typeof loadRawLoopHarnessSettings>,
    strictModeOverride: boolean | null,
  ) => resolveRawLoopHarnessConfig(settings, { strictModeOverride }).strictMode;

  test("falls back to the user config's harness.strictMode without a CLI flag", async () => {
    const paths = await seedConfigs({ user: { harness: { strictMode: true } } });
    const settings = loadRawLoopHarnessSettings({ ...paths, env: {} });
    expect(settings.strictMode).toBe(true);
    expect(strictModeFor(settings, null)).toBe(true);
    expect(strictModeFor(settings, false)).toBe(false);
  });

  test("AGENT_HARNESS_STRICT_MODE outranks config, and project config outranks user config", async () => {
    const paths = await seedConfigs({
      project: { harness: { strictMode: false } },
      user: { harness: { strictMode: true } },
    });
    expect(loadRawLoopHarnessSettings({ ...paths, env: {} }).strictMode).toBe(false);
    const fromEnv = loadRawLoopHarnessSettings({
      ...paths,
      env: { AGENT_HARNESS_STRICT_MODE: "yes" },
    });
    expect(fromEnv.strictMode).toBe(true);
    expect(strictModeFor(fromEnv, false)).toBe(false);
  });

  test("defaults to non-strict when nothing configures it", async () => {
    const paths = await seedConfigs({});
    expect(strictModeFor(loadRawLoopHarnessSettings({ ...paths, env: {} }), null)).toBe(false);
  });
});

describe("raw loop attempts and repair", () => {
  test("retries a transient turn error and keeps the failed attempt's diagnostics", async () => {
    const out = await executeFakeRun(fakeRun({ maxAttempts: 3, requiredToolCalls: ["write"] }), [
      () => {
        throw new RawLoopTurnError(
          "provider overloaded; retry in 2s",
          fakeTurnResult(["write"], "", "thread-a"),
        );
      },
      () => fakeTurnResult(["write"], '{"end":"<<END_RUN>>"}', "thread-b"),
    ]);

    expect(out.ok).toBe(true);
    expect(out.serverStarts).toBe(2);
    expect(out.serverStops).toBe(2);
    expect(out.sleeps).toEqual([10]);
    expect(out.readJson("attempts.json")).toEqual([
      expect.objectContaining({
        attempt: 1,
        ok: false,
        error: "provider overloaded; retry in 2s",
        retryDelayMs: 10,
      }),
      expect.objectContaining({ attempt: 2, ok: true }),
    ]);
    const firstAttempt = out.readJson("trace_attempt-01.json");
    expect(firstAttempt.ok).toBe(false);
    expect(firstAttempt.threadId).toBe("thread-a");
    expect(firstAttempt.toolLogLines).toEqual(["tool> write {}"]);
    expect(out.readJson("trace_attempt-02.json").ok).toBe(true);
    const meta = out.readJson("run_meta.json");
    expect(meta).toMatchObject({ ok: true, attempts: 2, maxAttempts: 3, strictMode: false });
    expect(meta.error).toBeUndefined();
    expect(fs.readFileSync(path.join(out.runDir, "final.txt"), "utf-8")).toBe(
      '{"end":"<<END_RUN>>"}',
    );
    expect(
      out.readJson("artifacts_index.json").map((entry: { path: string }) => entry.path),
    ).toContain("trace_attempt-01.json");
  });

  test("returns a failed result with metadata once attempts are exhausted instead of throwing", async () => {
    const out = await executeFakeRun(fakeRun({ maxAttempts: 2, requiredToolCalls: ["bash"] }), [
      () => fakeTurnResult(["write"], '{"end":"<<END_RUN>>"}'),
      () => fakeTurnResult(["read"], '{"end":"<<END_RUN>>"}'),
    ]);
    expect(out.ok).toBe(false);
    expect(out.sleeps).toEqual([10]);
    const attempts = out.readJson("attempts.json");
    expect(attempts).toHaveLength(2);
    expect(attempts[1].retryDelayMs).toBeUndefined();
    const meta = out.readJson("run_meta.json");
    expect(meta.ok).toBe(false);
    expect(meta.error).toBe(
      "Run fake-run failed after 2 attempt(s): Missing required tool call(s): bash",
    );
    expect(meta.validation.issues[0].code).toBe("run_failed");
    expect(out.readJson("trace_attempt-01.json").toolLogLines).toEqual(["tool> write {}"]);
    expect(out.readJson("trace_attempt-02.json").toolLogLines).toEqual(["tool> read {}"]);
  });

  test("gives a contract failure a second attempt in strict mode", async () => {
    const out = await executeFakeRun(
      fakeRun({ maxAttempts: 2 }),
      [() => fakeTurnResult([], "not json"), () => fakeTurnResult([], "done <<END_RUN>>")],
      { strictMode: true },
    );
    expect(out.ok).toBe(true);
    expect(out.calls).toHaveLength(2);
    expect(out.calls.every((call) => call.maxSteps === 40 && call.threadId === undefined)).toBe(
      true,
    );
    expect(out.readJson("attempts.json")[0].error).toContain("Final contract validation failed");
  });

  test("repairs a malformed final answer with a single tool-free model step", async () => {
    const out = await executeFakeRun(fakeRun({ maxAttempts: 1 }), [
      () => fakeTurnResult(["write"], "not json", "thread-main"),
      () => fakeTurnResult([], "<<END_RUN>>", "thread-main"),
    ]);
    expect(out.ok).toBe(true);
    expect(out.calls).toHaveLength(2);
    const repair = out.calls[1];
    expect(repair).toBeDefined();
    expect(RAW_LOOP_REPAIR_MAX_STEPS).toBe(1);
    expect(repair?.maxSteps).toBe(1);
    expect(repair?.tools).toBe("none");
    expect(repair?.threadId).toBe("thread-main");
    expect(repair?.prompt).toContain("Do NOT call any tools.");
    expect(repair?.harnessContext).toBeUndefined();
    const meta = out.readJson("run_meta.json");
    expect(meta).toMatchObject({ repairAttempted: true, repairSucceeded: true, degraded: true });
    expect(meta.budgets.repairPassCount).toBe(1);
  });

  test("rejects a repair pass that calls tools", async () => {
    const out = await executeFakeRun(fakeRun({ maxAttempts: 1 }), [
      () => fakeTurnResult([], "not json", "thread-main"),
      () => fakeTurnResult(["bash"], "<<END_RUN>>", "thread-main"),
    ]);
    expect(out.ok).toBe(false);
    const meta = out.readJson("run_meta.json");
    expect(meta.repairAttempted).toBe(true);
    expect(meta.repairSucceeded).toBe(false);
    expect(meta.validation.issues.map((issue: { code: string }) => issue.code)).toContain(
      "repair_failed",
    );
    expect(meta.error).toContain("Repair pass called tool(s) bash");
    expect(out.readJson("trace_attempt-01.json").toolLogLines).toEqual(["tool> bash {}"]);
  });

  test("live server repair turn disables tools so a hallucinated write neither runs nor passes validation", async () => {
    const wireRequests: Array<Record<string, unknown>> = [];
    const mockOpenAi = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        if (body.model !== "gpt-5.4") {
          const bgEvents = [
            { type: "response.created", response: { id: "resp_bg_title" } },
            {
              type: "response.output_item.done",
              output_index: 0,
              item: {
                id: "msg_bg",
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Live Repair Run" }],
              },
            },
            {
              type: "response.completed",
              response: {
                id: "resp_bg_title",
                status: "completed",
                usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
              },
            },
          ];
          for (const evt of bgEvents) res.write(`data: ${JSON.stringify(evt)}\n\n`);
          res.end();
          return;
        }
        const idx = wireRequests.push(body);

        if (idx === 1) {
          // Primary turn: malformed final answer without <<END_RUN>>.
          const events = [
            { type: "response.created", response: { id: "resp_primary_1" } },
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { id: "msg_p1", type: "message", role: "assistant", content: [] },
            },
            {
              type: "response.output_text.delta",
              output_index: 0,
              content_index: 0,
              delta: "malformed output without sentinel",
            },
            {
              type: "response.output_item.done",
              output_index: 0,
              item: {
                id: "msg_p1",
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "malformed output without sentinel" }],
              },
            },
            {
              type: "response.completed",
              response: {
                id: "resp_primary_1",
                status: "completed",
                usage: { input_tokens: 12, output_tokens: 6, total_tokens: 18 },
              },
            },
          ];
          for (const evt of events) res.write(`data: ${JSON.stringify(evt)}\n\n`);
          res.end();
          return;
        }

        // Repair turn (`maxSteps: 1, tools: "none"`): model hallucinates a `write` tool call!
        const callArgs = JSON.stringify({
          path: "mutated-during-repair.txt",
          content: "should never be written during repair\n",
        });
        const events = [
          { type: "response.created", response: { id: "resp_repair_1" } },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              id: "fc_rep_1",
              type: "function_call",
              call_id: "call_repair_write",
              name: "write",
              arguments: "",
            },
          },
          {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            item_id: "fc_rep_1",
            delta: callArgs,
          },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              id: "fc_rep_1",
              type: "function_call",
              call_id: "call_repair_write",
              name: "write",
              arguments: callArgs,
            },
          },
          {
            type: "response.completed",
            response: {
              id: "resp_repair_1",
              status: "completed",
              usage: { input_tokens: 16, output_tokens: 12, total_tokens: 28 },
            },
          },
        ];
        for (const evt of events) res.write(`data: ${JSON.stringify(evt)}\n\n`);
        res.end();
      });
    });

    await new Promise<void>((r) => mockOpenAi.listen(0, "127.0.0.1", () => r()));
    const port = (mockOpenAi.address() as { port: number }).port;
    const rootOutDir = await makeTempDir("raw-loop-live-repair-");
    const { homeDir } = await prepareRawLoopServerHome({
      homeDir: path.join(rootOutDir, "server-home"),
      sourceCoworkHome: path.join(rootOutDir, "empty-cowork"),
    });

    try {
      const result = await executeRawLoopRun(
        fakeRun({
          id: "live-repair-run",
          provider: "openai",
          model: "gpt-5.4",
          maxAttempts: 1,
          maxSteps: 4,
        }),
        {
          rootOutDir,
          scenario: "mixed",
          strictMode: false,
          deps: {
            startServer: async ({ runDir }) =>
              startRawLoopServer({
                serverBin: resolveRustBinaryPath("cowork-server"),
                runDir,
                homeDir,
                baseEnv: {
                  ...process.env,
                  OPENAI_API_KEY: "sk-test-live-repair",
                  OPENAI_BASE_URL: `http://127.0.0.1:${String(port)}/v1`,
                  COWORK_DISABLE_NETWORK_TELEMETRY: "1",
                  COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP: "1",
                },
              }),
            log: () => {
              // Keep test output quiet.
            },
          },
        },
      );

      expect(result.ok).toBe(false);
      expect(wireRequests).toHaveLength(2);
      const primaryTools = wireRequests[0]?.tools;
      expect(Array.isArray(primaryTools)).toBe(true);
      expect(Array.isArray(primaryTools) ? primaryTools.length : 0).toBeGreaterThan(0);
      expect(wireRequests[1]?.tools ?? []).toEqual([]);

      // The hallucinated `write` tool call on the repair turn must NOT execute on disk!
      expect(fs.existsSync(path.join(result.runDir, "mutated-during-repair.txt"))).toBe(false);

      const meta = JSON.parse(fs.readFileSync(path.join(result.runDir, "run_meta.json"), "utf-8"));
      expect(meta.repairAttempted).toBe(true);
      expect(meta.repairSucceeded).toBe(false);
      expect(meta.error).toContain("Repair pass called tool(s) write");
    } finally {
      await new Promise<void>((r) => mockOpenAi.close(() => r()));
    }
  }, 30_000);
});

function startMockLmStudio(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (serveMockLmStudioModels(req, res)) return;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const sse = [
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"{\\"end\\":\\"<<END_RUN>>\\"}"}}]}',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
      "data: [DONE]",
    ].join("\n\n");
    res.end(`${sse}\n\n`);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        baseUrl: `http://127.0.0.1:${String(port)}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

describe("raw loop isolated server home", () => {
  test("links credentials and skills but never the user config, and unlinks them on release", async () => {
    const root = await makeTempDir("raw-loop-home-");
    const devCowork = path.join(root, "dev-home", ".cowork");
    await fsp.mkdir(path.join(devCowork, "auth", "codex-cli"), { recursive: true });
    await fsp.writeFile(path.join(devCowork, "auth", "codex-cli", "auth.json"), "{}");
    await fsp.mkdir(path.join(devCowork, "skills", "doc"), { recursive: true });
    await fsp.mkdir(path.join(devCowork, "config"), { recursive: true });
    await fsp.writeFile(path.join(devCowork, "config", "config.json"), "{}");

    const homeDir = path.join(root, "server-home");
    const prepared = await prepareRawLoopServerHome({ homeDir, sourceCoworkHome: devCowork });
    expect(prepared.linked).toEqual(["auth", "skills"]);
    // Idempotent across attempts.
    expect(
      (await prepareRawLoopServerHome({ homeDir, sourceCoworkHome: devCowork })).linked,
    ).toEqual(["auth", "skills"]);
    expect(fs.existsSync(path.join(prepared.coworkDir, "auth", "codex-cli", "auth.json"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(prepared.coworkDir, "config"))).toBe(false);

    await releaseRawLoopServerHome(homeDir);
    expect(fs.existsSync(path.join(prepared.coworkDir, "auth"))).toBe(false);
    expect(fs.existsSync(path.join(devCowork, "auth", "codex-cli", "auth.json"))).toBe(true);
  });

  test("the developer home's user config is untouched by persisting session-config writes", async () => {
    const root = await makeTempDir("raw-loop-devhome-");
    const devHome = path.join(root, "dev-home");
    const devConfigFile = path.join(devHome, ".cowork", "config", "config.json");
    await fsp.mkdir(path.dirname(devConfigFile), { recursive: true });
    await fsp.mkdir(path.join(devHome, ".cowork", "skills"), { recursive: true });
    // Compact JSON: any rewrite by the server's patch store would reformat it.
    const devConfig = '{"harness":{"strictMode":true},"advancedMemory":true}';
    await fsp.writeFile(devConfigFile, devConfig);
    const runDir = path.join(root, "run");
    await fsp.mkdir(runDir, { recursive: true });

    const { homeDir, coworkDir } = await prepareRawLoopServerHome({
      homeDir: path.join(root, "server-home"),
      sourceCoworkHome: path.join(devHome, ".cowork"),
    });
    const model = await startMockLmStudio();
    const server = await startRawLoopServer({
      serverBin: resolveRustBinaryPath("cowork-server"),
      runDir,
      homeDir,
      baseEnv: {
        ...process.env,
        HOME: devHome,
        USERPROFILE: devHome,
        COWORK_HOME_OVERRIDE: devHome,
        COWORK_DISABLE_NETWORK_TELEMETRY: "1",
        LM_STUDIO_BASE_URL: model.baseUrl,
      },
    });
    try {
      const out = await runRawLoopTurnViaServer({
        wsUrl: server.wsUrl,
        cwd: runDir,
        provider: "lmstudio",
        model: "mock-local",
        prompt: "Reply with the sentinel JSON.",
        providerOptions: { lmstudio: { baseUrl: model.baseUrl } },
        maxSteps: 3,
      });
      expect(out.text).toBe('{"end":"<<END_RUN>>"}');

      // `advancedMemory` is a user-tier key: the server persists it to the global config.
      const client = await connectRustJsonRpc(server.wsUrl);
      try {
        await client.request("cowork/session/defaults/apply", {
          cwd: runDir,
          config: { advancedMemory: false },
        });
      } finally {
        client.close();
      }
    } finally {
      await server.stop();
      await model.close();
    }

    expect(fs.readFileSync(devConfigFile, "utf-8")).toBe(devConfig);
    expect(fs.existsSync(path.join(devHome, ".cowork", "sessions.db"))).toBe(false);
    expect(fs.existsSync(path.join(coworkDir, "sessions.db"))).toBe(true);
    const isolatedConfig = JSON.parse(
      fs.readFileSync(path.join(coworkDir, "config", "config.json"), "utf-8"),
    );
    expect(isolatedConfig.advancedMemory).toBe(false);
  });
});

describe("rust test server helper", () => {
  test("serves from the reported coworkHomeDir", async () => {
    const server = await startRustTestServer();
    try {
      expect(server.coworkHomeDir).toBe(path.join(server.homeDir, ".cowork"));
      expect(fs.existsSync(path.join(server.coworkHomeDir, "sessions.db"))).toBe(true);
      expect(fs.existsSync(path.join(server.coworkHomeDir, ".cowork"))).toBe(false);
    } finally {
      await server.stop();
    }
  });
});
