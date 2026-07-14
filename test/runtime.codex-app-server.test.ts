import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import { CHATS_FOLDER, resolveMemoryFolderName } from "../src/advancedMemory/store";
import { canonicalizeRoot, scratchRoots, tmpScratchRoots } from "../src/platform/sandbox/policy";
import {
  type CodexAppServerClient,
  type CodexAppServerJsonRpcNotification,
  type CodexAppServerJsonRpcRawMessage,
  __internal as codexAppServerClientInternal,
} from "../src/providers/codexAppServerClient";
import { createRuntime } from "../src/runtime";
import { handleServerRequest } from "../src/runtime/codexAppServer/serverRequests";
import { VERSION } from "../src/version";
import {
  createMockClient,
  mockInterrupts,
  writeMockAppServer,
} from "./fixtures/codexAppServerMock";
import {
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
        COWORK_TEST_TOOL_ENV: "preserved",
      },
    });

    expect(receivedOpts?.env).toMatchObject({
      PATH: "/tmp/cowork-managed-bin",
      COWORK_TEST_TOOL_ENV: "preserved",
    });
  });

  test.serial("adds Cowork runtime dependency instructions for app-server turns", async () => {
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
        COWORK_RUNTIME_NODE: nodePath,
        COWORK_RUNTIME_NODE_MODULES: nodeModulesPath,
        COWORK_RUNTIME_NODE_RESOLVER: resolverPath,
      },
    });

    const requests = await readCapturedRequests(capturePath);
    const startParams = requests.find((entry) => entry.method === "thread/start")?.params;
    expect(startParams).not.toHaveProperty("baseInstructions");
    expect(startParams?.developerInstructions).toContain("Cowork Runtime");
    expect(startParams?.developerInstructions).toContain(nodePath);
    expect(startParams?.developerInstructions).toContain("Bare Node imports");
    expect(startParams?.developerInstructions).toContain("@oai/artifact-tool");
    expect(startParams?.developerInstructions).not.toContain("cmd /c mklink /J");
    expect(startParams?.developerInstructions).not.toContain("ln -s");
  });

  test("includes Cowork runtime dependency paths in app-server pool fingerprints", () => {
    const base = codexAppServerClientInternal.pooledEnvFingerprint({
      PATH: "/bin",
      COWORK_RUNTIME_NODE: "/runtime/node/bin/node",
      COWORK_RUNTIME_NODE_MODULES: "/runtime/node/node_modules-a",
      COWORK_RUNTIME_NODE_RESOLVER: "/runtime/node-resolver/register.mjs",
    });
    const changed = codexAppServerClientInternal.pooledEnvFingerprint({
      PATH: "/bin",
      COWORK_RUNTIME_NODE: "/runtime/node/bin/node",
      COWORK_RUNTIME_NODE_MODULES: "/runtime/node/node_modules-b",
      COWORK_RUNTIME_NODE_RESOLVER: "/runtime/node-resolver/register.mjs",
    });

    expect(base).not.toBe(changed);
    expect(base).toContain("COWORK_RUNTIME_NODE_MODULES");
  });

  test.serial("initializes app-server with the Cowork package version", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-init-"));
    const capturePath = path.join(dir, "requests.jsonl");
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

  test.serial(
    "drives a turn through codex app-server JSONL",
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-runtime-"));
      const script = await writeMockAppServer(dir);
      process.env.COWORK_CODEX_APP_SERVER_COMMAND = testNodeCommand;
      process.env.COWORK_CODEX_APP_SERVER_ARGS = script;
      // True end-to-end spawn coverage: clear the in-process mock factory that
      // installCodexAppServerTestHooks installs so this test exercises the real
      // spawn/stdio/JSONL client path against the mock node script.
      codexAppServerClientInternal.setClientFactoryForTests(undefined);

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
          event?: {
            direction?: string;
            message?: { method?: string; params?: { delta?: string } };
          };
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
    },
    30_000,
  );

  test.serial(
    "preserves app-server assistant phases and excludes commentary from final text",
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-commentary-"));
      process.env.COWORK_CODEX_APP_SERVER_ARGS = "commentary-and-final";

      const streamParts: unknown[] = [];
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
      });

      expect(result.text).toBe("final answer");
      expect(result.responseMessages).toEqual([{ role: "assistant", content: "final answer" }]);
      expect(streamParts).toContainEqual(
        expect.objectContaining({
          type: "text-start",
          id: "item_commentary",
          phase: "commentary",
        }),
      );
      expect(streamParts).toContainEqual(
        expect.objectContaining({
          type: "text-delta",
          id: "item_commentary",
          text: "working note",
          phase: "commentary",
        }),
      );
      expect(streamParts).toContainEqual(
        expect.objectContaining({
          type: "text-end",
          id: "item_commentary",
          phase: "commentary",
        }),
      );
      expect(streamParts).toContainEqual(
        expect.objectContaining({
          type: "text-delta",
          id: "item_1",
          text: "final answer",
          phase: "final_answer",
        }),
      );
    },
  );

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
      const capturePath = path.join(dir, "requests.jsonl");
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

  test.serial("omits Codex web search config when network is disabled", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-no-network-"));
    const capturePath = path.join(dir, "requests.jsonl");
    process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;

    const config = {
      ...makeConfig(dir),
      providerOptions: {
        "codex-cli": {
          textVerbosity: "high",
          webSearchMode: "live",
          webSearch: {
            contextSize: "high",
            allowedDomains: ["openai.com"],
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
      networkAllowed: false,
    });

    const requests = await readCapturedRequests(capturePath);
    expect(requests.find((entry) => entry.method === "thread/start")?.params.config).toEqual({
      model_verbosity: "high",
    });
  });

  test.serial("does not emit empty rich web search config", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-empty-web-"));
    const capturePath = path.join(dir, "requests.jsonl");
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

    // Codex app-server understands model-defined efforts, so xhigh passes through.
    const xhighRequests = await readCapturedRequests(capturePath);
    expect(xhighRequests.find((entry) => entry.method === "turn/start")?.params.effort).toBe(
      "xhigh",
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
      await fs.writeFile(
        script,
        `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
process.stdin.resume();
// Exit as soon as the parent closes stdin so abnormal test teardown cannot
// leave node.exe zombies on Windows.
rl.on("close", () => process.exit(0));
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
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
      // True end-to-end spawn coverage of the JSON-RPC error/fallback path:
      // clear the in-process mock factory so the real spawn/stdio/JSONL client
      // talks to the model-gated mock node script. Note the spawn env strips
      // CODEX_* variables, so requests are asserted via raw JSONL events
      // instead of the CODEX_APP_SERVER_CAPTURE_PATH capture file.
      codexAppServerClientInternal.setClientFactoryForTests(undefined);

      const logs: string[] = [];
      const rawEvents: unknown[] = [];
      const runtime = createRuntime(makeConfig(dir));
      const result = await runtime.runTurn({
        config: makeConfig(dir),
        system: "You are Codex.",
        messages: [{ role: "user", content: "Say hi" }],
        tools: {},
        maxSteps: 1,
        log: (line) => logs.push(line),
        onModelRawEvent: (event) => {
          rawEvents.push(event);
        },
      });

      expect(result.text).toBe("fallback ok");
      expect(result.providerState).toMatchObject({
        provider: "codex-cli",
        model: "gpt-5.3-codex-spark",
      });
      expect(logs.join("\n")).toContain(
        'model "gpt-5.4" is not available from the resolved app-server',
      );
      const clientRequests = rawEvents
        .map(
          (event) =>
            (
              event as {
                event?: {
                  direction?: string;
                  message?: { method?: string; params?: { model?: string } };
                };
              }
            ).event,
        )
        .filter((event) => event?.direction === "client_request")
        .map((event) => event?.message);
      expect(
        clientRequests.find((message) => message?.method === "thread/start")?.params?.model,
      ).toBe("gpt-5.3-codex-spark");
      expect(
        clientRequests.find((message) => message?.method === "turn/start")?.params?.model,
      ).toBe("gpt-5.3-codex-spark");
    },
    30_000,
  );

  test.serial("registers Cowork coordination tools as Codex dynamic tools", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-tools-"));
    const capturePath = path.join(dir, "requests.jsonl");
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
      (startParams?.dynamicTools as Array<{ name?: string }> | undefined)?.map((tool) => tool.name),
    ).not.toContain("bash");
    expect(startParams).not.toHaveProperty("baseInstructions");
    expect(startParams?.developerInstructions).toContain("## Codex App-Server Tool Boundary");
    expect(startParams?.developerInstructions).toContain(
      "Codex app-server handles shell, filesystem, sandboxing, approvals, and native web search/fetch for this turn.",
    );
    expect(startParams?.developerInstructions).toContain(
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
    "gates yolo native execution after Cowork dynamic tools can lock the source chat",
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-yolo-dynamic-native-"));
      const nativeWritePath = path.join(dir, "native-output.txt");
      const capturePath = path.join(dir, "requests.jsonl");
      const previousArgs = process.env.COWORK_CODEX_APP_SERVER_ARGS;
      const previousNativePath = process.env.CODEX_APP_SERVER_NATIVE_WRITE_PATH;
      const previousCapturePath = process.env.CODEX_APP_SERVER_CAPTURE_PATH;
      process.env.COWORK_CODEX_APP_SERVER_ARGS = "dynamic-lock-then-native";
      process.env.CODEX_APP_SERVER_NATIVE_WRITE_PATH = nativeWritePath;
      process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;

      let locked = false;
      const gateCalls: string[] = [];
      try {
        const runtime = createRuntime(makeConfig(dir));
        await runtime.runTurn({
          config: makeConfig(dir),
          system: "You are Codex.",
          messages: [{ role: "user", content: "Create task then run native command" }],
          tools: {
            createTask: {
              description: "Create a Cowork task and lock this source chat.",
              inputSchema: z.object({}),
              execute: () => {
                locked = true;
                return "created task";
              },
            },
          },
          maxSteps: 1,
          yolo: true,
          shellPolicy: "full",
          assertCanMutate: async (toolName: string) => {
            gateCalls.push(toolName);
            if (locked) throw new Error("task locked");
          },
        });

        const requests = await readCapturedRequests(capturePath);
        const turnStart = requests.find((entry) => entry.method === "turn/start")?.params as
          | { approvalPolicy?: string }
          | undefined;
        expect(turnStart?.approvalPolicy).toBe("on-request");
        expect(gateCalls).toContain("codex:commandExecution");
        await expect(fs.access(nativeWritePath)).rejects.toThrow();
      } finally {
        if (previousArgs === undefined) delete process.env.COWORK_CODEX_APP_SERVER_ARGS;
        else process.env.COWORK_CODEX_APP_SERVER_ARGS = previousArgs;
        if (previousNativePath === undefined) delete process.env.CODEX_APP_SERVER_NATIVE_WRITE_PATH;
        else process.env.CODEX_APP_SERVER_NATIVE_WRITE_PATH = previousNativePath;
        if (previousCapturePath === undefined) delete process.env.CODEX_APP_SERVER_CAPTURE_PATH;
        else process.env.CODEX_APP_SERVER_CAPTURE_PATH = previousCapturePath;
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );

  test.serial(
    "passes workspace-write sandbox and approval prompts for regular Codex turns",
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-sandbox-"));
      const capturePath = path.join(dir, "requests.jsonl");
      process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;

      const runtime = createRuntime(makeConfig(dir));
      await runtime.runTurn({
        config: { ...makeConfig(dir), sandbox: { mode: "workspace-write", network: false } },
        system: "You are Codex.",
        messages: [{ role: "user", content: "Say hi" }],
        tools: {},
        maxSteps: 1,
        yolo: false,
        shellPolicy: "full",
        approveCommand: async () => true,
      });

      const requests = await readCapturedRequests(capturePath);
      // The test workspace lives under the OS temp dir; on Linux that is /tmp, so
      // the broad /tmp scratch is excluded (the workspace itself stays writable).
      const underTmp = dir.startsWith("/tmp/") || dir.startsWith("/private/tmp/");
      expect(requests.find((entry) => entry.method === "thread/start")?.params).toMatchObject({
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      });
      expect(requests.find((entry) => entry.method === "turn/start")?.params).toMatchObject({
        approvalPolicy: "on-request",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: expect.arrayContaining([
            canonicalizeRoot(dir),
            canonicalizeRoot(path.join(dir, "output")),
            canonicalizeRoot(path.join(dir, "uploads")),
          ]),
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: underTmp,
        },
      });
    },
  );

  test.serial("adds only the active advanced-memory folder to Codex writable roots", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-memory-"));
    const memoryHome = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-memory-home-"));
    const memoriesDir = path.join(memoryHome, "memories");
    const capturePath = path.join(dir, "requests.jsonl");
    process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;
    const config = {
      ...makeConfig(dir),
      advancedMemory: true,
      memoriesDir,
      sandbox: { mode: "workspace-write" as const, network: false },
    };
    const activeMemoryRoot = path.join(memoriesDir, resolveMemoryFolderName(config));
    const chatsMemoryRoot = path.join(memoriesDir, CHATS_FOLDER);

    const runtime = createRuntime(config);
    await runtime.runTurn({
      config,
      system: "You are Codex.",
      messages: [{ role: "user", content: "Say hi" }],
      tools: {},
      maxSteps: 1,
      yolo: false,
      shellPolicy: "full",
      approveCommand: async () => true,
    });

    const requests = await readCapturedRequests(capturePath);
    const turnStart = requests.find((entry) => entry.method === "turn/start")?.params as
      | { sandboxPolicy?: { writableRoots?: string[] } }
      | undefined;
    const writableRoots = turnStart?.sandboxPolicy?.writableRoots ?? [];
    expect(writableRoots).toContain(canonicalizeRoot(activeMemoryRoot));
    expect(writableRoots).not.toContain(canonicalizeRoot(chatsMemoryRoot));
  });

  test.serial("passes configured read-only sandbox to Codex app-server turns", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-config-ro-"));
    const capturePath = path.join(dir, "requests.jsonl");
    process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;

    const runtime = createRuntime(makeConfig(dir));
    await runtime.runTurn({
      config: { ...makeConfig(dir), sandbox: { mode: "read-only", network: false } },
      system: "You are Codex.",
      messages: [{ role: "user", content: "Inspect only" }],
      tools: {},
      maxSteps: 1,
      yolo: false,
      shellPolicy: "full",
      approveCommand: async () => true,
    });

    const requests = await readCapturedRequests(capturePath);
    expect(requests.find((entry) => entry.method === "thread/start")?.params).toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "read-only",
    });
    expect(requests.find((entry) => entry.method === "turn/start")?.params).toMatchObject({
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
  });

  test.serial("passes danger-full-access sandbox when the session is in yolo mode", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-yolo-"));
    const capturePath = path.join(dir, "requests.jsonl");
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

  test.serial("preserves no-network danger-full-access for Codex turns", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-no-net-full-"));
    const capturePath = path.join(dir, "requests.jsonl");
    process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;

    const runtime = createRuntime(makeConfig(dir));
    await runtime.runTurn({
      config: { ...makeConfig(dir), sandbox: { mode: "danger-full-access", network: false } },
      system: "You are Codex.",
      messages: [{ role: "user", content: "Say hi" }],
      tools: {},
      maxSteps: 1,
      yolo: false,
      shellPolicy: "full",
    });

    const requests = await readCapturedRequests(capturePath);
    expect(requests.find((entry) => entry.method === "turn/start")?.params).toMatchObject({
      sandboxPolicy: { type: "dangerFullAccess", networkAccess: false },
    });
  });

  test.serial("keeps a scoped child within targetPaths even under yolo", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-yolo-scoped-"));
    const capturePath = path.join(dir, "requests.jsonl");
    process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;

    const runtime = createRuntime(makeConfig(dir));
    await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are a scoped child.",
      messages: [{ role: "user", content: "Edit auth" }],
      tools: {},
      maxSteps: 1,
      yolo: true,
      shellPolicy: "full",
      agentTargetPaths: [path.join(dir, "src", "auth")],
    });

    const requests = await readCapturedRequests(capturePath);
    const turnStart = requests.find((entry) => entry.method === "turn/start")?.params as {
      approvalPolicy: string;
      sandboxPolicy: { type: string; writableRoots?: string[] };
    };
    // YOLO still maps to approvalPolicy "never", but the sandbox must stay scoped
    // to the child's targetPaths instead of widening to danger-full-access.
    expect(turnStart.approvalPolicy).toBe("never");
    expect(turnStart.sandboxPolicy.type).toBe("workspaceWrite");
    expect(turnStart.sandboxPolicy.writableRoots).toContain(
      canonicalizeRoot(path.join(dir, "src", "auth")),
    );
  });

  test.serial("does not widen an explicit read-only sandbox under yolo", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-yolo-ro-"));
    const capturePath = path.join(dir, "requests.jsonl");
    process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;

    const runtime = createRuntime(makeConfig(dir));
    await runtime.runTurn({
      config: { ...makeConfig(dir), sandbox: { mode: "read-only", network: false } },
      system: "You are Codex.",
      messages: [{ role: "user", content: "Inspect" }],
      tools: {},
      maxSteps: 1,
      yolo: true,
      shellPolicy: "full",
    });

    const requests = await readCapturedRequests(capturePath);
    // YOLO relaxes the approval policy to "never", but an explicitly read-only
    // sandbox is a hard floor and must not be widened to full access.
    expect(requests.find((entry) => entry.method === "turn/start")?.params).toMatchObject({
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly" },
    });
  });

  test.serial(
    "passes scratch-only Codex workspace-write sandbox for no-project-write subagent shell policy",
    async () => {
      const dir = await fs.mkdtemp(
        path.join(process.cwd(), ".tmp-cowork-codex-app-server-scratch-"),
      );
      const capturePath = path.join(dir, "requests.jsonl");
      process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;

      try {
        const config = makeConfig(dir);
        const runtime = createRuntime(config);
        await runtime.runTurn({
          config,
          system: "You are a no-project-write child agent.",
          messages: [{ role: "user", content: "Inspect only" }],
          tools: {},
          maxSteps: 1,
          yolo: true,
          shellPolicy: "no_project_write",
        });

        const requests = await readCapturedRequests(capturePath);
        expect(requests.find((entry) => entry.method === "thread/start")?.params).toMatchObject({
          approvalPolicy: "never",
          sandbox: "workspace-write",
        });
        expect(requests.find((entry) => entry.method === "turn/start")?.params).toMatchObject({
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "workspaceWrite",
            networkAccess: true,
          },
        });
        const sandboxPolicy = requests.find((entry) => entry.method === "turn/start")?.params
          ?.sandboxPolicy;
        const expectedScratchRoots = tmpScratchRoots([dir], scratchRoots());
        expect(sandboxPolicy?.writableRoots).toEqual(expectedScratchRoots);
        expect(sandboxPolicy?.writableRoots).not.toContain(dir);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );

  test("declines read-only Codex file approvals even under yolo", async () => {
    let approvals = 0;
    const response = await handleServerRequest(
      {
        id: "file-approval-1",
        jsonrpc: "2.0",
        method: "item/fileChange/requestApproval",
        params: { path: "src/new.ts" },
      },
      {
        shellPolicy: "no_project_write",
        yolo: true,
        approveCommand: async () => {
          approvals += 1;
          return true;
        },
      } as never,
    );

    expect(response).toEqual({ decision: "decline" });
    expect(approvals).toBe(0);
  });

  test("still accepts ordinary Codex command approvals under yolo", async () => {
    const response = await handleServerRequest(
      {
        id: "command-approval-1",
        jsonrpc: "2.0",
        method: "item/commandExecution/requestApproval",
        params: { command: "echo ok" },
      },
      {
        shellPolicy: "no_project_write",
        yolo: true,
        approveCommand: async () => false,
      } as never,
    );

    expect(response).toEqual({ decision: "accept" });
  });

  test("rechecks native Codex command approval after the explicit approval wait", async () => {
    let locked = false;
    let gateCalls = 0;
    const approvalEntered = Promise.withResolvers<void>();
    const releaseApproval = Promise.withResolvers<void>();
    const responsePromise = handleServerRequest(
      {
        id: "command-approval-race",
        jsonrpc: "2.0",
        method: "item/commandExecution/requestApproval",
        params: { command: "touch escaped.txt" },
      },
      {
        shellPolicy: "full",
        yolo: false,
        assertCanMutate: async (toolName: string) => {
          expect(toolName).toBe("codex:commandExecution");
          gateCalls += 1;
          if (locked) throw new Error("task locked");
        },
        approveCommand: async () => {
          approvalEntered.resolve();
          await releaseApproval.promise;
          return true;
        },
        log: () => {},
      } as never,
    );

    await approvalEntered.promise;
    locked = true;
    releaseApproval.resolve();

    await expect(responsePromise).resolves.toEqual({ decision: "decline" });
    expect(gateCalls).toBe(2);
  });

  test("rechecks native Codex file approval after yolo auto-approval", async () => {
    let gateCalls = 0;
    let approvals = 0;
    const response = await handleServerRequest(
      {
        id: "file-approval-yolo-race",
        jsonrpc: "2.0",
        method: "item/fileChange/requestApproval",
        params: { path: "src/escaped.ts" },
      },
      {
        shellPolicy: "full",
        yolo: true,
        assertCanMutate: async (toolName: string) => {
          expect(toolName).toBe("codex:fileChange");
          gateCalls += 1;
          if (gateCalls === 2) throw new Error("task locked");
        },
        approveCommand: async () => {
          approvals += 1;
          return true;
        },
        log: () => {},
      } as never,
    );

    expect(response).toEqual({ decision: "decline" });
    expect(gateCalls).toBe(2);
    expect(approvals).toBe(0);
  });

  for (const nativeKind of ["command", "file"] as const) {
    test.serial(
      `interrupts yolo native Codex ${nativeKind} execution when the turn aborts before the request returns`,
      async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), `cowork-codex-yolo-${nativeKind}-`));
        const nativeWritePath = path.join(dir, `${nativeKind}-escaped.txt`);
        const abortController = new AbortController();
        const nativeEntered = Promise.withResolvers<void>();
        const releaseNativeDrain = Promise.withResolvers<void>();
        const turnStartResponse = Promise.withResolvers<unknown>();
        const notificationListeners = new Set<
          (notification: CodexAppServerJsonRpcNotification) => void
        >();
        const rawListeners = new Set<(message: CodexAppServerJsonRpcRawMessage) => void>();
        const unhandledRejections: unknown[] = [];
        const onUnhandledRejection = (error: unknown) => {
          unhandledRejections.push(error);
        };
        const interruptCalls: Array<{ threadId: string; turnId?: string }> = [];
        let interrupted = false;
        let turnStartParams: { approvalPolicy?: string; sandboxPolicy?: unknown } | null = null;
        let nextRequestId = 1;
        let turnStartRequested = false;
        let turnStartReleased = false;
        let turnPromise: Promise<unknown> | undefined;

        const emitRaw = (message: CodexAppServerJsonRpcRawMessage) => {
          for (const listener of rawListeners) listener(message);
        };
        const emitNotification = (notification: CodexAppServerJsonRpcNotification) => {
          emitRaw({
            direction: "server_notification",
            message: notification as Record<string, unknown>,
          });
          for (const listener of notificationListeners) listener(notification);
        };
        const rejectTurnStart = () => {
          if (turnStartReleased || !turnStartRequested) return;
          turnStartReleased = true;
          turnStartResponse.reject(new Error("late yolo turn/start rejection"));
        };
        const client: CodexAppServerClient = {
          command: { command: "mock-codex-app-server", args: [], source: "override" },
          isClosed: () => false,
          getLastCloseInfo: () => null,
          request: async (method: string, params?: unknown) => {
            const id = nextRequestId++;
            emitRaw({
              direction: "client_request",
              message: { id, method, ...(params !== undefined ? { params } : {}) },
            });
            if (method === "initialize") {
              const result = { userAgent: "mock" };
              emitRaw({ direction: "server_response", message: { id, result } });
              return result;
            }
            if (method === "model/list") {
              const result = {
                data: [
                  { id: "gpt-5.4", model: "gpt-5.4", displayName: "GPT-5.4", isDefault: true },
                ],
                nextCursor: null,
              };
              emitRaw({ direction: "server_response", message: { id, result } });
              return result;
            }
            if (method === "thread/start") {
              const record = params as {
                model?: string;
                approvalPolicy?: string;
                sandbox?: string;
              };
              const result = {
                thread: { id: "thread_1", modelProvider: "openai", turns: [] },
                model: record.model ?? "gpt-5.4",
                modelProvider: "openai",
                cwd: dir,
                approvalPolicy: record.approvalPolicy,
                sandbox: record.sandbox,
                reasoningEffort: "high",
              };
              emitRaw({ direction: "server_response", message: { id, result } });
              return result;
            }
            if (method === "turn/start") {
              turnStartRequested = true;
              turnStartParams = params as { approvalPolicy?: string; sandboxPolicy?: unknown };
              nativeEntered.resolve();
              await releaseNativeDrain.promise;
              if (!interrupted) {
                await fs.writeFile(nativeWritePath, `${nativeKind} side effect escaped`, "utf8");
              }
              emitNotification({
                method: "turn/completed",
                params: {
                  threadId: "thread_1",
                  turn: {
                    id: `turn_${nativeKind}`,
                    threadId: "thread_1",
                    status: "cancelled",
                    items: [],
                    error: null,
                  },
                },
              });
              return await turnStartResponse.promise;
            }
            return {};
          },
          interruptTurn: async (params) => {
            interrupted = true;
            interruptCalls.push(params);
          },
          notify: () => {},
          onNotification: (listener) => {
            notificationListeners.add(listener);
            return () => notificationListeners.delete(listener);
          },
          onServerRequest: () => () => {},
          onJsonRpcMessage: (listener) => {
            rawListeners.add(listener);
            return () => rawListeners.delete(listener);
          },
          onClose: () => () => {},
          close: async () => {},
        };

        process.on("unhandledRejection", onUnhandledRejection);
        codexAppServerClientInternal.setClientFactoryForTests(async () => client);

        try {
          const runtime = createRuntime(makeConfig(dir));
          turnPromise = runtime.runTurn({
            config: makeConfig(dir),
            system: "You are Codex.",
            messages: [{ role: "user", content: `Run native ${nativeKind}` }],
            tools: {},
            maxSteps: 1,
            yolo: true,
            shellPolicy: "full",
            abortSignal: abortController.signal,
          });

          await nativeEntered.promise;
          expect(turnStartParams).toMatchObject({ approvalPolicy: "never" });
          abortController.abort();
          await new Promise((resolve) => setTimeout(resolve, 0));
          expect(interrupted).toBe(true);
          expect(interruptCalls).toEqual([{ threadId: "thread_1" }]);
          const settledBeforeNativeRequestSettled = await Promise.race([
            turnPromise.then(
              () => true,
              () => true,
            ),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25)),
          ]);
          expect(settledBeforeNativeRequestSettled).toBe(false);

          releaseNativeDrain.resolve();
          await expect(turnPromise).rejects.toThrow(/Cancelled by user/);
          await expect(fs.access(nativeWritePath)).rejects.toThrow();
        } finally {
          releaseNativeDrain.resolve();
          rejectTurnStart();
          await turnPromise?.catch(() => {});
          await new Promise((resolve) => setTimeout(resolve, 0));
          expect(unhandledRejections).toEqual([]);
          process.off("unhandledRejection", onUnhandledRejection);
          await fs.rm(dir, { recursive: true, force: true });
        }
      },
    );
  }

  test.serial("does not attach partial assistant text after Codex turn abort", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-abort-partial-"));
    const abortController = new AbortController();
    const notificationListeners = new Set<(notification: Record<string, unknown>) => void>();
    const rawListeners = new Set<(message: Record<string, unknown>) => void>();
    let interrupted = false;

    const emitNotification = (notification: Record<string, unknown>) => {
      for (const listener of rawListeners) {
        listener({ direction: "server_notification", message: notification });
      }
      for (const listener of notificationListeners) listener(notification);
    };

    codexAppServerClientInternal.setClientFactoryForTests(async () => ({
      command: { command: "mock-codex-app-server", args: [], source: "override" },
      isClosed: () => false,
      getLastCloseInfo: () => null,
      request: async (method: string, params?: unknown) => {
        if (method === "initialize") return { userAgent: "mock" };
        if (method === "model/list") {
          return {
            data: [{ id: "gpt-5.4", model: "gpt-5.4", displayName: "GPT-5.4", isDefault: true }],
            nextCursor: null,
          };
        }
        if (method === "thread/start") {
          return {
            thread: { id: "thread_1", modelProvider: "openai", turns: [] },
            model: "gpt-5.4",
            modelProvider: "openai",
            cwd: dir,
          };
        }
        if (method === "turn/start") {
          const threadId = (params as { threadId?: string } | undefined)?.threadId ?? "thread_1";
          const turnId = "turn_partial";
          queueMicrotask(() => {
            emitNotification({
              method: "item/started",
              params: {
                threadId,
                turnId,
                item: {
                  type: "agentMessage",
                  id: "item_partial",
                  text: "",
                  phase: null,
                  memoryCitation: null,
                },
              },
            });
            emitNotification({
              method: "item/agentMessage/delta",
              params: {
                threadId,
                turnId,
                itemId: "item_partial",
                delta: "partial text must not reach history",
              },
            });
            abortController.abort();
            emitNotification({
              method: "turn/completed",
              params: {
                threadId,
                turn: {
                  id: turnId,
                  threadId,
                  status: "completed",
                  items: [
                    {
                      type: "agentMessage",
                      id: "item_partial",
                      text: "partial text must not reach history",
                    },
                  ],
                  error: null,
                },
              },
            });
          });
          return { turn: { id: turnId, status: "inProgress", items: [], error: null } };
        }
        return {};
      },
      notify: () => {},
      interruptTurn: async () => {
        interrupted = true;
      },
      onNotification: (listener: (notification: Record<string, unknown>) => void) => {
        notificationListeners.add(listener);
        return () => notificationListeners.delete(listener);
      },
      onServerRequest: () => () => {},
      onJsonRpcMessage: (listener: (message: Record<string, unknown>) => void) => {
        rawListeners.add(listener);
        return () => rawListeners.delete(listener);
      },
      onClose: () => () => {},
      close: async () => {},
    }));

    try {
      const runtime = createRuntime(makeConfig(dir));
      let caught: unknown;
      try {
        await runtime.runTurn({
          config: makeConfig(dir),
          system: "You are Codex.",
          messages: [{ role: "user", content: "Abort after partial" }],
          tools: {},
          maxSteps: 1,
          abortSignal: abortController.signal,
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("Cancelled by user");
      expect((caught as { responseMessages?: unknown }).responseMessages).toBeUndefined();
      expect(interrupted).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("declines native Codex approvals when the lifecycle mutation gate is closed", async () => {
    let approvals = 0;
    const response = await handleServerRequest(
      {
        id: "command-approval-locked",
        jsonrpc: "2.0",
        method: "item/commandExecution/requestApproval",
        params: { command: "touch escaped.txt" },
      },
      {
        shellPolicy: "full",
        yolo: true,
        assertCanMutate: async (toolName: string) => {
          expect(toolName).toBe("codex:commandExecution");
          throw new Error("task locked");
        },
        approveCommand: async () => {
          approvals += 1;
          return true;
        },
        log: () => {},
      } as never,
    );

    expect(response).toEqual({ decision: "decline" });
    expect(approvals).toBe(0);
  });
});
