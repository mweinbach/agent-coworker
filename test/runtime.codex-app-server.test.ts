import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import { __internal as codexAppServerClientInternal } from "../src/providers/codexAppServerClient";
import { createRuntime } from "../src/runtime";
import { VERSION } from "../src/version";
import { createMockClient, writeMockAppServer } from "./fixtures/codexAppServerMock";
import {
  expectedManagedSofficeShimPath,
  installCodexAppServerTestHooks,
  makeConfig,
  readCapturedRequests,
  testNodeCommand,
} from "./runtime/codex-app-server/helpers";

installCodexAppServerTestHooks();

describe("codex app-server runtime", () => {
  test.serial("passes the prepared tool env into pooled app-server clients", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-env-"));
    let receivedOpts:
      | Parameters<
          NonNullable<Parameters<typeof codexAppServerClientInternal.setClientFactoryForTests>[0]>
        >[0]
      | null = null;
    codexAppServerClientInternal.setClientFactoryForTests(async (opts) => {
      receivedOpts = opts;
      return createMockClient();
    });

    const runtime = createRuntime(makeConfig(dir));
    await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are Codex.",
      messages: [{ role: "user", content: "Say hi" }],
      tools: {},
      maxSteps: 1,
      toolEnv: {
        PATH: "/tmp/cowork-managed-bin",
        COWORK_SOFFICE: "/tmp/cowork-managed-bin/soffice",
      },
    });

    expect(receivedOpts?.env).toMatchObject({
      PATH: "/tmp/cowork-managed-bin",
      COWORK_SOFFICE: "/tmp/cowork-managed-bin/soffice",
    });
  });

  test.serial("prepares managed soffice env and instructions for app-server turns", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-soffice-"));
    const home = path.join(dir, "home");
    const capturePath = path.join(dir, "requests.jsonl");
    await fs.mkdir(home, { recursive: true });
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;

    let receivedOpts:
      | Parameters<
          NonNullable<Parameters<typeof codexAppServerClientInternal.setClientFactoryForTests>[0]>
        >[0]
      | null = null;
    codexAppServerClientInternal.setClientFactoryForTests(async (opts) => {
      receivedOpts = opts;
      return createMockClient();
    });

    try {
      const runtime = createRuntime(makeConfig(dir));
      await runtime.runTurn({
        config: makeConfig(dir),
        system: "You are Codex.",
        messages: [{ role: "user", content: "Say hi" }],
        tools: {},
        maxSteps: 1,
      });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }

    const shimDir = path.join(home, ".cache", "cowork", "libreoffice", "bin");
    const shimPath = expectedManagedSofficeShimPath(shimDir);
    expect(receivedOpts?.env?.COWORK_SOFFICE).toBe(shimPath);
    expect(receivedOpts?.env?.COWORK_MANAGED_SOFFICE_SHIM_DIR).toBe(shimDir);
    const pathEnvKey = Object.keys(receivedOpts?.env ?? {}).find(
      (key) => key.toLowerCase() === "path",
    );
    expect(pathEnvKey ? receivedOpts?.env?.[pathEnvKey]?.split(path.delimiter)[0] : undefined).toBe(
      shimDir,
    );

    const requests = await readCapturedRequests(capturePath);
    const startParams = requests.find((entry) => entry.method === "thread/start")?.params;
    expect(startParams?.baseInstructions).toContain("Managed LibreOffice Runtime");
    expect(startParams?.baseInstructions).toContain(shimPath);
    if (process.platform === "win32") {
      expect(startParams?.baseInstructions).toContain(`$env:PATH = '${shimDir};' + $env:PATH`);
    } else {
      expect(startParams?.baseInstructions).toContain(`PATH=${shimDir}:$PATH`);
    }
  });

  test.serial("adds Codex workspace dependency instructions for app-server turns", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-runtime-"));
    const capturePath = path.join(dir, "requests.jsonl");
    const nodeModulesPath = path.join(dir, "runtime", "node", "node_modules");
    const nodePath = path.join(
      dir,
      "runtime",
      "node",
      "bin",
      process.platform === "win32" ? "node.exe" : "node",
    );
    const resolverPath = path.join(dir, "runtime", "node-resolver", "register.mjs");
    process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;

    const runtime = createRuntime(makeConfig(dir));
    await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are Codex.",
      messages: [{ role: "user", content: "Say hi" }],
      tools: {},
      maxSteps: 1,
      toolEnv: {
        PATH: "/tmp/cowork-managed-bin",
        COWORK_SOFFICE: path.join(dir, "soffice"),
        COWORK_CODEX_RUNTIME_NODE: nodePath,
        COWORK_CODEX_RUNTIME_NODE_MODULES: nodeModulesPath,
        COWORK_CODEX_RUNTIME_NODE_RESOLVER: resolverPath,
      },
    });

    const requests = await readCapturedRequests(capturePath);
    const startParams = requests.find((entry) => entry.method === "thread/start")?.params;
    expect(startParams?.baseInstructions).toContain("Codex Workspace Dependencies");
    expect(startParams?.baseInstructions).toContain(nodePath);
    expect(startParams?.baseInstructions).toContain("bare imports");
    expect(startParams?.baseInstructions).toContain('import "@oai/artifact-tool"');
    expect(startParams?.baseInstructions).not.toContain(
      process.platform === "win32" ? "cmd /c mklink /J" : "ln -s",
    );
  });

  test("includes Codex dependency paths in app-server pool fingerprints", () => {
    const base = codexAppServerClientInternal.pooledEnvFingerprint({
      PATH: "/bin",
      COWORK_CODEX_RUNTIME_NODE: "/runtime/node/bin/node",
      COWORK_CODEX_RUNTIME_NODE_MODULES: "/runtime/node/node_modules-a",
      COWORK_CODEX_RUNTIME_NODE_RESOLVER: "/runtime/node-resolver/register.mjs",
    });
    const changed = codexAppServerClientInternal.pooledEnvFingerprint({
      PATH: "/bin",
      COWORK_CODEX_RUNTIME_NODE: "/runtime/node/bin/node",
      COWORK_CODEX_RUNTIME_NODE_MODULES: "/runtime/node/node_modules-b",
      COWORK_CODEX_RUNTIME_NODE_RESOLVER: "/runtime/node-resolver/register.mjs",
    });

    expect(base).not.toBe(changed);
    expect(base).toContain("COWORK_CODEX_RUNTIME_NODE_MODULES");
  });

  test.serial("initializes app-server with the Cowork package version", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-init-"));
    const script = await writeMockAppServer(dir);
    const capturePath = path.join(dir, "requests.jsonl");
    process.env.COWORK_CODEX_APP_SERVER_COMMAND = testNodeCommand;
    process.env.COWORK_CODEX_APP_SERVER_ARGS = script;
    process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;

    const runtime = createRuntime(makeConfig(dir));
    await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are Codex.",
      messages: [{ role: "user", content: "Say hi" }],
      tools: {},
      maxSteps: 1,
    });

    const requests = await readCapturedRequests(capturePath);
    expect(requests.find((entry) => entry.method === "initialize")?.params).toEqual({
      clientInfo: {
        name: "agent-coworker",
        title: "Agent Coworker",
        version: VERSION,
      },
      capabilities: { experimentalApi: true },
    });
  });

  test.serial("drives a turn through codex app-server JSONL", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-runtime-"));
    const script = await writeMockAppServer(dir);
    process.env.COWORK_CODEX_APP_SERVER_COMMAND = testNodeCommand;
    process.env.COWORK_CODEX_APP_SERVER_ARGS = script;

    const streamParts: unknown[] = [];
    const rawEvents: unknown[] = [];
    const timeline: Array<{ type: "raw" | "part"; value: unknown }> = [];
    const runtime = createRuntime(makeConfig(dir));
    const result = await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are Codex.",
      messages: [{ role: "user", content: "Say hi" }],
      tools: {},
      maxSteps: 1,
      onModelStreamPart: (part) => {
        streamParts.push(part);
        timeline.push({ type: "part", value: part });
      },
      onModelRawEvent: (event) => {
        rawEvents.push(event);
        timeline.push({ type: "raw", value: event });
      },
    });

    expect(result.text).toBe("hello from app-server");
    expect(result.usage).toEqual({
      promptTokens: 3,
      completionTokens: 4,
      totalTokens: 7,
      cachedPromptTokens: 0,
      reasoningOutputTokens: 2,
    });
    expect(result.providerState).toMatchObject({
      provider: "codex-cli",
      model: "gpt-5.4",
      threadId: "thread_1",
    });
    expect(streamParts.some((part) => (part as { type?: string }).type === "text-delta")).toBe(
      true,
    );
    expect(rawEvents).toContainEqual(
      expect.objectContaining({
        format: "codex-app-server-v2",
      }),
    );
    expect(rawEvents).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          direction: "client_request",
          message: expect.objectContaining({
            method: "turn/start",
            params: expect.objectContaining({
              threadId: "thread_1",
              input: [{ type: "text", text: "User: Say hi", text_elements: [] }],
            }),
          }),
        }),
      }),
    );
    expect(rawEvents).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          direction: "server_response",
          message: expect.objectContaining({
            result: expect.objectContaining({
              turn: expect.objectContaining({ id: "turn_1" }),
            }),
          }),
        }),
      }),
    );
    const rawDeltaIndex = timeline.findIndex(({ type, value }) => {
      const raw = value as {
        event?: { direction?: string; message?: { method?: string; params?: { delta?: string } } };
      };
      return (
        type === "raw" &&
        raw.event?.direction === "server_notification" &&
        raw.event.message?.method === "item/agentMessage/delta" &&
        raw.event.message.params?.delta === "hello from app-server"
      );
    });
    const textDeltaIndex = timeline.findIndex(
      ({ type, value }) => type === "part" && (value as { type?: string }).type === "text-delta",
    );
    expect(rawDeltaIndex).toBeGreaterThanOrEqual(0);
    expect(textDeltaIndex).toBeGreaterThanOrEqual(0);
    expect(rawDeltaIndex).toBeLessThanOrEqual(textDeltaIndex);
  });

  test.serial("ignores pooled app-server title-generation events from other threads", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-title-leak-"));
    process.env.COWORK_CODEX_APP_SERVER_ARGS = "cross-thread-title-leak";

    const streamParts: unknown[] = [];
    const rawEvents: unknown[] = [];
    const runtime = createRuntime(makeConfig(dir));
    const result = await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are Codex.",
      messages: [{ role: "user", content: "Say hi" }],
      tools: {},
      maxSteps: 1,
      onModelStreamPart: (part) => {
        streamParts.push(part);
      },
      onModelRawEvent: (event) => {
        rawEvents.push(event);
      },
    });

    expect(result.text).toBe("hello from app-server");
    expect(JSON.stringify(streamParts)).not.toContain("Leaked Generated Title");
    expect(JSON.stringify(rawEvents)).not.toContain("Leaked Generated Title");
  });

  test.serial(
    "forwards Codex verbosity and rich web search config to app-server threads",
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-config-"));
      const script = await writeMockAppServer(dir);
      const capturePath = path.join(dir, "requests.jsonl");
      process.env.COWORK_CODEX_APP_SERVER_COMMAND = testNodeCommand;
      process.env.COWORK_CODEX_APP_SERVER_ARGS = script;
      process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;

      const config = {
        ...makeConfig(dir),
        providerOptions: {
          "codex-cli": {
            textVerbosity: "high",
            webSearchMode: "live",
            webSearch: {
              contextSize: "high",
              allowedDomains: ["openai.com", "platform.openai.com"],
              location: {
                country: "US",
                region: "CA",
                city: "San Francisco",
                timezone: "America/Los_Angeles",
              },
            },
          },
        },
      };
      const runtime = createRuntime(config);
      await runtime.runTurn({
        config,
        providerOptions: config.providerOptions,
        system: "You are Codex.",
        messages: [{ role: "user", content: "Say hi" }],
        tools: {},
        maxSteps: 1,
      });

      const requests = await readCapturedRequests(capturePath);
      expect(requests.find((entry) => entry.method === "thread/start")?.params.config).toEqual({
        web_search: "live",
        model_verbosity: "high",
        tools: {
          web_search: {
            context_size: "high",
            allowed_domains: ["openai.com", "platform.openai.com"],
            location: {
              country: "US",
              region: "CA",
              city: "San Francisco",
              timezone: "America/Los_Angeles",
            },
          },
        },
      });
    },
  );

  test.serial("does not emit empty rich web search config", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-empty-web-"));
    const script = await writeMockAppServer(dir);
    const capturePath = path.join(dir, "requests.jsonl");
    process.env.COWORK_CODEX_APP_SERVER_COMMAND = testNodeCommand;
    process.env.COWORK_CODEX_APP_SERVER_ARGS = script;
    process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;

    const config = {
      ...makeConfig(dir),
      providerOptions: {
        "codex-cli": {
          webSearchMode: "cached",
          webSearch: {
            allowedDomains: [],
            location: {},
          },
        },
      },
    };
    const runtime = createRuntime(config);
    await runtime.runTurn({
      config,
      providerOptions: config.providerOptions,
      system: "You are Codex.",
      messages: [{ role: "user", content: "Say hi" }],
      tools: {},
      maxSteps: 1,
    });

    const requests = await readCapturedRequests(capturePath);
    expect(requests.find((entry) => entry.method === "thread/start")?.params.config).toEqual({
      web_search: "cached",
    });
  });

  test.serial("normalizes Codex reasoning effort sentinels before turn/start", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-effort-"));
    const capturePath = path.join(dir, "requests.jsonl");
    process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;

    const highConfig = {
      ...makeConfig(dir),
      providerOptions: {
        "codex-cli": {
          reasoningEffort: "xhigh",
        },
      },
    };
    const runtime = createRuntime(highConfig);
    await runtime.runTurn({
      config: highConfig,
      providerOptions: highConfig.providerOptions,
      system: "You are Codex.",
      messages: [{ role: "user", content: "Say hi" }],
      tools: {},
      maxSteps: 1,
    });

    const xhighRequests = await readCapturedRequests(capturePath);
    expect(xhighRequests.find((entry) => entry.method === "turn/start")?.params.effort).toBe(
      "high",
    );

    await fs.writeFile(capturePath, "", "utf-8");
    const noneConfig = {
      ...makeConfig(dir),
      providerOptions: {
        "codex-cli": {
          reasoningEffort: "none",
        },
      },
    };
    await runtime.runTurn({
      config: noneConfig,
      providerOptions: noneConfig.providerOptions,
      system: "You are Codex.",
      messages: [{ role: "user", content: "Say hi" }],
      tools: {},
      maxSteps: 1,
    });

    const noneRequests = await readCapturedRequests(capturePath);
    expect(noneRequests.find((entry) => entry.method === "turn/start")?.params).not.toHaveProperty(
      "effort",
    );
  });

  test.serial(
    "uses app-server default model when stored Codex model is not available",
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-model-"));
      const script = path.join(dir, "model-gated-codex-app-server.js");
      const capturePath = path.join(dir, "requests.jsonl");
      await fs.writeFile(
        script,
        `
const readline = require("node:readline");
const fs = require("node:fs");
const rl = readline.createInterface({ input: process.stdin });
process.stdin.resume();
setInterval(() => {}, 1000);
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
function capture(msg) {
  if (!process.env.CODEX_APP_SERVER_CAPTURE_PATH) return;
  if (msg.method === "thread/start" || msg.method === "turn/start") {
    fs.appendFileSync(process.env.CODEX_APP_SERVER_CAPTURE_PATH, JSON.stringify({ method: msg.method, params: msg.params }) + "\\n");
  }
}
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  capture(msg);
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { userAgent: "mock" } });
    return;
  }
  if (msg.method === "initialized") return;
  if (msg.method === "model/list") {
    send({ id: msg.id, result: { data: [
      { id: "gpt-5.3-codex-spark", model: "gpt-5.3-codex-spark", displayName: "Spark", isDefault: true }
    ], nextCursor: null } });
    return;
  }
  if (msg.method === "thread/start") {
    if (msg.params.model !== "gpt-5.3-codex-spark") {
      send({ id: msg.id, error: { message: "The '" + msg.params.model + "' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again." } });
      return;
    }
    send({ id: msg.id, result: { thread: { id: "thread_1", modelProvider: "openai", turns: [] } } });
    return;
  }
  if (msg.method === "turn/start") {
    if (msg.params.model !== "gpt-5.3-codex-spark") {
      send({ id: msg.id, error: { message: "wrong model" } });
      return;
    }
    send({ id: msg.id, result: { turn: { id: "turn_1", status: "inProgress", items: [], error: null } } });
    send({ method: "turn/completed", params: { turn: { id: "turn_1", status: "completed", items: [{ type: "agentMessage", id: "item_1", text: "fallback ok" }], error: null } } });
  }
});
`,
        "utf-8",
      );
      process.env.COWORK_CODEX_APP_SERVER_COMMAND = testNodeCommand;
      process.env.COWORK_CODEX_APP_SERVER_ARGS = script;
      process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;

      const logs: string[] = [];
      const runtime = createRuntime(makeConfig(dir));
      const result = await runtime.runTurn({
        config: makeConfig(dir),
        system: "You are Codex.",
        messages: [{ role: "user", content: "Say hi" }],
        tools: {},
        maxSteps: 1,
        log: (line) => logs.push(line),
      });

      expect(result.text).toBe("fallback ok");
      expect(result.providerState).toMatchObject({
        provider: "codex-cli",
        model: "gpt-5.3-codex-spark",
      });
      expect(logs.join("\n")).toContain(
        'model "gpt-5.4" is not available from the resolved app-server',
      );
      const requests = await readCapturedRequests(capturePath);
      expect(requests.find((entry) => entry.method === "thread/start")?.params.model).toBe(
        "gpt-5.3-codex-spark",
      );
      expect(requests.find((entry) => entry.method === "turn/start")?.params.model).toBe(
        "gpt-5.3-codex-spark",
      );
    },
  );

  test.serial("registers Cowork coordination tools as Codex dynamic tools", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-tools-"));
    const script = await writeMockAppServer(dir);
    const capturePath = path.join(dir, "requests.jsonl");
    process.env.COWORK_CODEX_APP_SERVER_COMMAND = testNodeCommand;
    process.env.COWORK_CODEX_APP_SERVER_ARGS = script;
    process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;

    const runtime = createRuntime(makeConfig(dir));
    await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are Codex.\n\n## Enabled Plugin Bundles\n\nCowork plugin example.",
      messages: [{ role: "user", content: "Say hi" }],
      tools: {
        spawnAgent: {
          description: "Spawn a Cowork subagent.",
          inputSchema: z.object({ task: z.string() }),
          execute: () => "spawned",
        },
        mcp__srv__custom: {
          description: "A Cowork-managed MCP tool.",
          inputSchema: { type: "object", properties: { query: { type: "string" } } },
          execute: () => "mcp ok",
        },
        bash: {
          description: "Cowork bash should already be filtered before runtime.",
          execute: () => "should not be called",
        },
      },
      maxSteps: 1,
    });

    const requests = await readCapturedRequests(capturePath);
    const startParams = requests.find((entry) => entry.method === "thread/start")?.params;
    expect(startParams).toMatchObject({
      modelProvider: "openai",
      experimentalRawEvents: true,
    });
    expect(startParams).not.toHaveProperty("tools");
    expect(startParams?.dynamicTools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "spawnAgent",
          description: "Spawn a Cowork subagent.",
          inputSchema: expect.objectContaining({ type: "object" }),
        }),
        expect.objectContaining({
          name: "cowork_mcp__srv__custom",
          description: "A Cowork-managed MCP tool.",
          inputSchema: expect.objectContaining({ type: "object" }),
        }),
      ]),
    );
    expect(
      (startParams?.dynamicTools as Array<{ name?: string }>).map((tool) => tool.name),
    ).not.toContain("bash");
    expect(startParams?.baseInstructions).toContain("## Codex App-Server Tool Boundary");
    expect(startParams?.baseInstructions).toContain(
      "Codex app-server handles shell, filesystem, sandboxing, approvals, and native web search/fetch for this turn.",
    );
    expect(startParams?.baseInstructions).toContain(
      "Cowork exposes coordination tools and Cowork MCP as dynamic tools.",
    );
  });

  test.serial("handles Codex dynamic tool call server requests", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-dynamic-tools-"));
    process.env.COWORK_CODEX_APP_SERVER_ARGS = "dynamic-tool-call";

    const rawEvents: unknown[] = [];
    const runtime = createRuntime(makeConfig(dir));
    await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are Codex.",
      messages: [{ role: "user", content: "Use dynamic tools" }],
      tools: {
        structuredTool: {
          description: "Return structured data.",
          inputSchema: z.object({ value: z.string() }),
          execute: (input) => ({ ok: true, input }),
        },
        mcp__srv__custom: {
          description: "A Cowork-managed MCP tool.",
          inputSchema: z.object({ query: z.string() }),
          execute: (input) => ({ mcp: true, input }),
        },
        validatedTool: {
          description: "Validate input.",
          inputSchema: z.object({ count: z.number() }),
          execute: () => "valid",
        },
        throwsTool: {
          description: "Throw for testing.",
          execute: () => {
            throw new Error("boom");
          },
        },
      },
      maxSteps: 1,
      onModelRawEvent: (event) => {
        rawEvents.push(event);
      },
    });

    const dynamicResponses = rawEvents
      .map((event) => (event as { event?: { direction?: string; message?: unknown } }).event)
      .filter((event) => event?.direction === "client_response")
      .map((event) => event?.message as { result?: unknown })
      .map((message) => message.result)
      .filter((result) => {
        const record = result as { contentItems?: unknown };
        return Array.isArray(record?.contentItems);
      }) as Array<{ success: boolean; contentItems: Array<{ text: string }> }>;

    expect(dynamicResponses).toHaveLength(5);
    const structuredText = dynamicResponses[0]?.contentItems[0]?.text;
    expect(dynamicResponses[0]).toMatchObject({
      success: true,
      contentItems: [{ type: "inputText", text: expect.stringContaining('"ok": true') }],
    });
    expect(structuredText).toContain('"value": "ok"');
    const mcpText = dynamicResponses[1]?.contentItems[0]?.text;
    expect(dynamicResponses[1]?.success).toBe(true);
    expect(mcpText).toContain('"mcp": true');
    expect(mcpText).toContain('"query": "ok"');
    expect(dynamicResponses[2]).toMatchObject({
      success: false,
      contentItems: [{ text: expect.stringContaining("unknownTool") }],
    });
    expect(dynamicResponses[3]).toMatchObject({
      success: false,
      contentItems: [{ text: expect.stringContaining("validatedTool") }],
    });
    expect(dynamicResponses[4]).toMatchObject({
      success: false,
      contentItems: [{ text: expect.stringContaining("boom") }],
    });
  });

  test.serial(
    "passes workspace-write sandbox and approval prompts for regular Codex turns",
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-sandbox-"));
      const script = await writeMockAppServer(dir);
      const capturePath = path.join(dir, "requests.jsonl");
      process.env.COWORK_CODEX_APP_SERVER_COMMAND = testNodeCommand;
      process.env.COWORK_CODEX_APP_SERVER_ARGS = script;
      process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;

      const runtime = createRuntime(makeConfig(dir));
      await runtime.runTurn({
        config: makeConfig(dir),
        system: "You are Codex.",
        messages: [{ role: "user", content: "Say hi" }],
        tools: {},
        maxSteps: 1,
        yolo: false,
        shellPolicy: "full",
        approveCommand: async () => true,
      });

      const requests = await readCapturedRequests(capturePath);
      expect(requests.find((entry) => entry.method === "thread/start")?.params).toMatchObject({
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      });
      expect(requests.find((entry) => entry.method === "turn/start")?.params).toMatchObject({
        approvalPolicy: "on-request",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [dir],
          networkAccess: true,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      });
    },
  );

  test.serial("passes danger-full-access sandbox when the session is in yolo mode", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-yolo-"));
    const script = await writeMockAppServer(dir);
    const capturePath = path.join(dir, "requests.jsonl");
    process.env.COWORK_CODEX_APP_SERVER_COMMAND = testNodeCommand;
    process.env.COWORK_CODEX_APP_SERVER_ARGS = script;
    process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;

    const runtime = createRuntime(makeConfig(dir));
    await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are Codex.",
      messages: [{ role: "user", content: "Say hi" }],
      tools: {},
      maxSteps: 1,
      yolo: true,
      shellPolicy: "full",
    });

    const requests = await readCapturedRequests(capturePath);
    expect(requests.find((entry) => entry.method === "thread/start")?.params).toMatchObject({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    expect(requests.find((entry) => entry.method === "turn/start")?.params).toMatchObject({
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
  });

  test.serial("passes read-only sandbox for read-only subagent shell policy", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-readonly-"));
    const script = await writeMockAppServer(dir);
    const capturePath = path.join(dir, "requests.jsonl");
    process.env.COWORK_CODEX_APP_SERVER_COMMAND = testNodeCommand;
    process.env.COWORK_CODEX_APP_SERVER_ARGS = script;
    process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;

    const runtime = createRuntime(makeConfig(dir));
    await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are a read-only child agent.",
      messages: [{ role: "user", content: "Inspect only" }],
      tools: {},
      maxSteps: 1,
      yolo: true,
      shellPolicy: "no_project_write",
    });

    const requests = await readCapturedRequests(capturePath);
    expect(requests.find((entry) => entry.method === "thread/start")?.params).toMatchObject({
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    expect(requests.find((entry) => entry.method === "turn/start")?.params).toMatchObject({
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: true },
    });
  });
});
