import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  modelMessagesToPiMessages,
  piTurnMessagesToModelMessages,
} from "../src/runtime/piMessageBridge";
import {
  buildSyntheticSkillMessages,
  buildSyntheticSkillToolCallId,
  injectResolvedReferencedSkills,
  resolveReferencedPlugins,
} from "../src/server/session/turnExecution/referenceInjection";
import { startAgentServer } from "../src/server/startServer";
import type { AgentConfig } from "../src/types";
import { stopTestServer } from "./helpers/wsHarness";

const SKILL_BODY_MARKER = "SYNTHETIC-SKILL-BODY-MARKER-42";

describe("synthetic skill messages (unit)", () => {
  test("match the canonical history tool-call/result shapes", () => {
    const toolCallId = buildSyntheticSkillToolCallId("turn-1", "documents", 0);
    expect(toolCallId).toBe("skillref_turn-1_0_documents");

    const { assistant, tool } = buildSyntheticSkillMessages(toolCallId, "documents", "BODY");
    expect(assistant).toEqual({
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId, toolName: "skill", input: { skillName: "documents" } },
      ],
    });
    const part = (tool.content as Array<Record<string, unknown>>)[0];
    expect(part).toMatchObject({
      type: "tool-result",
      toolCallId,
      toolName: "skill",
      isError: false,
    });
    expect(part.output).toEqual({ type: "text", value: "BODY" });
  });

  test("round-trip through the pi message bridge preserves the body for each provider", () => {
    for (const provider of ["openai", "google", "anthropic"]) {
      const { assistant, tool } = buildSyntheticSkillMessages("tc1", "documents", "BODY-XYZ");
      const pi = modelMessagesToPiMessages([assistant, tool], provider);
      const back = piTurnMessagesToModelMessages(pi);
      const serialized = JSON.stringify(back);
      expect(serialized).toContain("BODY-XYZ");
      expect(serialized).toContain("documents");
      expect(serialized).toContain("skill");
    }
  });

  test("allocates unique synthetic tool-call ids across repeated injections in one turn", () => {
    const appended: any[] = [];
    const emitted: any[] = [];
    const context = {
      id: "session-1",
      state: {
        turnReferenceInjectionCounter: 0,
        config: { provider: "google", model: "gemini-3-flash-preview" },
      },
      emit: (event: any) => emitted.push(event),
    } as any;

    injectResolvedReferencedSkills({
      context,
      appendToHistory: (messages) => appended.push(...messages),
      turnId: "turn-1",
      skills: [{ name: "documents", body: "DOCS", source: "project" } as any],
      allocateStreamIndex: () => emitted.length,
      includeRawChunks: false,
      log: () => {},
    });
    injectResolvedReferencedSkills({
      context,
      appendToHistory: (messages) => appended.push(...messages),
      turnId: "turn-1",
      skills: [{ name: "documents", body: "DOCS AGAIN", source: "project" } as any],
      allocateStreamIndex: () => emitted.length,
      includeRawChunks: false,
      log: () => {},
    });

    const ids = appended
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .map((part) => part.toolCallId)
      .filter(Boolean);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toEqual([
      "skillref_turn-1_0_documents",
      "skillref_turn-1_0_documents",
      "skillref_turn-1_1_documents",
      "skillref_turn-1_1_documents",
    ]);
  });
});

function makeReferenceConfig(root: string, skillsDir: string): AgentConfig {
  return {
    provider: "google",
    model: "gemini-3-flash-preview",
    preferredChildModel: "gemini-3-flash-preview",
    workingDirectory: root,
    outputDirectory: path.join(root, "output"),
    uploadsDirectory: path.join(root, "uploads"),
    userName: "tester",
    knowledgeCutoff: "unknown",
    projectCoworkDir: path.join(root, ".cowork"),
    userCoworkDir: path.join(root, "home", ".cowork"),
    workspaceAgentsDir: path.join(root, ".agents"),
    userAgentsDir: path.join(root, "home", ".agents"),
    workspacePluginsDir: path.join(root, ".agents", "plugins"),
    userPluginsDir: path.join(root, "home", ".agents", "plugins"),
    builtInDir: path.join(root, "builtin"),
    builtInConfigDir: path.join(root, "builtin", "config"),
    skillsDirs: [skillsDir],
    memoryDirs: [],
    configDirs: [],
    enableMcp: false,
  } as unknown as AgentConfig;
}

