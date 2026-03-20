import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRunTurn } from "../src/agent";
import { startAgentServer, type StartAgentServerOptions } from "../src/server/startServer";

async function makeTmpProject(): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-harness-ws-"));
  await fs.mkdir(path.join(tmp, ".agent"), { recursive: true });
  return tmp;
}

function serverOpts(tmpDir: string, overrides?: Partial<StartAgentServerOptions>): StartAgentServerOptions {
  return {
    cwd: tmpDir,
    hostname: "127.0.0.1",
    port: 0,
    homedir: tmpDir,
    env: {
      AGENT_WORKING_DIR: tmpDir,
      AGENT_PROVIDER: "google",
      COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP: "1",
    },
    ...overrides,
  };
}

function withSession<T>(
  url: string,
  handler: (args: {
    ws: WebSocket;
    sessionId: string;
    message: any;
    resolve: (value: T) => void;
    reject: (error: Error) => void;
  }) => void,
  options?: {
    resumeSessionId?: string;
    timeoutMs?: number;
  },
): Promise<T> {
  return new Promise((resolve, reject) => {
    const settled = { value: false };
    let activeSessionId = options?.resumeSessionId ?? "";
    const endpoint = options?.resumeSessionId ? `${url}?resumeSessionId=${options.resumeSessionId}` : url;
    const ws = new WebSocket(endpoint);
    const timeout = setTimeout(() => {
      if (settled.value) return;
      settled.value = true;
      ws.close();
      reject(new Error("Timed out waiting for websocket flow"));
    }, options?.timeoutMs ?? 10_000);

    const finishResolve = (value: T) => {
      if (settled.value) return;
      settled.value = true;
      clearTimeout(timeout);
      ws.close();
      resolve(value);
    };
    const finishReject = (error: Error) => {
      if (settled.value) return;
      settled.value = true;
      clearTimeout(timeout);
      ws.close();
      reject(error);
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(typeof event.data === "string" ? event.data : "");

      if (message.type === "server_hello") {
        activeSessionId = message.sessionId;
      }
      if (!activeSessionId) return;

      handler({
        ws,
        sessionId: activeSessionId,
        message,
        resolve: finishResolve,
        reject: finishReject,
      });
    };

    ws.onerror = (event) => {
      finishReject(new Error(`WebSocket error: ${event}`));
    };
  });
}

describe("WebSocket harness context runtime visibility", () => {
  test("root-session turns inject harness context into the runtime system prompt", async () => {
    const tmpDir = await makeTmpProject();
    const capturedSystems: string[] = [];
    const runTurnImpl = createRunTurn({
      createRuntime: () => ({
        name: "pi",
        runTurn: async (params) => {
          capturedSystems.push(params.system);
          return {
            text: "done",
            responseMessages: [],
          };
        },
      }),
    });
    const { server, url } = await startAgentServer(serverOpts(tmpDir, { runTurnImpl }));

    try {
      await withSession(
        url,
        ({ ws, sessionId, message, resolve }) => {
          if (message.type === "server_hello") {
            ws.send(JSON.stringify({
              type: "harness_context_set",
              sessionId,
              context: {
                runId: "run-root",
                objective: "Verify root runtime prompt injection",
                acceptanceCriteria: ["System prompt contains harness context"],
                constraints: ["Do not override safety policy"],
                metadata: { owner: "agent" },
              },
            }));
            return;
          }

          if (message.type === "harness_context") {
            ws.send(JSON.stringify({
              type: "user_message",
              sessionId,
              text: "run the task",
            }));
            return;
          }

          if (message.type === "assistant_message") {
            resolve(undefined);
          }
        },
      );

      expect(capturedSystems).toHaveLength(1);
      expect(capturedSystems[0]).toContain("## Active Harness Context");
      expect(capturedSystems[0]).toContain("- Run ID: run-root");
      expect(capturedSystems[0]).toContain("- Objective: Verify root runtime prompt injection");
    } finally {
      server.stop();
    }
  }, 30_000);

  test("forked child-agent turns inherit harness context in the runtime prompt", async () => {
    const tmpDir = await makeTmpProject();
    const capturedByRole = new Map<string, string[]>();
    const runTurnImpl = createRunTurn({
      createRuntime: () => ({
        name: "pi",
        runTurn: async (params) => {
          const roleKey = params.config.provider && Object.keys(params.tools).includes("write")
            ? "worker"
            : "unknown";
          const bucket = capturedByRole.get(roleKey) ?? [];
          bucket.push(params.system);
          capturedByRole.set(roleKey, bucket);
          return {
            text: "done",
            responseMessages: [],
          };
        },
      }),
    });
    const { server, url } = await startAgentServer(serverOpts(tmpDir, { runTurnImpl }));

    try {
      await withSession(
        url,
        ({ ws, sessionId, message, resolve }) => {
          if (message.type === "server_hello") {
            ws.send(JSON.stringify({
              type: "harness_context_set",
              sessionId,
              context: {
                runId: "run-child",
                objective: "Verify child runtime prompt injection",
                acceptanceCriteria: ["Forked child sees harness context"],
                constraints: ["Do not duplicate into transcript"],
              },
            }));
            return;
          }

          if (message.type === "harness_context") {
            ws.send(JSON.stringify({
              type: "agent_spawn",
              sessionId,
              role: "worker",
              forkContext: true,
              message: "handle the child task",
            }));
            return;
          }

          if (message.type === "agent_spawned") {
            setTimeout(() => resolve(undefined), 50);
          }
        },
      );

      const workerSystems = capturedByRole.get("worker") ?? [];
      expect(workerSystems.length).toBeGreaterThan(0);
      expect(workerSystems.some((system) => system.includes("- Run ID: run-child"))).toBe(true);
      expect(workerSystems.some((system) => system.includes("- Objective: Verify child runtime prompt injection"))).toBe(true);
    } finally {
      server.stop();
    }
  }, 30_000);

  test("harness context survives restart and resume through the real session boundary", async () => {
    const tmpDir = await makeTmpProject();
    const first = await startAgentServer(serverOpts(tmpDir));
    let sessionId = "";

    try {
      sessionId = await withSession(
        first.url,
        ({ ws, sessionId: nextSessionId, message, resolve }) => {
          if (message.type === "server_hello") {
            ws.send(JSON.stringify({
              type: "harness_context_set",
              sessionId: nextSessionId,
              context: {
                runId: "run-persisted",
                objective: "Persist harness context across restart",
                acceptanceCriteria: ["Resume returns stored harness context"],
                constraints: ["Use the real session boundary"],
              },
            }));
            return;
          }

          if (message.type === "harness_context") {
            resolve(nextSessionId);
          }
        },
      );
    } finally {
      first.server.stop();
    }

    const second = await startAgentServer(serverOpts(tmpDir));
    try {
      const restored = await withSession<any>(
        second.url,
        ({ ws, sessionId: resumedSessionId, message, resolve }) => {
          if (message.type === "server_hello") {
            expect(message.sessionId).toBe(sessionId);
            expect(message.isResume).toBe(true);
            ws.send(JSON.stringify({
              type: "harness_context_get",
              sessionId: resumedSessionId,
            }));
            return;
          }

          if (message.type === "harness_context") {
            resolve(message.context);
          }
        },
        { resumeSessionId: sessionId },
      );

      expect(restored).toMatchObject({
        runId: "run-persisted",
        objective: "Persist harness context across restart",
      });
    } finally {
      second.server.stop();
    }
  }, 30_000);
});
