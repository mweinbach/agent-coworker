import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRunTurn } from "../src/agent";
import {
  MAX_REFERENCED_SKILL_BODY_BYTES,
  MAX_TOTAL_REFERENCED_SKILL_INJECTION_BYTES,
  renderReferencedSkillsInjection,
  resolveReferencedPlugins,
  resolveReferencedSkills,
} from "../src/server/session/turnExecution/referenceInjection";
import { startAgentServer } from "../src/server/startServer";
import type { AgentConfig } from "../src/types";
import { stopTestServer } from "./helpers/wsHarness";

const SKILL_BODY_MARKER = "REFERENCED-SKILL-BODY-MARKER-42";

describe("renderReferencedSkillsInjection (unit)", () => {
  test("returns empty string when there are no skills", () => {
    expect(renderReferencedSkillsInjection([])).toBe("");
  });

  test("renders each skill body under an instruction heading", () => {
    const text = renderReferencedSkillsInjection([
      { name: "documents", body: "DOC BODY", source: "project", path: "/x" } as any,
      { name: "pdf", body: "PDF BODY", source: "built-in", path: "/y" } as any,
    ]);
    expect(text).toContain("## Referenced Skills");
    expect(text).toContain("### documents");
    expect(text).toContain("DOC BODY");
    expect(text).toContain("### pdf");
    expect(text).toContain("PDF BODY");
    // Plain text only — never a fabricated tool call (rejected by stateful providers).
    expect(text).not.toContain("tool-call");
    expect(text).not.toContain("tool-result");
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
            { name: "REMOVEDUI", enabled: true },
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

describe("referenced skill resolution limits", () => {
  test("skips oversized skill bodies with a clear log", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skillrefs-oversized-"));
    const skillsDir = path.join(root, "skills");
    const largeSkillDir = path.join(skillsDir, "large-skill");
    await fs.mkdir(largeSkillDir, { recursive: true });
    await fs.writeFile(
      path.join(largeSkillDir, "SKILL.md"),
      [
        "---",
        'name: "large-skill"',
        'description: "Large skill"',
        "---",
        "",
        "x".repeat(MAX_REFERENCED_SKILL_BODY_BYTES + 1),
      ].join("\n"),
      "utf-8",
    );
    const config = makeReferenceConfig(root, skillsDir);
    const logs: string[] = [];

    const resolved = await resolveReferencedSkills({
      context: { state: { config } } as any,
      references: [{ kind: "skill", name: "large-skill" }],
      log: (line) => logs.push(line),
    });

    expect(resolved).toEqual([]);
    expect(logs.some((line) => line.includes('skipping oversized skill "large-skill"'))).toBe(true);
  });

  test("stops referenced skill injection at the total byte cap", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skillrefs-total-cap-"));
    const skillsDir = path.join(root, "skills");
    const body = "x".repeat(MAX_REFERENCED_SKILL_BODY_BYTES - 4096);
    for (const name of ["skill-1", "skill-2", "skill-3", "skill-4"]) {
      const skillDir = path.join(skillsDir, name);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        ["---", `name: "${name}"`, `description: "${name}"`, "---", "", `${name}:${body}`].join(
          "\n",
        ),
        "utf-8",
      );
    }
    const config = makeReferenceConfig(root, skillsDir);
    const logs: string[] = [];

    const resolved = await resolveReferencedSkills({
      context: { state: { config } } as any,
      references: [
        { kind: "skill", name: "skill-1" },
        { kind: "skill", name: "skill-2" },
        { kind: "skill", name: "skill-3" },
        { kind: "skill", name: "skill-4" },
      ],
      log: (line) => logs.push(line),
    });

    expect(resolved.map((skill) => skill.name)).toEqual(["skill-1", "skill-2", "skill-3"]);
    expect(renderReferencedSkillsInjection(resolved)).not.toContain("skill-4:");
    expect(
      logs.some(
        (line) =>
          line.includes('skipping remaining skills at "skill-4"') &&
          line.includes(String(MAX_TOTAL_REFERENCED_SKILL_INJECTION_BYTES)),
      ),
    ).toBe(true);
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

describe("skill reference injection (e2e via turn/start references)", () => {
  test("folds the skill body into the model-facing user message, not a synthetic tool call", async () => {
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

      // (a) The skill body is folded into the model-facing USER message.
      expect(capturedMessages).not.toBeNull();
      const messages = capturedMessages ?? [];
      const userMessage = messages.find((m: any) => m.role === "user");
      expect(userMessage).toBeDefined();
      expect(JSON.stringify(userMessage)).toContain(SKILL_BODY_MARKER);
      expect(JSON.stringify(userMessage)).toContain("use the skill");

      // (b) Provider-safe: NO synthetic tool-call / tool-result messages in history.
      expect(messages.some((m: any) => m.role === "tool")).toBe(false);
      expect(
        messages.some(
          (m: any) =>
            m.role === "assistant" &&
            Array.isArray(m.content) &&
            m.content.some((p: any) => p?.type === "tool-call"),
        ),
      ).toBe(false);

      // (c) The UI-visible user bubble stays clean (skill body is not leaked to it).
      const userItem = notifications.find(
        (m) =>
          (m.method === "item/started" || m.method === "item/completed") &&
          m.params.item?.type === "userMessage",
      );
      expect(userItem).toBeDefined();
      expect(JSON.stringify(userItem.params.item)).not.toContain(SKILL_BODY_MARKER);
      expect(JSON.stringify(userItem.params.item)).toContain("use the skill");

      // (d) No error notification; the turn completed.
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

describe("plugin reference injection (e2e via turn/start references)", () => {
  test("adds the referenced plugin context to the runtime system prompt only", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pluginref-e2e-"));
    const pluginRoot = path.join(tmp, ".cowork", "plugins", "demo-plugin");
    const pluginManifestDir = path.join(pluginRoot, ".cowork-plugin");
    const pluginSkillDir = path.join(pluginRoot, "skills", "demo-skill");
    await fs.mkdir(pluginSkillDir, { recursive: true });
    await fs.mkdir(pluginManifestDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginManifestDir, "plugin.json"),
      JSON.stringify({
        name: "demo-plugin",
        description: "Demo plugin",
        skills: "./skills",
        interface: { displayName: "Demo Plugin" },
      }),
      "utf-8",
    );
    await fs.writeFile(
      path.join(pluginSkillDir, "SKILL.md"),
      ["---", 'name: "demo-skill"', 'description: "Demo skill"', "---", "", "Demo skill body"].join(
        "\n",
      ),
      "utf-8",
    );

    const capturedSystems: string[] = [];
    const capturedMessages: unknown[] = [];
    const runTurnImpl = createRunTurn({
      createRuntime: () => ({
        name: "pi",
        runTurn: async (params) => {
          capturedSystems.push(params.system);
          capturedMessages.push(...params.messages);
          return {
            text: "Done.",
            responseMessages: [],
          };
        },
      }),
    });

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
      runTurnImpl,
    });

    const rpc = await connectJsonRpc(url);
    try {
      const started = await rpc.sendRequest("thread/start", { cwd: tmp });
      const threadId = started.result.thread.id as string;
      await rpc.waitFor((m) => m.method === "thread/started" && m.params.thread.id === threadId);

      const turnStarted = await rpc.sendRequest("turn/start", {
        threadId,
        clientMessageId: "msg-plugin-1",
        input: [{ type: "text", text: "use the plugin" }],
        references: [{ kind: "plugin", name: "demo-plugin" }],
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

      expect(capturedSystems).toHaveLength(1);
      expect(capturedSystems[0]).toContain("## Referenced Plugins");
      expect(capturedSystems[0]).toContain("Demo Plugin");
      expect(capturedSystems[0]).toContain("demo-skill");

      const serializedMessages = JSON.stringify(capturedMessages);
      expect(serializedMessages).toContain("use the plugin");
      expect(serializedMessages).not.toContain("## Referenced Plugins");
      expect(serializedMessages).not.toContain("Demo Plugin");
      expect(serializedMessages).not.toContain("demo-skill");

      const userItem = notifications.find(
        (m) =>
          (m.method === "item/started" || m.method === "item/completed") &&
          m.params.item?.type === "userMessage",
      );
      expect(userItem).toBeDefined();
      expect(JSON.stringify(userItem.params.item)).toContain("use the plugin");
      expect(JSON.stringify(userItem.params.item)).not.toContain("Demo Plugin");
      expect(JSON.stringify(userItem.params.item)).not.toContain("demo-skill");

      const errorNotification = notifications.find(
        (m) => m.method === "error" || m.method === "session/error",
      );
      expect(errorNotification).toBeUndefined();
    } finally {
      rpc.close();
      await stopTestServer(server);
    }
  }, 20_000);
});
