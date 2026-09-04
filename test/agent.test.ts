import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunTurnParams } from "../src/agent";
import { createRunTurn } from "../src/agent";
import * as coworkRuntime from "../src/coworkRuntime";
import { closeMcpServersForSession } from "../src/mcp";
import { __internal as observabilityRuntimeInternal } from "../src/observability/runtime";
import type { RuntimeRunTurnParams, RuntimeRunTurnResult } from "../src/runtime/types";
import { SessionCostTracker } from "../src/session/costTracker";
import { buildTurnSystemPrompt } from "../src/turnSystemPrompt";
import type { AgentConfig, ModelMessage } from "../src/types";
import { deriveActiveWorkspaceContext } from "../src/workspace/context";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const base = "/tmp/agent-test";
  return {
    provider: "google",
    model: "gemini-3-flash-preview",
    preferredChildModel: "gemini-3-flash-preview",
    workingDirectory: base,
    outputDirectory: path.join(base, "output"),
    uploadsDirectory: path.join(base, "uploads"),
    userName: "tester",
    knowledgeCutoff: "2025-01",
    projectCoworkDir: path.join(base, ".cowork"),
    userCoworkDir: path.join(base, ".agent-user"),
    builtInDir: base,
    builtInConfigDir: path.join(base, "config"),
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
    observabilityEnabled: false,
    ...overrides,
  };
}

async function makeTempWorkspaceConfig(
  overrides: Partial<AgentConfig> = {},
): Promise<{ workspaceRoot: string; config: AgentConfig }> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "active-workspace-context-"));
  return {
    workspaceRoot,
    config: makeConfig({
      projectCoworkDir: path.join(workspaceRoot, ".cowork"),
      workingDirectory: workspaceRoot,
      outputDirectory: path.join(workspaceRoot, "output"),
      uploadsDirectory: undefined,
      ...overrides,
    }),
  };
}

// ---------------------------------------------------------------------------
// Inject runtime and tool dependencies so these tests exercise the same harness
// path as production without making provider requests.
// ---------------------------------------------------------------------------

const mockRuntimeRunTurn = mock(
  async (_params: RuntimeRunTurnParams): Promise<RuntimeRunTurnResult> => ({
    text: "hello from model",
    reasoningText: undefined as string | undefined,
    responseMessages: [{ role: "assistant", content: "hi" }],
  }),
);

const mockCreateRuntime = mock((_config: AgentConfig) => ({
  name: "pi" as const,
  runTurn: mockRuntimeRunTurn,
}));

const mockCreateTools = mock((_ctx: any) => ({
  bash: { type: "builtin" },
  read: { type: "builtin" },
}));

const mockLoadMCPServers = mock(async (_config: AgentConfig) => [] as any[]);
const mockLoadMCPTools = mock(async (_servers: any[], _opts?: any) => ({
  tools: {} as Record<string, any>,
  errors: [] as string[],
}));

// ---------------------------------------------------------------------------
// Factory for default RunTurnParams
// ---------------------------------------------------------------------------