describe("referenced plugin resolution", () => {
  test("skips disabled and skill-shadowed plugins and filters disabled bundled skills", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pluginrefs-"));
    const skillsDir = path.join(root, "skills");
    const sharedSkillDir = path.join(skillsDir, "shared");
    await fs.mkdir(sharedSkillDir, { recursive: true });
    await fs.writeFile(
      path.join(sharedSkillDir, "SKILL.md"),
      ["---", 'name: "shared"', 'description: "Shared skill"', "---", "", "# Shared"].join("\n"),
      "utf-8",
    );

    const config = makeReferenceConfig(root, skillsDir);
    const context = { state: { config } } as any;
    const catalog: any = {
      plugins: [
        {
          name: "disabled",
          displayName: "Disabled",
          enabled: false,
          skills: [{ name: "disabled-plugin-skill", enabled: true }],
        },
        {
          name: "shared",
          displayName: "Shared Plugin",
          enabled: true,
          skills: [{ name: "shared-plugin-skill", enabled: true }],
        },
        {
          name: "enabled",
          displayName: "Enabled",
          enabled: true,
          skills: [
            { name: "enabled-skill", enabled: true },
            { name: "disabled-skill", enabled: false },
            { name: "a2ui", enabled: true },
          ],
        },
      ],
    };

    const resolved = await resolveReferencedPlugins(
      context,
      [
        { kind: "plugin", name: "disabled" },
        { kind: "plugin", name: "shared" },
        { kind: "plugin", name: "enabled" },
      ],
      catalog,
    );

    expect(resolved).toEqual([
      { name: "enabled", displayName: "Enabled", skillNames: ["enabled-skill"] },
    ]);
  });
});

type JsonRpcConn = {
  sendRequest: (method: string, params?: unknown) => Promise<any>;
  waitFor: (predicate: (m: any) => boolean, timeoutMs?: number) => Promise<any>;
  takeQueued: (predicate: (m: any) => boolean) => any[];
  close: () => void;
};

async function connectJsonRpc(url: string): Promise<JsonRpcConn> {
  const ws = new WebSocket(url, "cowork.jsonrpc.v1");
  const queue: any[] = [];
  const waiters = new Set<{
    predicate: (m: any) => boolean;
    resolve: (m: any) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  ws.onmessage = (event) => {
    const message = JSON.parse(typeof event.data === "string" ? event.data : "");
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(message);
      return;
    }
    queue.push(message);
  };
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws open timeout")), 5_000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("ws error"));
    };
  });
  const waitFor = (predicate: (m: any) => boolean, timeoutMs = 5_000) => {
    const existing = queue.findIndex(predicate);
    if (existing >= 0) return Promise.resolve(queue.splice(existing, 1)[0]);
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error("waitFor timeout"));
      }, timeoutMs);
      const waiter = { predicate, resolve, timer };
      waiters.add(waiter);
    });
  };
  let nextId = 0;
  const sendRequest = async (method: string, params?: unknown) => {
    const id = ++nextId;
    ws.send(JSON.stringify({ id, method, ...(params !== undefined ? { params } : {}) }));
    return await waitFor((m) => m.id === id);
  };
  const takeQueued = (predicate: (m: any) => boolean) => {
    const matched: any[] = [];
    for (let i = queue.length - 1; i >= 0; i--) {
      if (!predicate(queue[i])) continue;
      matched.unshift(queue[i]);
      queue.splice(i, 1);
    }
    return matched;
  };
  const init = await sendRequest("initialize", {
    clientInfo: { name: "skillref-test", version: "1.0.0" },
  });
  expect(init.result.protocolVersion).toBe("0.1");
  ws.send(JSON.stringify({ method: "initialized" }));
  return { sendRequest, waitFor, takeQueued, close: () => ws.close() };
}

describe("synthetic skill injection (e2e via turn/start references)", () => {
  test("forces a skill: transcript tool card + persisted history, no malformed-tool failure", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skillref-e2e-"));
    const skillDir = path.join(tmp, ".cowork", "skills", "test-skill");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        'name: "test-skill"',
        'description: "A test skill"',
        "---",
        "",
        SKILL_BODY_MARKER,
      ].join("\n"),
      "utf-8",
    );

    let capturedMessages: any[] | null = null;
    const runTurnImpl = async (params: any) => {
      if (!capturedMessages) capturedMessages = params.messages;
      const emit = params.onModelStreamPart;
      await emit?.({ type: "start" });
      await emit?.({ type: "start-step", stepNumber: 0 });
      await emit?.({ type: "text-delta", id: "t1", text: "Done." });
      await emit?.({ type: "finish-step", stepNumber: 0, finishReason: "stop" });
      await emit?.({ type: "finish", finishReason: "stop" });
      return { text: "Done.", reasoningText: undefined, responseMessages: [] };
    };

    const { server, url } = await startAgentServer({
      cwd: tmp,
      hostname: "127.0.0.1",
      port: 0,
      homedir: tmp,
      env: {
        AGENT_WORKING_DIR: tmp,
        AGENT_PROVIDER: "google",
        AGENT_OBSERVABILITY_ENABLED: "false",
        COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP: "1",
      },
      runTurnImpl: runTurnImpl as any,
    });

    const rpc = await connectJsonRpc(url);
    try {
      const started = await rpc.sendRequest("thread/start", { cwd: tmp });
      const threadId = started.result.thread.id as string;
      await rpc.waitFor((m) => m.method === "thread/started" && m.params.thread.id === threadId);

      const turnStarted = await rpc.sendRequest("turn/start", {
        threadId,
        clientMessageId: "msg-1",
        input: [{ type: "text", text: "use the skill" }],
        references: [{ kind: "skill", name: "test-skill" }],
      });
      const turnId = turnStarted.result.turn.id as string;

      const notifications: any[] = [];
      while (true) {
        const message = await rpc.waitFor((c) => typeof c.method === "string", 10_000);
        notifications.push(message);
        if (message.method === "turn/completed" && message.params.turn.id === turnId) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      notifications.push(...rpc.takeQueued((c) => typeof c.method === "string"));

      // (a) The transcript shows a `skill` tool card (live stream), stable id.
      const toolStarted = notifications.find(
        (m) => m.method === "item/started" && m.params.item.type === "toolCall",
      );
      const toolCompleted = notifications.find(
        (m) => m.method === "item/completed" && m.params.item.type === "toolCall",
      );
      expect(toolStarted).toBeDefined();
      expect(toolCompleted).toBeDefined();
      expect(toolStarted.params.item).toMatchObject({
        type: "toolCall",
        toolName: "skill",
        args: { skillName: "test-skill" },
      });
      expect(toolCompleted.params.item.id).toBe(toolStarted.params.item.id);
      expect(JSON.stringify(toolCompleted.params.item)).toContain(SKILL_BODY_MARKER);

      // (b) The synthetic messages are in model history BEFORE the model runs.
      expect(capturedMessages).not.toBeNull();
      const messages = capturedMessages ?? [];
      const serialized = JSON.stringify(messages);
      expect(serialized).toContain(SKILL_BODY_MARKER);
      const assistantToolCall = messages.find(
        (m: any) =>
          m.role === "assistant" &&
          Array.isArray(m.content) &&
          m.content.some((p: any) => p.type === "tool-call" && p.toolName === "skill"),
      );
      const toolResult = messages.find(
        (m: any) =>
          m.role === "tool" &&
          Array.isArray(m.content) &&
          m.content.some((p: any) => p.type === "tool-result" && p.toolName === "skill"),
      );
      expect(assistantToolCall).toBeDefined();
      expect(toolResult).toBeDefined();

      // (c) No malformed-tool / error notification; the turn completed.
      const errorNotification = notifications.find(
        (m) => m.method === "error" || m.method === "session/error",
      );
      expect(errorNotification).toBeUndefined();
      const completed = notifications.find(
        (m) => m.method === "turn/completed" && m.params.turn.id === turnId,
      );
      expect(completed).toBeDefined();
      expect(completed.params.turn.status).not.toBe("error");
    } finally {
      rpc.close();
      await stopTestServer(server);
    }
  }, 20_000);
});