function makeParams(overrides: Partial<RunTurnParams> = {}): RunTurnParams {
  return {
    config: makeConfig(),
    system: "You are a helpful assistant.",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] as any[],
    toolEnv: { COWORK_DISABLE_RUNTIME: "1" },
    log: mock(() => {}),
    askUser: mock(async () => "yes"),
    approveCommand: mock(async () => true),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runTurn", () => {
  let runTurn: typeof import("../src/agent").runTurn;

  beforeEach(async () => {
    await observabilityRuntimeInternal.resetForTests();
    mockRuntimeRunTurn.mockClear();
    mockCreateRuntime.mockClear();
    mockCreateTools.mockClear();
    mockLoadMCPServers.mockClear();
    mockLoadMCPTools.mockClear();

    // Reset to default return value
    mockRuntimeRunTurn.mockImplementation(async () => ({
      text: "hello from model",
      reasoningText: undefined as string | undefined,
      responseMessages: [{ role: "assistant", content: "hi" }],
    }));
    mockCreateTools.mockImplementation((_ctx: any) => ({
      bash: { type: "builtin" },
      read: { type: "builtin" },
    }));
    mockLoadMCPServers.mockImplementation(async (_config: AgentConfig) => [] as any[]);
    mockLoadMCPTools.mockImplementation(async (_servers: any[], _opts?: any) => ({
      tools: {} as Record<string, any>,
      errors: [] as string[],
    }));

    runTurn = createRunTurn({
      createRuntime: mockCreateRuntime,
      createTools: mockCreateTools,
      loadMCPServers: mockLoadMCPServers,
      loadMCPTools: mockLoadMCPTools,
    });
  });

  afterEach(() => {
    mock.restore();
  });

  // -------------------------------------------------------------------------
  // System prompt
  // -------------------------------------------------------------------------

  test("includes the base and active workspace sections in the runtime system prompt", async () => {
    const params = makeParams({ system: "Custom system prompt" });
    await runTurn(params);

    expect(mockRuntimeRunTurn).toHaveBeenCalledTimes(1);
    const callArg = mockRuntimeRunTurn.mock.calls[0][0] as any;
    expect(callArg.system).toContain("Custom system prompt");
    expect(callArg.system).toContain("## Active Workspace Context");
    expect(callArg.system).toContain(
      `- Workspace root: ${path.dirname(params.config.projectCoworkDir)}`,
    );
    expect(callArg.system).toContain(
      `- Execution working directory: ${params.config.workingDirectory}`,
    );
  });

  test("preserves custom MCP instructions when MCP tools are not active", async () => {
    const system =
      "Header\nOnly call `mcp__{serverName}__{toolName}` after the user approves.\nFooter";

    await runTurn(makeParams({ system, enableMcp: false }));

    const callArg = mockRuntimeRunTurn.mock.calls[0][0] as any;
    expect(callArg.system.startsWith(system)).toBe(true);
    expect(callArg.system).not.toContain("## Active MCP Tools");
  });

  test("adds MCP namespacing guidance only when MCP tools are active", async () => {
    mockLoadMCPServers.mockResolvedValue([
      { name: "srv", transport: { type: "stdio", command: "x", args: [] } },
    ]);
    mockLoadMCPTools.mockResolvedValue({
      tools: { mcp__srv__doThing: { type: "mcp-tool" } },
      errors: [],
    });

    const system =
      "Base system prompt\nOnly call `mcp__{serverName}__{toolName}` after the user approves.";
    await runTurn(makeParams({ enableMcp: true, system }));

    const callArg = mockRuntimeRunTurn.mock.calls[0][0] as any;
    expect(callArg.system.startsWith(system)).toBe(true);
    expect(callArg.system).toContain("## Active MCP Tools");
    expect(callArg.system).toContain("`mcp__{serverName}__{toolName}`");
  });

  test("codex app-server turns pass Cowork coordination and MCP tools through the hybrid boundary", async () => {
    const runtimeRunTurn = mock(async (input: any) => ({
      text: "ok",
      responseMessages: [{ role: "assistant", content: "ok" }],
      providerState: { provider: "codex-cli", model: input.config.model, threadId: "thread_1" },
    }));
    const createRuntimeForCodex = mock((_config: AgentConfig) => ({
      name: "codex-app-server" as const,
      runTurn: runtimeRunTurn,
    }));
    const createToolsForCodex = mock((_ctx: any) => ({
      bash: { type: "builtin" },
      read: { type: "builtin" },
      webFetch: { type: "builtin" },
      spawnAgent: { type: "builtin" },
      usage: { type: "builtin" },
    }));
    const loadMCPServersForCodex = mock(async (_config: AgentConfig) => [
      { name: "srv", transport: { type: "stdio", command: "x", args: [] } },
    ]);
    const closeMcpForCodex = mock(async () => {});
    const loadMCPToolsForCodex = mock(async (_servers: any[], _opts?: any) => ({
      tools: { mcp__srv__custom: { type: "mcp-tool" } },
      errors: [],
      close: closeMcpForCodex,
    }));
    const runCodexTurn = createRunTurn({
      createRuntime: createRuntimeForCodex,
      createTools: createToolsForCodex,
      loadMCPServers: loadMCPServersForCodex,
      loadMCPTools: loadMCPToolsForCodex,
    });

    await runCodexTurn(
      makeParams({
        config: makeConfig({
          provider: "codex-cli",
          runtime: "codex-app-server",
          model: "gpt-5.4",
          preferredChildModel: "gpt-5.4",
          enableMcp: true,
        }),
        enableMcp: true,
        toolEnv: {
          PATH: "/tmp/cowork-managed-bin",
          COWORK_DISABLE_RUNTIME: "1",
          COWORK_TEST_TOOL_ENV: "preserved",
        },
        system:
          "Base system prompt\nMCP tool names are namespaced as `mcp__{serverName}__{toolName}`.",
      }),
    );

    expect(createToolsForCodex).toHaveBeenCalledTimes(1);
    expect(loadMCPServersForCodex).toHaveBeenCalledTimes(1);
    expect(loadMCPToolsForCodex).toHaveBeenCalledTimes(1);
    expect(closeMcpForCodex).toHaveBeenCalledTimes(1);
    expect(runtimeRunTurn).toHaveBeenCalledTimes(1);
    const runtimeParams = runtimeRunTurn.mock.calls[0][0] as any;
    expect(Object.keys(runtimeParams.tools).sort()).toEqual([
      "mcpCall",
      "spawnAgent",
      "toolSearch",
    ]);
    expect(runtimeParams.tools).not.toHaveProperty("bash");
    expect(runtimeParams.tools).not.toHaveProperty("read");
    expect(runtimeParams.tools).not.toHaveProperty("usage");
    expect(runtimeParams.tools).not.toHaveProperty("webFetch");
    expect(runtimeParams.toolEnv.COWORK_TEST_TOOL_ENV).toBe("preserved");
    expect(String(runtimeParams.toolEnv.PATH).split(path.delimiter)).toContain(
      "/tmp/cowork-managed-bin",
    );
    expect(runtimeParams.system).toContain("## Active MCP Tools");
    expect(runtimeParams.system).toContain("`mcp__{serverName}__{toolName}`");
  });

  test("Codex app-server scoped children keep Cowork read-scope tools", async () => {
    const runtimeRunTurn = mock(async () => ({
      responseMessages: [{ role: "assistant", content: "ok" }],
    }));
    const createRuntimeForCodex = mock(() => ({
      name: "codex-app-server" as const,
      runTurn: runtimeRunTurn,
    }));
    const createToolsForCodex = mock(() => ({
      bash: { type: "builtin" },
      read: { type: "builtin-read" },
      glob: { type: "builtin-glob" },
      grep: { type: "builtin-grep" },
      write: { type: "builtin-write" },
      edit: { type: "builtin-edit" },
      spawnAgent: { type: "cowork" },
    }));
    const runCodexTurn = createRunTurn({
      createRuntime: createRuntimeForCodex,
      createTools: createToolsForCodex,
    });

    await runCodexTurn(
      makeParams({
        config: makeConfig({
          provider: "codex-cli",
          runtime: "codex-app-server",
          model: "gpt-5.4",
          preferredChildModel: "gpt-5.4",
        }),
        agentTargetPaths: ["src/auth"],
      }),
    );

    const runtimeParams = runtimeRunTurn.mock.calls[0][0] as any;
    expect(Object.keys(runtimeParams.tools).sort()).toEqual(["glob", "grep", "read", "spawnAgent"]);
    expect(runtimeParams.tools).not.toHaveProperty("bash");
    expect(runtimeParams.tools).not.toHaveProperty("write");
    expect(runtimeParams.tools).not.toHaveProperty("edit");
  });

  test("does not expose dependency wiring or instructions for an explicitly disabled runtime", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-turn-artifact-runtime-"));
    const nodeModulesPath = path.join(workspaceRoot, "artifact-runtime", "node", "node_modules");
    const nodePath = path.join(
      workspaceRoot,
      "artifact-runtime",
      "node",
      "bin",
      process.platform === "win32" ? "node.exe" : "node",
    );
    const resolverPath = path.join(
      workspaceRoot,
      "artifact-runtime",
      "node-resolver",
      "register.mjs",
    );
    const config = makeConfig({
      workingDirectory: workspaceRoot,
      projectCoworkDir: path.join(workspaceRoot, ".cowork"),
      userCoworkDir: path.join(workspaceRoot, ".cowork-user"),
    });
    const runtimeRunTurn = mock(async (input: any) => ({
      text: "ok",
      responseMessages: [{ role: "assistant", content: "ok" }],
      providerState: { provider: input.config.provider, model: input.config.model },
    }));
    const createRuntimeForTurn = mock((_config: AgentConfig) => ({
      name: "google-interactions" as const,
      runTurn: runtimeRunTurn,
    }));
    const createToolsForTurn = mock((_ctx: any) => ({
      bash: { type: "builtin" },
    }));
    const runTurnForRuntime = createRunTurn({
      createRuntime: createRuntimeForTurn,
      createTools: createToolsForTurn,
      loadMCPServers: mockLoadMCPServers,
      loadMCPTools: mockLoadMCPTools,
    });

    await runTurnForRuntime(
      makeParams({
        config,
        toolEnv: {
          PATH: "/usr/bin",
          COWORK_DISABLE_RUNTIME: "1",
          COWORK_RUNTIME_NODE: nodePath,
          COWORK_RUNTIME_NODE_MODULES: nodeModulesPath,
          COWORK_RUNTIME_NODE_RESOLVER: resolverPath,
        },
      }),
    );

    const toolCtx = createToolsForTurn.mock.calls[0][0] as any;
    expect(toolCtx.toolEnv.COWORK_RUNTIME_NODE).toBeUndefined();
    expect(toolCtx.toolEnv.COWORK_RUNTIME_NODE_MODULES).toBeUndefined();
    expect(toolCtx.toolEnv.COWORK_RUNTIME_NODE_RESOLVER).toBeUndefined();

    const runtimeParams = runtimeRunTurn.mock.calls[0][0] as any;
    expect(runtimeParams.system).not.toContain("## Cowork Runtime");
    expect(runtimeParams.system).not.toContain(nodePath);
    expect(runtimeParams.system).not.toContain(nodeModulesPath);
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  test("delegates the implicit environment snapshot and refreshes it for each turn", async () => {
    const prepareEnv = spyOn(coworkRuntime, "prepareCoworkRuntimeToolEnv");
    const previous = {
      COWORK_DISABLE_RUNTIME: process.env.COWORK_DISABLE_RUNTIME,
      COWORK_TEST_TURN_ENV: process.env.COWORK_TEST_TURN_ENV,
      COWORK_RUNTIME_NODE: process.env.COWORK_RUNTIME_NODE,
    };
    const previousPath = process.env.PATH;
    try {
      process.env.COWORK_DISABLE_RUNTIME = "1";
      process.env.COWORK_TEST_TURN_ENV = "first";
      process.env.COWORK_RUNTIME_NODE = "/untrusted/runtime/node";
      const firstTurn = runTurn(makeParams({ toolEnv: undefined }));
      process.env.COWORK_TEST_TURN_ENV = "second";
      await firstTurn;

      const firstEnv = mockRuntimeRunTurn.mock.calls[0][0].toolEnv!;
      expect(firstEnv.COWORK_TEST_TURN_ENV).toBe("first");
      expect(firstEnv.COWORK_RUNTIME_NODE).toBeUndefined();
      firstEnv.COWORK_TEST_TURN_ENV = "tool-local";
      expect(process.env.COWORK_TEST_TURN_ENV).toBe("second");

      const secondTurn = runTurn(makeParams({ toolEnv: undefined }));
      process.env.COWORK_TEST_TURN_ENV = "after-second-start";
      await secondTurn;

      const secondEnv = mockRuntimeRunTurn.mock.calls[1][0].toolEnv!;
      expect(secondEnv).not.toBe(firstEnv);
      expect(secondEnv.COWORK_TEST_TURN_ENV).toBe("second");
      expect(secondEnv.COWORK_RUNTIME_NODE).toBeUndefined();
      expect(process.env.COWORK_TEST_TURN_ENV).toBe("after-second-start");
      expect(process.env.COWORK_RUNTIME_NODE).toBe("/untrusted/runtime/node");
      expect(process.env.PATH).toBe(previousPath);
      expect(prepareEnv).toHaveBeenCalledTimes(2);
      expect(prepareEnv.mock.calls.every(([options]) => options.env === undefined)).toBe(true);
    } finally {
      prepareEnv.mockRestore();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("snapshots an explicit environment synchronously without mutating the caller", async () => {
    const toolEnv = {
      COWORK_DISABLE_RUNTIME: "1",
      COWORK_TEST_TURN_ENV: "first",
      COWORK_RUNTIME_NODE: "/untrusted/runtime/node",
    };
    const firstTurn = runTurn(makeParams({ toolEnv }));
    toolEnv.COWORK_TEST_TURN_ENV = "second";
    await firstTurn;

    const firstEnv = mockRuntimeRunTurn.mock.calls[0][0].toolEnv!;
    expect(firstEnv).not.toBe(toolEnv);
    expect(firstEnv.COWORK_TEST_TURN_ENV).toBe("first");
    expect(firstEnv.COWORK_RUNTIME_NODE).toBeUndefined();
    firstEnv.COWORK_TEST_TURN_ENV = "tool-local";

    await runTurn(makeParams({ toolEnv: Object.freeze(toolEnv) }));
    const secondEnv = mockRuntimeRunTurn.mock.calls[1][0].toolEnv!;
    expect(secondEnv).not.toBe(firstEnv);
    expect(secondEnv).not.toBe(toolEnv);
    expect(secondEnv.COWORK_TEST_TURN_ENV).toBe("second");
    expect(secondEnv.COWORK_RUNTIME_NODE).toBeUndefined();
    expect(toolEnv).toEqual({
      COWORK_DISABLE_RUNTIME: "1",
      COWORK_TEST_TURN_ENV: "second",
      COWORK_RUNTIME_NODE: "/untrusted/runtime/node",
    });
  });

  test("buildTurnSystemPrompt appends harness context when present", () => {
    const system = buildTurnSystemPrompt("Base system prompt", makeConfig(), false, {
      runId: "run-01",
      taskId: "task-01",
      objective: "Improve startup reliability",
      acceptanceCriteria: ["Startup completes in under 800ms"],
      constraints: ["No API changes"],
      metadata: { owner: "agent" },
      updatedAt: "2026-03-20T12:00:00.000Z",
    });

    expect(system).toContain("Base system prompt");
    expect(system).toContain("## Active Workspace Context");
    expect(system).toContain("## Active Harness Context");
    expect(system).toContain("- Run ID: run-01");
    expect(system).toContain("### Acceptance Criteria");
    expect(system).toContain("1. Startup completes in under 800ms");
    expect(system).toContain("### Constraints");
  });

  test("buildTurnSystemPrompt includes workspace root, execution cwd, and git root", async () => {
    const { workspaceRoot, config } = await makeTempWorkspaceConfig({
      outputDirectory: path.join(os.tmpdir(), "workspace-output"),
    });
    await fs.mkdir(path.join(workspaceRoot, ".git"), { recursive: true });

    const system = buildTurnSystemPrompt("Base system prompt", config, false);

    expect(system).toContain("## Active Workspace Context");
    expect(system).toContain(`- Workspace root: ${workspaceRoot}`);
    expect(system).toContain(`- Execution working directory: ${workspaceRoot}`);
    expect(system).toContain(`- Git root: ${workspaceRoot}`);
    expect(system).toContain("- Working directory relation: same as workspace root");
    expect(system).toContain(`- Uploads directory: ${path.resolve(workspaceRoot, "User Uploads")}`);
    expect(system).toContain(
      `- Project config, memory, and MCP overrides: ${path.join(workspaceRoot, ".cowork")}`,
    );
    expect(system).toContain(
      "- Path rule: `bash`, `read`, `write`, `glob`, and `grep` default to the execution working directory.",
    );
  });

  test("buildTurnSystemPrompt describes when the working directory is inside the workspace root", async () => {
    const { workspaceRoot } = await makeTempWorkspaceConfig();
    const insideDir = path.join(workspaceRoot, "packages", "cli");
    await fs.mkdir(insideDir, { recursive: true });
    const config = makeConfig({
      projectCoworkDir: path.join(workspaceRoot, ".cowork"),
      workingDirectory: insideDir,
      uploadsDirectory: undefined,
    });

    const system = buildTurnSystemPrompt("Base system prompt", config, false);

    expect(system).toContain(
      `- Working directory relation: inside workspace root at ${path.join("packages", "cli")}`,
    );
    expect(system).toContain(`- Uploads directory: ${path.resolve(insideDir, "User Uploads")}`);
  });

  test("buildTurnSystemPrompt describes when the working directory is outside the workspace root", async () => {
    const { workspaceRoot } = await makeTempWorkspaceConfig();
    const outsideRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "active-workspace-context-outside-"),
    );
    const outsideDir = path.join(outsideRoot, "scratch");
    await fs.mkdir(outsideDir, { recursive: true });
    const config = makeConfig({
      projectCoworkDir: path.join(workspaceRoot, ".cowork"),
      workingDirectory: outsideDir,
      uploadsDirectory: undefined,
    });

    const system = buildTurnSystemPrompt("Base system prompt", config, false);

    expect(system).toContain("- Working directory relation: outside workspace root");
    expect(system).toContain(`- Execution working directory: ${outsideDir}`);
    expect(system).toContain(`- Uploads directory: ${path.resolve(outsideDir, "User Uploads")}`);
  });

  test("buildTurnSystemPrompt reports the git root for the execution cwd", async () => {
    const { workspaceRoot } = await makeTempWorkspaceConfig();
    await fs.mkdir(path.join(workspaceRoot, ".git"), { recursive: true });
    const outsideRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "active-workspace-context-other-git-"),
    );
    const outsideDir = path.join(outsideRoot, "scratch");
    await fs.mkdir(path.join(outsideRoot, ".git"), { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    const config = makeConfig({
      projectCoworkDir: path.join(workspaceRoot, ".cowork"),
      workingDirectory: outsideDir,
      uploadsDirectory: undefined,
    });

    const system = buildTurnSystemPrompt("Base system prompt", config, false);

    expect(system).toContain(`- Git root: ${outsideRoot}`);
    expect(system).not.toContain(`- Git root: ${workspaceRoot}`);
  });

  test("buildTurnSystemPrompt preserves prompt text and appends workspace context off-root", () => {
    const workspaceRoot = "/tmp/workspace-root";
    const config = makeConfig({
      projectCoworkDir: path.join(workspaceRoot, ".cowork"),
      workingDirectory: "/tmp/outside-workdir",
      uploadsDirectory: undefined,
    });
    const system = buildTurnSystemPrompt(
      [
        "- **Project-level** (`.cowork/` in the current working directory): Per-project overrides — project-specific skills, memory, config, and MCP servers.",
        "- Skills: `.cowork/skills/`, `~/.cowork/skills/`, and built-in `skills/` are all scanned in that order. For duplicate names, higher-priority tiers win.",
        "- Memory: `.cowork/AGENT.md` (project hot cache) → `~/.cowork/AGENT.md` (user hot cache). Deep storage in `.cowork/memory/` and `~/.cowork/memory/`.",
        "- MCP: `.cowork/mcp-servers.json` merged with `~/.cowork/config/mcp-servers.json`. Same-named servers: project wins.",
        "- Config: `.cowork/config.json` merged over `~/.cowork/config/config.json` over built-in defaults.",
        "User-created skills can be placed in `~/.cowork/skills/{name}/SKILL.md` (shared across projects) or `.cowork/skills/{name}/SKILL.md` (project-only).",
      ].join("\n"),
      config,
      false,
    );

    expect(system).toContain("current working directory");
    expect(system).toContain("`.cowork/config.json`");
    expect(system).toContain("`.cowork/mcp-servers.json`");
    expect(system).toContain("`.cowork/skills/{name}/SKILL.md`");
    expect(system).toContain("## Active Workspace Context");
    expect(system).toContain(`- Workspace root: ${workspaceRoot}`);
    expect(system).toContain(`- Execution working directory: /tmp/outside-workdir`);
    expect(system).toContain(
      `- Project config, memory, and MCP overrides: ${path.join(workspaceRoot, ".cowork")}`,
    );
  });

  test("deriveActiveWorkspaceContext keeps unresolved macOS case-only path changes outside the workspace", () => {
    const config = makeConfig({
      projectCoworkDir: "/Users/max/Repo/.cowork",
      workingDirectory: "/users/max/repo",
      uploadsDirectory: undefined,
    });

    const context = deriveActiveWorkspaceContext(config, "darwin");

    expect(context.workingDirectoryRelation).toBe("outside workspace root");
  });

  test("deriveActiveWorkspaceContext treats macOS case-only path changes as the same workspace when real paths match", () => {
    const originalRealpathSync = fsSync.realpathSync;
    let callCount = 0;
    (fsSync as typeof import("node:fs")).realpathSync = ((target: string | Buffer | URL) => {
      callCount += 1;
      const normalized = String(target).replaceAll("\\", "/");
      if (normalized === "/Users/max/Repo" || normalized === "/users/max/repo") {
        return "/Users/max/Repo";
      }
      throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${target}'`), {
        code: "ENOENT",
      });
    }) as typeof fsSync.realpathSync;
    const config = makeConfig({
      projectCoworkDir: "/Users/max/Repo/.cowork",
      workingDirectory: "/users/max/repo",
      uploadsDirectory: undefined,
    });

    try {
      const context = deriveActiveWorkspaceContext(config, "darwin");

      expect(callCount).toBeGreaterThan(0);
      expect(context.workingDirectoryRelation).toBe("same as workspace root");
    } finally {
      (fsSync as typeof import("node:fs")).realpathSync = originalRealpathSync;
    }
  });

  test("passes harness context into the runtime system prompt", async () => {
    const params = makeParams({
      harnessContext: {
        runId: "run-ctx",
        objective: "Verify runtime injection",
        acceptanceCriteria: ["System prompt contains harness context"],
        constraints: ["Do not override safety policy"],
        metadata: { milestone: "phase-a" },
        updatedAt: "2026-03-20T12:00:00.000Z",
      },
    });

    await runTurn(params);

    const callArg = mockRuntimeRunTurn.mock.calls[0][0] as any;
    expect(callArg.system).toContain("## Active Workspace Context");
    expect(callArg.system).toContain(
      `- Workspace root: ${path.dirname(params.config.projectCoworkDir)}`,
    );
    expect(callArg.system).toContain("## Active Harness Context");
    expect(callArg.system).toContain("- Run ID: run-ctx");
    expect(callArg.system).toContain("- Objective: Verify runtime injection");
    expect(callArg.system).toContain("1. System prompt contains harness context");
    expect(callArg.system).toContain("1. Do not override safety policy");
  });

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  test("calls runtime with the correct messages", async () => {
    const msgs = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "world" }] },
    ] as any[];
    const params = makeParams({ messages: msgs });
    await runTurn(params);

    const callArg = mockRuntimeRunTurn.mock.calls[0][0] as any;
    expect(callArg.messages).toBe(msgs);
  });

  test("preserves google tool-call history without dropping parts", async () => {
    const log = mock(() => {});
    const msgs = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call-1", toolName: "bash", input: { command: "ls" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "json", value: {} },
          },
        ],
      },
    ] as any[];

    await runTurn(makeParams({ messages: msgs, log }));

    const callArg = mockRuntimeRunTurn.mock.calls[0][0] as any;
    expect(callArg.messages).toBe(msgs);
    const serialized = JSON.stringify(callArg.messages);
    expect(serialized).toContain('"type":"tool-call"');
    expect(serialized).toContain('"type":"tool-result"');
  });

  test("keeps google includeThoughts enabled and repairs replay signatures in prepareStep", async () => {
    const log = mock(() => {});
    const providerOptions = {
      google: {
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: "high",
        },
      },
    };
    await runTurn(makeParams({ config: makeConfig({ providerOptions }), log }));
    const callArg = mockRuntimeRunTurn.mock.calls[0][0] as any;
    expect(callArg.providerOptions.google.thinkingConfig.includeThoughts).toBe(true);
    expect(callArg.providerOptions.google.thinkingConfig.thinkingLevel).toBe("high");
    expect(typeof callArg.prepareStep).toBe("function");

    const replayMessages = [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "thinking",
            providerOptions: { google: { thoughtSignature: "sig-1" } },
          },
          { type: "tool-call", toolCallId: "call-1", toolName: "bash", input: { command: "ls" } },
        ],
      },
    ] as any[];

    const prepareResult = await callArg.prepareStep({ stepNumber: 1, messages: replayMessages });
    expect(prepareResult).toBeDefined();
    expect(prepareResult.providerOptions).toBeUndefined();
    const serialized = JSON.stringify(prepareResult.messages);
    expect(serialized).toContain('"thoughtSignature":"sig-1"');
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Repaired 1 Gemini tool call"));
  });

  test("prepareStep falls back by disabling thoughts when signatures are unresolved", async () => {
    const log = mock(() => {});
    const providerOptions = {
      google: {
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: "high",
        },
      },
    };
    await runTurn(makeParams({ config: makeConfig({ providerOptions }), log }));
    const callArg = mockRuntimeRunTurn.mock.calls[0][0] as any;
    const replayMessages = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call-1", toolName: "bash", input: { command: "ls" } },
        ],
      },
    ] as any[];
    const prepareResult = await callArg.prepareStep({ stepNumber: 1, messages: replayMessages });
    expect(prepareResult).toBeDefined();
    expect(prepareResult.providerOptions.google.thinkingConfig.includeThoughts).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("disabling thoughts for this step"));
  });

  test("composes session prepareStep before google prepareStep and shallow-merges overrides", async () => {
    const log = mock(() => {});
    const providerOptions = {
      google: {
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: "high",
        },
      },
    };
    const sessionPrepareStep = mock(async ({ messages }: { messages: any[] }) => ({
      messages: [...messages, { role: "user", content: "steer" }],
      providerOptions: {
        session: { source: "steer" },
      },
      streamOptions: {
        injected: true,
      },
    }));

    await runTurn(
      makeParams({
        config: makeConfig({ providerOptions }),
        prepareStep: sessionPrepareStep,
        log,
      }),
    );

    const callArg = mockRuntimeRunTurn.mock.calls[0][0] as any;
    const replayMessages = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call-1", toolName: "bash", input: { command: "ls" } },
        ],
      },
    ] as any[];

    const prepareResult = await callArg.prepareStep({ stepNumber: 1, messages: replayMessages });
    expect(sessionPrepareStep).toHaveBeenCalledWith({
      stepNumber: 1,
      messages: replayMessages,
    });
    expect(prepareResult.messages.at(-1)).toEqual({ role: "user", content: "steer" });
    expect(prepareResult.providerOptions).toMatchObject({
      session: { source: "steer" },
      google: {
        thinkingConfig: {
          includeThoughts: false,
        },
      },
    });
    expect(prepareResult.streamOptions).toEqual({ injected: true });
  });

  test("keeps provider options unchanged for non-google providers", async () => {
    const providerOptions = { openai: { reasoningEffort: "high" } };
    const msgs = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call-1", toolName: "bash", input: { command: "ls" } },
        ],
      },
    ] as any[];

    await runTurn(
      makeParams({ config: makeConfig({ provider: "openai", providerOptions }), messages: msgs }),
    );

    const callArg = mockRuntimeRunTurn.mock.calls[0][0] as any;
    expect(callArg.providerOptions).toBe(providerOptions);
  });

  // -------------------------------------------------------------------------
  // Return text
  // -------------------------------------------------------------------------

  test("returns text from runtime result", async () => {
    mockRuntimeRunTurn.mockImplementation(async () => ({
      text: "model output text",
      reasoningText: undefined,
      responseMessages: [],
    }));

    const result = await runTurn(makeParams());
    expect(result.text).toBe("model output text");
  });

  test("preserves an empty runtime text result", async () => {
    mockRuntimeRunTurn.mockImplementation(async () => ({
      text: "",
      reasoningText: undefined,
      responseMessages: [],
    }));

    const result = await runTurn(makeParams());
    expect(result.text).toBe("");
  });

  // -------------------------------------------------------------------------
  // Reasoning text
  // -------------------------------------------------------------------------

  test("returns reasoningText when available", async () => {
    mockRuntimeRunTurn.mockImplementation(async () => ({
      text: "answer",
      reasoningText: "Let me think...",
      responseMessages: [],
    }));

    const result = await runTurn(makeParams());
    expect(result.reasoningText).toBe("Let me think...");
  });

  test("returns undefined when reasoningText is undefined", async () => {
    mockRuntimeRunTurn.mockImplementation(async () => ({
      text: "answer",
      reasoningText: undefined,
      responseMessages: [],
    }));

    const result = await runTurn(makeParams());
    expect(result.reasoningText).toBeUndefined();
  });

  test("preserves an empty reasoning string returned by the runtime", async () => {
    mockRuntimeRunTurn.mockImplementation(async () => ({
      text: "answer",
      reasoningText: "",
      responseMessages: [],
    }));

    const result = await runTurn(makeParams());
    expect(result.reasoningText).toBe("");
  });

  // -------------------------------------------------------------------------
  // Response messages
  // -------------------------------------------------------------------------

  test("returns responseMessages from result", async () => {
    const fakeMsgs: ModelMessage[] = [
      { role: "assistant", content: "first" },
      { role: "assistant", content: "second" },
    ];
    mockRuntimeRunTurn.mockImplementation(async () => ({
      text: "ok",
      reasoningText: undefined,
      responseMessages: fakeMsgs,
    }));

    const result = await runTurn(makeParams());
    expect(result.responseMessages).toEqual(fakeMsgs);
  });

  test("preserves an empty runtime message list", async () => {
    mockRuntimeRunTurn.mockImplementation(async () => ({
      text: "ok",
      reasoningText: undefined,
      responseMessages: [],
    }));

    const result = await runTurn(makeParams());
    expect(result.responseMessages).toEqual([]);
  });

  test("preserves provider continuation state returned by the runtime", async () => {
    const providerState = {
      provider: "google" as const,
      model: "gemini-3-flash-preview",
      interactionId: "interaction-1",
      updatedAt: new Date(0).toISOString(),
    };
    mockRuntimeRunTurn.mockImplementation(async () => ({
      text: "ok",
      reasoningText: undefined,
      responseMessages: [],
      providerState,
    }));

    const result = await runTurn(makeParams());
    expect(result.providerState).toBe(providerState);
  });

  // -------------------------------------------------------------------------
  // Usage
  // -------------------------------------------------------------------------

  test("keeps canonical usage counters and preserves recognized pricing fields", async () => {
    mockRuntimeRunTurn.mockImplementation(async () => ({
      text: "ok",
      reasoningText: undefined,
      responseMessages: [],
      usage: {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        cachedPromptTokens: 20,
        estimatedCostUsd: 0.1234,
        reasoningOutputTokens: 5,
      },
    }));

    const result = await runTurn(makeParams());
    expect(result.usage).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      cachedPromptTokens: 20,
      estimatedCostUsd: 0.1234,
      reasoningOutputTokens: 5,
    });
  });

  test("passes session budget update callbacks into the tool context", async () => {
    const costTracker = new SessionCostTracker("session-1");
    const onSessionUsageBudgetUpdated = mock(() => {});

    await runTurn(
      makeParams({
        costTracker,
        onSessionUsageBudgetUpdated,
      }),
    );

    const toolCtx = mockCreateTools.mock.calls[0]?.[0] as any;
    expect(toolCtx.costTracker).toBe(costTracker);
    expect(toolCtx.onSessionUsageBudgetUpdated).toBe(onSessionUsageBudgetUpdated);
  });

  test("explicit no_project_write shell policy yields a no-project-write sandbox without an agentRole", async () => {
    await runTurn(makeParams({ shellPolicy: "no_project_write" }));
    const toolCtx = mockCreateTools.mock.calls[0]?.[0] as any;
    // The precomputed sandbox policy (preferred by the bash tool) must honor the
    // no-project-write shell policy even when no agentRole is set.
    expect(toolCtx.sandboxPolicy.kind).toBe("no-project-write");
  });

  test("passes sandbox network allowance to provider-owned runtimes", async () => {
    const runtimeRunTurn = mock(async () => ({
      text: "ok",
      responseMessages: [{ role: "assistant", content: "ok" }],
    }));
    const createRuntimeForTurn = mock((_config: AgentConfig) => ({
      name: "pi" as const,
      runTurn: runtimeRunTurn,
    }));
    const createToolsForTurn = mock((_ctx: unknown) => ({
      bash: { type: "builtin" },
    }));
    const runTurnForRuntime = createRunTurn({
      createRuntime: createRuntimeForTurn,
      createTools: createToolsForTurn,
      loadMCPServers: mockLoadMCPServers,
      loadMCPTools: mockLoadMCPTools,
    });

    await runTurnForRuntime(makeParams());
    await runTurnForRuntime(
      makeParams({
        config: makeConfig({
          sandbox: { mode: "workspace-write", network: false },
        }),
      }),
    );

    const allowedRuntimeParams = runtimeRunTurn.mock.calls[0]?.[0] as
      | { networkAllowed?: boolean }
      | undefined;
    const blockedRuntimeParams = runtimeRunTurn.mock.calls[1]?.[0] as
      | { networkAllowed?: boolean }
      | undefined;
    expect(allowedRuntimeParams?.networkAllowed).toBe(true);
    expect(blockedRuntimeParams?.networkAllowed).toBe(false);
  });

  // -------------------------------------------------------------------------
  // maxSteps
  // -------------------------------------------------------------------------

  test("passes default maxSteps of 100 to the runtime", async () => {
    await runTurn(makeParams());

    expect(mockRuntimeRunTurn.mock.calls[0][0].maxSteps).toBe(100);
  });

  test("passes overridden maxSteps to the runtime", async () => {
    await runTurn(makeParams({ maxSteps: 25 }));

    expect(mockRuntimeRunTurn.mock.calls[0][0].maxSteps).toBe(25);
  });

  test("does not stop after a tool step without a task transition", async () => {
    await runTurn(makeParams());

    const callArg = mockRuntimeRunTurn.mock.calls[0][0] as any;
    expect(callArg.shouldStopAfterToolStep()).toBe(false);
  });

  test("task input directives stop the runtime after the current tool step", async () => {
    await runTurn(
      makeParams({
        taskContext: {
          id: "task-1",
          title: "Task",
          objective: "Wait for a material user decision.",
          status: "working",
          revision: 1,
          requirements: [],
          workItems: [],
          decisions: [],
          questions: [],
          blockers: [],
          artifacts: [],
          activeThreadId: "task-thread-1",
        },
        applyTaskDirective: async () => ({
          task: { id: "task-1" } as never,
          continuation: "pause_for_input",
        }),
      }),
    );

    const streamInput = mockRuntimeRunTurn.mock.calls[0]?.[0] as {
      shouldStopAfterToolStep: () => boolean;
    };
    expect(streamInput.shouldStopAfterToolStep()).toBe(false);

    const toolContext = mockCreateTools.mock.calls[0]?.[0] as {
      applyTaskDirective: (directive: unknown) => Promise<unknown>;
    };
    await toolContext.applyTaskDirective({ type: "request_input" });
    expect(streamInput.shouldStopAfterToolStep()).toBe(true);
  });

  test("successful task creation stops the source chat loop after the tool step", async () => {
    await runTurn(
      makeParams({
        createTask: async () => ({
          task: { id: "task-1" } as never,
          workspaceDisposition: "existing_project",
        }),
      }),
    );

    const streamInput = mockRuntimeRunTurn.mock.calls[0]?.[0] as {
      shouldStopAfterToolStep: () => boolean;
    };
    expect(streamInput.shouldStopAfterToolStep()).toBe(false);

    const toolContext = mockCreateTools.mock.calls[0]?.[0] as {
      createTask: (input: unknown) => Promise<unknown>;
    };
    await toolContext.createTask({ title: "Managed task" });
    expect(streamInput.shouldStopAfterToolStep()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Runtime selection
  // -------------------------------------------------------------------------

  test("passes config to the runtime factory", async () => {
    const config = makeConfig({ model: "test-model-42" });
    await runTurn(makeParams({ config }));

    expect(mockCreateRuntime).toHaveBeenCalledTimes(1);
    expect(mockCreateRuntime.mock.calls[0][0]).toBe(config);
  });

  test("passes the selected model configuration to the runtime", async () => {
    const config = makeConfig({ model: "special-model" });
    await runTurn(makeParams({ config }));

    const callArg = mockRuntimeRunTurn.mock.calls[0][0] as any;
    expect(callArg.config).toBe(config);
  });

  // -------------------------------------------------------------------------
  // providerOptions
  // -------------------------------------------------------------------------

  test("passes providerOptions from config to runtime", async () => {
    const providerOptions = { anthropic: { thinking: { type: "enabled", budgetTokens: 5000 } } };
    const config = makeConfig({ providerOptions });
    await runTurn(makeParams({ config }));

    const callArg = mockRuntimeRunTurn.mock.calls[0][0] as any;
    expect(callArg.providerOptions).toBe(providerOptions);
  });

  test("providerOptions is undefined when config has none", async () => {
    const config = makeConfig();
    delete config.providerOptions;
    await runTurn(makeParams({ config }));

    const callArg = mockRuntimeRunTurn.mock.calls[0][0] as any;
    expect(callArg.providerOptions).toBeUndefined();
  });

  test("enables metadata-only runtime telemetry when observability is configured", async () => {
    const config = makeConfig({
      observabilityEnabled: true,
      observability: {
        provider: "langfuse",
        baseUrl: "https://cloud.langfuse.com",
        otelEndpoint: "https://cloud.langfuse.com/api/public/otel/v1/traces",
        publicKey: "pk-lf-test",
        secretKey: "sk-lf-test",
      },
    });

    observabilityRuntimeInternal.setEnsureObservabilityRuntimeForTests(async () => ({
      ready: true,
      health: {
        status: "ready",
        reason: "runtime_ready",
        updatedAt: new Date(0).toISOString(),
      },
      healthChanged: false,
    }));

    await runTurn(
      makeParams({
        config,
        telemetryContext: {
          functionId: "session.turn",
          metadata: { sessionId: "session-123" },
        },
      }),
    );

    const callArg = mockRuntimeRunTurn.mock.calls[0][0] as any;
    expect(callArg.telemetry).toBeDefined();
    expect(callArg.telemetry.isEnabled).toBe(true);
    expect(callArg.telemetry.recordInputs).toBe(false);
    expect(callArg.telemetry.recordOutputs).toBe(false);
    expect(callArg.telemetry.functionId).toBe("session.turn");
    expect(callArg.telemetry.metadata.sessionId).toBe("session-123");
  });

  // -------------------------------------------------------------------------
  // Model stream passthrough
  // -------------------------------------------------------------------------

  test("passes includeRawChunks=true by default to runtime", async () => {
    await runTurn(makeParams());

    const callArg = mockRuntimeRunTurn.mock.calls[0][0] as any;
    expect(callArg.includeRawChunks).toBe(true);
  });

  test("passes includeRawChunks override to runtime", async () => {
    await runTurn(makeParams({ includeRawChunks: false }));

    const callArg = mockRuntimeRunTurn.mock.calls[0][0] as any;
    expect(callArg.includeRawChunks).toBe(false);
  });

  test("passes the stream callback to the runtime without changing event order", async () => {
    const parts = [
      { type: "start" },
      { type: "text-delta", id: "t1", text: "hello" },
      { type: "finish", finishReason: "stop" },
    ];

    mockRuntimeRunTurn.mockImplementation(async (params) => {
      for (const part of parts) await params.onModelStreamPart?.(part);
      return { text: "hello", responseMessages: [] };
    });

    const seen: unknown[] = [];
    await runTurn(
      makeParams({
        onModelStreamPart: async (part) => {
          seen.push(part);
        },
      }),
    );

    expect(seen).toEqual(parts);
  });

  test("keeps MCP connections open until the runtime completes", async () => {
    const started = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<RuntimeRunTurnResult>();
    const close = mock(async () => {});
    mockLoadMCPServers.mockResolvedValue([{ name: "test" }]);
    mockLoadMCPTools.mockResolvedValue({ tools: {}, errors: [], close } as any);
    mockRuntimeRunTurn.mockImplementation(async () => {
      started.resolve();
      return completed.promise;
    });

    const pending = runTurn(makeParams({ enableMcp: true }));
    await started.promise;
    expect(close).not.toHaveBeenCalled();
    completed.resolve({ text: "complete", responseMessages: [] });
    await expect(pending).resolves.toMatchObject({ text: "complete" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // createTools
  // -------------------------------------------------------------------------

  test("creates tools via createTools with correct context", async () => {
    const config = makeConfig();
    const log = mock(() => {});
    const askUser = mock(async () => "ok");
    const approveCommand = mock(async () => true);
    const updateTodos = mock(() => {});

    await runTurn(makeParams({ config, log, askUser, approveCommand, updateTodos }));

    expect(mockCreateTools).toHaveBeenCalledTimes(1);
    const ctx = mockCreateTools.mock.calls[0][0] as any;
    expect(ctx.config).toBe(config);
    expect(ctx.log).toBe(log);
    expect(ctx.askUser).toBe(askUser);
    expect(ctx.approveCommand).toBe(approveCommand);
    expect(ctx.updateTodos).toBe(updateTodos);
  });

  test("passes abortSignal through tool context", async () => {
    const abortController = new AbortController();
    await runTurn(makeParams({ abortSignal: abortController.signal }));

    const ctx = mockCreateTools.mock.calls[0][0] as any;
    expect(ctx.abortSignal).toBe(abortController.signal);
  });

  test("passes best-effort latest user prompt through tool context", async () => {
    await runTurn(
      makeParams({
        messages: [
          { role: "assistant", content: "hello" },
          { role: "user", content: "find the latest filing" },
        ] as any,
      }),
    );

    const ctx = mockCreateTools.mock.calls[0][0] as any;
    expect(ctx.turnUserPrompt).toBe("find the latest filing");
  });

  test("builtin tools are included in tools passed to runtime", async () => {
    mockCreateTools.mockReturnValue({ myTool: { type: "custom" } });
    await runTurn(makeParams());

    const callArg = mockRuntimeRunTurn.mock.calls[0][0] as any;
    expect(callArg.tools).toHaveProperty("myTool");
  });

  // -------------------------------------------------------------------------
  // MCP
  // -------------------------------------------------------------------------

  test("does not load MCP servers when enableMcp is false", async () => {
    await runTurn(makeParams({ enableMcp: false }));

    expect(mockLoadMCPServers).not.toHaveBeenCalled();
    expect(mockLoadMCPTools).not.toHaveBeenCalled();
  });

  test("does not load MCP servers when enableMcp is undefined", async () => {
    const params = makeParams();
    delete params.enableMcp;
    await runTurn(params);

    expect(mockLoadMCPServers).not.toHaveBeenCalled();
  });

  test("loads MCP servers and tools when enableMcp is true", async () => {
    const mcpServers = [
      { name: "test-server", transport: { type: "stdio", command: "echo", args: [] } },
    ];
    mockLoadMCPServers.mockResolvedValue(mcpServers);
    mockLoadMCPTools.mockResolvedValue({
      tools: { "mcp__test-server__foo": { type: "mcp" } },
      errors: [],
    });

    await runTurn(makeParams({ enableMcp: true }));

    expect(mockLoadMCPServers).toHaveBeenCalledTimes(1);
    expect(mockLoadMCPTools).toHaveBeenCalledTimes(1);
    expect(mockLoadMCPTools.mock.calls[0][0]).toEqual(mcpServers);
  });

  test("MCP schemas are deferred behind stable search and call tools", async () => {
    mockCreateTools.mockReturnValue({ bash: { type: "builtin" } });
    mockLoadMCPServers.mockResolvedValue([
      { name: "s", transport: { type: "stdio", command: "x", args: [] } },
    ]);
    mockLoadMCPTools.mockResolvedValue({
      tools: { mcp__s__doThing: { type: "mcp-tool" } },
      errors: [],
    });

    await runTurn(makeParams({ enableMcp: true }));

    const callArg = mockRuntimeRunTurn.mock.calls[0][0] as any;
    expect(callArg.tools).toHaveProperty("bash");
    expect(callArg.tools).not.toHaveProperty("mcp__s__doThing");
    expect(callArg.tools).toHaveProperty("toolSearch");
    expect(callArg.tools).toHaveProperty("mcpCall");
  });

  test("read-only child roles inherit parent MCP tools", async () => {
    mockCreateTools.mockReturnValue({
      read: { type: "builtin-read" },
      write: { type: "builtin-write" },
    });
    mockLoadMCPServers.mockResolvedValue([
      { name: "s", transport: { type: "stdio", command: "x", args: [] } },
    ]);
    mockLoadMCPTools.mockResolvedValue({
      tools: {
        mcp__s__search: { type: "mcp-read", annotations: { readOnlyHint: true } },
        mcp__s__mutate: { type: "mcp-write", annotations: { destructiveHint: true } },
      },
      errors: [],
    });

    await runTurn(makeParams({ enableMcp: true, agentRole: "research" }));

    const callArg = mockRuntimeRunTurn.mock.calls[0][0] as any;
    expect(Object.keys(callArg.tools).sort()).toEqual(["mcpCall", "read", "toolSearch"]);
  });

  test("an empty catalog remains searchable and hot loads into two running sessions", async () => {
    const captures: RuntimeRunTurnParams[] = [];
    const ready = Promise.withResolvers<void>();
    const done = Promise.withResolvers<RuntimeRunTurnResult>();
    mockRuntimeRunTurn.mockImplementation(async (params) => {
      captures.push(params);
      if (captures.length === 2) ready.resolve();
      return done.promise;
    });
    const first = runTurn(makeParams({ enableMcp: true, sessionId: "live-first" }));
    const second = runTurn(makeParams({ enableMcp: true, sessionId: "live-second" }));
    try {
      await ready.promise;
      const [one, two] = captures;
      expect(Object.keys(one!.tools).sort()).toEqual(["bash", "mcpCall", "read", "toolSearch"]);
      expect(one!.system).toContain("toolSearch");
      expect(await one!.tools.toolSearch!.execute({ query: "echo" })).toMatchObject({ tools: [] });
      const executeOld = mock(async (input) => ({
        content: [{ type: "text", text: input.text }],
        _meta: { source: "old" },
      }));
      const executeNew = mock(async () => ({ content: [{ type: "text", text: "replacement" }] }));
      mockLoadMCPServers.mockResolvedValue([
        { name: "echo", transport: { type: "stdio", command: "old" } },
      ]);
      mockLoadMCPTools.mockResolvedValue({
        tools: {
          mcp__echo__say: {
            description: "Echo a message",
            inputSchema: { type: "object", properties: { text: { type: "string" } } },
            execute: executeOld,
          },
        },
        errors: [],
        close: async () => {},
      } as any);
      const found = (await one!.tools.toolSearch!.execute({ query: "echo" })) as any;
      expect(found.tools.map((tool: any) => tool.name)).toEqual(["mcp__echo__say"]);
      expect(
        await two!.tools.mcpCall!.execute({
          name: found.tools[0].name,
          arguments: { text: "hello" },
        }),
      ).toEqual({ content: [{ type: "text", text: "hello" }], _meta: { source: "old" } });
      mockLoadMCPServers.mockResolvedValue([
        { name: "echo", transport: { type: "stdio", command: "new" } },
      ]);
      mockLoadMCPTools.mockResolvedValue({
        tools: { mcp__echo__say: { execute: executeNew } },
        errors: [],
        close: async () => {},
      } as any);
      await one!.tools.mcpCall!.execute({ name: "mcp__echo__say", arguments: {} });
      expect(executeNew).toHaveBeenCalledTimes(1);
      expect(executeOld).toHaveBeenCalledTimes(1);
      mockLoadMCPServers.mockResolvedValue([]);
      await expect(
        two!.tools.mcpCall!.execute({ name: "mcp__echo__say", arguments: {} }),
      ).rejects.toThrow("not available");
    } finally {
      done.resolve({ text: "done", responseMessages: [] });
      await Promise.all([first, second]);
      await Promise.all([
        closeMcpServersForSession("live-first"),
        closeMcpServersForSession("live-second"),
      ]);
    }
  });

  test("forwards modelSettings maxRetries to runtime", async () => {
    const config = makeConfig({
      modelSettings: {
        maxRetries: 1,
      },
    });

    await runTurn(makeParams({ config }));

    const callArg = mockRuntimeRunTurn.mock.calls[0][0] as any;
    expect(callArg.config.modelSettings.maxRetries).toBe(1);
  });

  test("passes onModelError through to the runtime", async () => {
    const onModelError = mock(async () => {});
    await runTurn(makeParams({ onModelError }));

    const callArg = mockRuntimeRunTurn.mock.calls[0][0] as any;
    expect(callArg.onModelError).toBe(onModelError);
    await callArg.onModelError(new Error("stream failed"));
    expect(onModelError).toHaveBeenCalledTimes(1);
  });

  test("passes onModelAbort through to the runtime", async () => {
    const onModelAbort = mock(async () => {});
    await runTurn(makeParams({ onModelAbort }));

    const callArg = mockRuntimeRunTurn.mock.calls[0][0] as any;
    expect(callArg.onModelAbort).toBe(onModelAbort);
    await callArg.onModelAbort();
    expect(onModelAbort).toHaveBeenCalledTimes(1);
  });

  test("does not call loadMCPTools when no servers are configured", async () => {
    mockLoadMCPServers.mockResolvedValue([]);

    await runTurn(makeParams({ enableMcp: true }));

    expect(mockLoadMCPServers).toHaveBeenCalled();
    expect(mockLoadMCPTools).not.toHaveBeenCalled();
  });

  test("passes log function to loadMCPTools opts", async () => {
    const logFn = mock(() => {});
    mockLoadMCPServers.mockResolvedValue([
      { name: "a", transport: { type: "stdio", command: "x", args: [] } },
    ]);
    mockLoadMCPTools.mockResolvedValue({ tools: {}, errors: [] });

    await runTurn(makeParams({ enableMcp: true, log: logFn }));

    const opts = mockLoadMCPTools.mock.calls[0][1] as any;
    expect(opts.log).toBe(logFn);
  });

  test("invokes onMcpLoadErrors when MCP servers fail to load tools", async () => {
    const onMcpLoadErrors = mock((_errors: string[]) => {});
    mockLoadMCPServers.mockResolvedValue([
      { name: "broken", transport: { type: "stdio", command: "x", args: [] } },
    ]);
    mockLoadMCPTools.mockResolvedValue({
      tools: {},
      errors: ["[MCP] Failed to connect to broken after 4 attempts: boom"],
    });

    await runTurn(makeParams({ enableMcp: true, onMcpLoadErrors }));

    expect(onMcpLoadErrors).toHaveBeenCalledTimes(1);
    expect(onMcpLoadErrors.mock.calls[0][0]).toEqual([
      "[MCP] Failed to connect to broken after 4 attempts: boom",
    ]);
  });

  test("does not invoke onMcpLoadErrors when MCP tools load cleanly", async () => {
    const onMcpLoadErrors = mock((_errors: string[]) => {});
    mockLoadMCPServers.mockResolvedValue([
      { name: "ok", transport: { type: "stdio", command: "x", args: [] } },
    ]);
    mockLoadMCPTools.mockResolvedValue({
      tools: { mcp__ok__tool: { type: "mcp-tool" } },
      errors: [],
    });

    await runTurn(makeParams({ enableMcp: true, onMcpLoadErrors }));

    expect(onMcpLoadErrors).not.toHaveBeenCalled();
  });

  test("logs MCP close errors instead of swallowing them", async () => {
    const logLines: string[] = [];
    mockLoadMCPServers.mockResolvedValue([
      { name: "srv", transport: { type: "stdio", command: "x", args: [] } },
    ]);
    mockLoadMCPTools.mockResolvedValue({
      tools: {},
      errors: [],
      close: async () => {
        throw new Error("close exploded");
      },
    });

    await runTurn(makeParams({ enableMcp: true, log: (line: string) => logLines.push(line) }));

    expect(logLines.some((line) => line.includes("Error closing MCP servers"))).toBe(true);
    expect(logLines.some((line) => line.includes("close exploded"))).toBe(true);
  });

  test("starts observability init and MCP tool load concurrently", async () => {
    let resolveMcpServers!: (servers: any[]) => void;
    mockLoadMCPServers.mockImplementation(
      () => new Promise<any[]>((resolve) => (resolveMcpServers = resolve)),
    );

    let observabilityInitStarted = false;
    let resolveObservability!: (result: any) => void;
    observabilityRuntimeInternal.setEnsureObservabilityRuntimeForTests(
      () =>
        new Promise<any>((resolve) => {
          observabilityInitStarted = true;
          resolveObservability = resolve;
        }),
    );

    const turnPromise = runTurn(makeParams({ enableMcp: true }));

    // Give the turn a chance to reach the concurrent cold-start barrier.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The MCP load is still in flight, but observability init has already
    // started — sequentially it only ran after the MCP load completed.
    expect(mockLoadMCPServers).toHaveBeenCalledTimes(1);
    expect(observabilityInitStarted).toBe(true);

    resolveMcpServers([]);
    resolveObservability({
      ready: false,
      health: {
        status: "disabled",
        reason: "observability_disabled",
        updatedAt: new Date(0).toISOString(),
      },
      healthChanged: false,
    });
    await turnPromise;
    expect(mockRuntimeRunTurn).toHaveBeenCalledTimes(1);
  });

  test("closes MCP connections when a sibling cold-start step fails", async () => {
    const closeMcp = mock(async () => {});
    mockLoadMCPServers.mockResolvedValue([
      { name: "srv", transport: { type: "stdio", command: "x", args: [] } },
    ]);
    mockLoadMCPTools.mockResolvedValue({ tools: {}, errors: [], close: closeMcp });
    observabilityRuntimeInternal.setEnsureObservabilityRuntimeForTests(async () => {
      throw new Error("otel exploded");
    });

    await expect(runTurn(makeParams({ enableMcp: true }))).rejects.toThrow("otel exploded");
    expect(closeMcp).toHaveBeenCalledTimes(1);
    expect(mockRuntimeRunTurn).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Error propagation
  // -------------------------------------------------------------------------

  test("propagates errors from runtime", async () => {
    mockRuntimeRunTurn.mockRejectedValue(new Error("API rate limit exceeded"));

    await expect(runTurn(makeParams())).rejects.toThrow("API rate limit exceeded");
  });

  test("propagates errors from loadMCPServers", async () => {
    mockLoadMCPServers.mockRejectedValue(new Error("MCP server config error"));

    await expect(runTurn(makeParams({ enableMcp: true }))).rejects.toThrow(
      "MCP server config error",
    );
  });

  test("propagates errors from loadMCPTools", async () => {
    mockLoadMCPServers.mockResolvedValue([
      { name: "x", transport: { type: "stdio", command: "y", args: [] } },
    ]);
    mockLoadMCPTools.mockRejectedValue(new Error("Required MCP server failed"));

    await expect(runTurn(makeParams({ enableMcp: true }))).rejects.toThrow(
      "Required MCP server failed",
    );
  });

  test("propagates errors from createTools", async () => {
    mockCreateTools.mockImplementation(() => {
      throw new Error("Tool init failure");
    });

    await expect(runTurn(makeParams())).rejects.toThrow("Tool init failure");

    // restore default
    mockCreateTools.mockReturnValue({ bash: { type: "builtin" } });
  });
});
