import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startAgentServer, type StartAgentServerOptions } from "../src/server/startServer";
import {
  ASK_SKIP_TOKEN,
  CLIENT_MESSAGE_TYPES,
  SERVER_EVENT_TYPES,
  WEBSOCKET_PROTOCOL_VERSION,
} from "../src/server/protocol";
import { DEFAULT_PROVIDER_OPTIONS } from "../src/providers";

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

function extractProtocolHeadings(doc: string, startMarker: string, endMarker: string): string[] {
  const startIdx = doc.indexOf(startMarker);
  if (startIdx < 0) return [];
  const endIdx = doc.indexOf(endMarker, startIdx + startMarker.length);
  const section = endIdx >= 0 ? doc.slice(startIdx, endIdx) : doc.slice(startIdx);
  return Array.from(section.matchAll(/^### ([a-z_]+)\s*$/gm)).map((m) => m[1]);
}

/** Create an isolated temp directory that mimics a valid project for the agent. */
async function makeTmpProject(): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-server-test-"));
  // Ensure the .agent dir exists so loadConfig can resolve it
  await fs.mkdir(path.join(tmp, ".agent"), { recursive: true });
  return tmp;
}

/** Common options for starting a test server on an ephemeral port. */
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

/** Helper: open a WebSocket and collect the first N messages. */
function collectMessages(url: string, count: number, timeoutMs = 5000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const messages: any[] = [];
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Timed out waiting for ${count} messages (got ${messages.length})`));
    }, timeoutMs);

    ws.onmessage = (e) => {
      messages.push(JSON.parse(typeof e.data === "string" ? e.data : ""));
      if (messages.length >= count) {
        clearTimeout(timer);
        ws.close();
        resolve(messages);
      }
    };

    ws.onerror = (e) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error: ${e}`));
    };
  });
}

/** Helper: open a WebSocket, wait for server_hello, then send a message and collect N responses. */
function sendAndCollect(
  url: string,
  buildMsg: (sessionId: string) => object,
  responseCount: number,
  timeoutMs = 5000
): Promise<{ hello: any; responses: any[] }> {
  return new Promise((resolve, reject) => {
    const responses: any[] = [];
    let hello: any = null;
    let sent = false;
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      if (hello && responseCount === 0) {
        resolve({ hello, responses });
      } else {
        reject(
          new Error(
            `Timed out waiting for ${responseCount} responses after send (got ${responses.length})`
          )
        );
      }
    }, timeoutMs);

    ws.onmessage = (e) => {
      const msg = JSON.parse(typeof e.data === "string" ? e.data : "");

      if (!hello && msg.type === "server_hello") {
        hello = msg;
        if (!sent) {
          sent = true;
          ws.send(JSON.stringify(buildMsg(msg.sessionId)));
          if (responseCount === 0) {
            clearTimeout(timer);
            // Give a small delay to ensure the message was processed
            setTimeout(() => {
              ws.close();
              resolve({ hello, responses });
            }, 100);
          }
        }
        return;
      }

      if (
        msg.type === "session_settings" ||
        msg.type === "session_config" ||
        msg.type === "session_info" ||
        msg.type === "observability_status" ||
        msg.type === "provider_catalog" ||
        msg.type === "provider_auth_methods" ||
        msg.type === "provider_status" ||
        msg.type === "mcp_servers" ||
        msg.type === "mcp_server_validation" ||
        msg.type === "mcp_server_auth_challenge" ||
        msg.type === "mcp_server_auth_result" ||
        msg.type === "model_stream_chunk"
      ) {
        return;
      }

      responses.push(msg);
      if (responses.length >= responseCount) {
        clearTimeout(timer);
        ws.close();
        resolve({ hello, responses });
      }
    };

    ws.onerror = (e) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error: ${e}`));
    };
  });
}

function sendAndWaitForEvent(
  url: string,
  buildMsg: (sessionId: string) => object,
  match: (message: any) => boolean,
  timeoutMs = 5000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    let sessionId = "";
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Timed out waiting for matching event"));
    }, timeoutMs);

    ws.onmessage = (e) => {
      const msg = JSON.parse(typeof e.data === "string" ? e.data : "");
      if (!sessionId && msg.type === "server_hello") {
        sessionId = msg.sessionId;
        ws.send(JSON.stringify(buildMsg(sessionId)));
        return;
      }
      if (!sessionId || msg.sessionId !== sessionId) return;
      if (!match(msg)) return;

      clearTimeout(timer);
      ws.close();
      resolve(msg);
    };

    ws.onerror = (e) => {
      clearTimeout(timer);
      ws.close();
      reject(new Error(`WebSocket error: ${e}`));
    };
  });
}

function createPersistentSubagent(
  url: string,
  task = "subagent task",
  agentType: "general" | "research" | "explore" = "general",
  timeoutMs = 5000,
): Promise<{ parentSessionId: string; subagent: any }> {
  return new Promise((resolve, reject) => {
    let parentSessionId = "";
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Timed out waiting for subagent_created"));
    }, timeoutMs);

    ws.onmessage = (e) => {
      const msg = JSON.parse(typeof e.data === "string" ? e.data : "");
      if (!parentSessionId && msg.type === "server_hello") {
        parentSessionId = msg.sessionId;
        ws.send(JSON.stringify({ type: "subagent_create", sessionId: parentSessionId, agentType, task }));
        return;
      }

      if (msg.type !== "subagent_created" || msg.sessionId !== parentSessionId) return;
      clearTimeout(timer);
      ws.close();
      resolve({ parentSessionId, subagent: msg.subagent });
    };

    ws.onerror = (e) => {
      clearTimeout(timer);
      ws.close();
      reject(new Error(`WebSocket error: ${e}`));
    };
  });
}

function collectSessionEventsUntil(
  url: string,
  resumeSessionId: string,
  match: (message: any) => boolean,
  timeoutMs = 5000,
): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const seen: any[] = [];
    const ws = new WebSocket(`${url}?resumeSessionId=${resumeSessionId}`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Timed out waiting for matching session event"));
    }, timeoutMs);

    ws.onmessage = (e) => {
      const msg = JSON.parse(typeof e.data === "string" ? e.data : "");
      seen.push(msg);
      if (!match(msg)) return;
      clearTimeout(timer);
      ws.close();
      resolve(seen);
    };

    ws.onerror = (e) => {
      clearTimeout(timer);
      ws.close();
      reject(new Error(`WebSocket error: ${e}`));
    };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Server Startup", () => {
  test("startAgentServer returns server, config, system, and url", async () => {
    const tmpDir = await makeTmpProject();
    const { server, config, system, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      expect(server).toBeDefined();
      expect(typeof server.port).toBe("number");
      expect(server.port).toBeGreaterThan(0);
      expect(config).toBeDefined();
      expect(typeof config.provider).toBe("string");
      expect(typeof system).toBe("string");
      expect(system.length).toBeGreaterThan(0);
      expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/ws$/);
    } finally {
      server.stop();
    }
  });

  test("creates projectAgentDir on startup", async () => {
    const tmpDir = await makeTmpProject();
    // Remove the .agent dir so startServer has to create it
    await fs.rm(path.join(tmpDir, ".agent"), { recursive: true, force: true });
    const { server, config } = await startAgentServer(serverOpts(tmpDir));
    try {
      const stat = await fs.stat(config.projectAgentDir);
      expect(stat.isDirectory()).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("does NOT create outputDirectory or uploadsDirectory on startup", async () => {
    const tmpDir = await makeTmpProject();
    const { server, config } = await startAgentServer(serverOpts(tmpDir));
    try {
      // outputDirectory and uploadsDirectory should be undefined by default
      expect(config.outputDirectory).toBeUndefined();
      expect(config.uploadsDirectory).toBeUndefined();
      // Verify no 'output' or 'uploads' dirs were created in the project
      await expect(fs.stat(path.join(tmpDir, "output"))).rejects.toThrow();
      await expect(fs.stat(path.join(tmpDir, "uploads"))).rejects.toThrow();
    } finally {
      server.stop();
    }
  });

  test("uses provided hostname and port 0 for ephemeral port", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, { hostname: "127.0.0.1", port: 0 })
    );
    try {
      expect(server.port).toBeGreaterThan(0);
      expect(url).toContain("127.0.0.1");
    } finally {
      server.stop();
    }
  });

  test("loads config with the correct provider from env", async () => {
    const tmpDir = await makeTmpProject();
    const { server, config } = await startAgentServer(
      serverOpts(tmpDir, {
        env: {
          AGENT_WORKING_DIR: tmpDir,
          AGENT_PROVIDER: "anthropic",
          COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP: "1",
        },
      })
    );
    try {
      expect(config.provider).toBe("anthropic");
    } finally {
      server.stop();
    }
  });

  test("shared startup omits built-in skills from active runtime config", async () => {
    const tmpDir = await makeTmpProject();
    const { server, config } = await startAgentServer(serverOpts(tmpDir));
    try {
      expect(config.skillsDirs).toHaveLength(3);
      expect(config.skillsDirs[1]).toBe(path.join(tmpDir, ".cowork", "skills"));
    } finally {
      server.stop();
    }
  });

  test("loads system prompt as a non-empty string", async () => {
    const tmpDir = await makeTmpProject();
    const { server, system } = await startAgentServer(serverOpts(tmpDir));
    try {
      expect(typeof system).toBe("string");
      expect(system.length).toBeGreaterThan(10);
    } finally {
      server.stop();
    }
  });

  test("config workingDirectory matches cwd", async () => {
    const tmpDir = await makeTmpProject();
    const { server, config } = await startAgentServer(serverOpts(tmpDir));
    try {
      expect(config.workingDirectory).toBe(tmpDir);
    } finally {
      server.stop();
    }
  });
});

describe("HTTP Handler", () => {
  test("non-/ws path returns 200 OK", async () => {
    const tmpDir = await makeTmpProject();
    const { server } = await startAgentServer(serverOpts(tmpDir));
    try {
      const httpUrl = `http://127.0.0.1:${server.port}/`;
      const res = await fetch(httpUrl);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe("OK");
    } finally {
      server.stop();
    }
  });

  test("arbitrary path returns 200 OK", async () => {
    const tmpDir = await makeTmpProject();
    const { server } = await startAgentServer(serverOpts(tmpDir));
    try {
      const httpUrl = `http://127.0.0.1:${server.port}/health`;
      const res = await fetch(httpUrl);
      expect(res.status).toBe(200);
    } finally {
      server.stop();
    }
  });

  test("/ws path with standard HTTP GET (no upgrade) returns 400", async () => {
    const tmpDir = await makeTmpProject();
    const { server } = await startAgentServer(serverOpts(tmpDir));
    try {
      const httpUrl = `http://127.0.0.1:${server.port}/ws`;
      const res = await fetch(httpUrl);
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toBe("WebSocket upgrade failed");
    } finally {
      server.stop();
    }
  });

  test("/ws path upgrades to WebSocket successfully", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const messages = await collectMessages(url, 1);
      expect(messages.length).toBe(1);
      expect(messages[0].type).toBe("server_hello");
    } finally {
      server.stop();
    }
  });
});

describe("WebSocket Lifecycle", () => {
  test("on connect, receives server_hello with sessionId", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const messages = await collectMessages(url, 1);
      const hello = messages[0];
      expect(hello.type).toBe("server_hello");
      expect(typeof hello.sessionId).toBe("string");
      expect(hello.sessionId.length).toBeGreaterThan(0);
      expect(hello.protocolVersion).toBe(WEBSOCKET_PROTOCOL_VERSION);
    } finally {
      server.stop();
    }
  });

  test("server_hello contains config with provider, model, workingDirectory", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const messages = await collectMessages(url, 1);
      const hello = messages[0];
      expect(hello.config).toBeDefined();
      expect(typeof hello.config.provider).toBe("string");
      expect(typeof hello.config.model).toBe("string");
      expect(typeof hello.config.workingDirectory).toBe("string");
      // outputDirectory is optional and absent by default
      expect(hello.config.outputDirectory).toBeUndefined();
    } finally {
      server.stop();
    }
  });

  test("server_hello advertises model_stream_chunk capability", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const messages = await collectMessages(url, 1);
      const hello = messages[0];
      expect(hello.type).toBe("server_hello");
      expect(hello.capabilities).toBeDefined();
      expect(hello.capabilities.modelStreamChunk).toBe("v1");
    } finally {
      server.stop();
    }
  });

  test("connect emits initial session_info snapshot", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const messages = await collectMessages(url, 4);
      const hello = messages.find((msg: any) => msg.type === "server_hello");
      const info = messages.find((msg: any) => msg.type === "session_info");
      expect(hello).toBeDefined();
      expect(info).toBeDefined();
      expect(info.title).toBe("New session");
      expect(info.titleSource).toBe("default");
      expect(info.titleModel).toBeNull();
      expect(info.provider).toBe(hello.config.provider);
      expect(info.model).toBe(hello.config.model);
      expect(typeof info.createdAt).toBe("string");
      expect(typeof info.updatedAt).toBe("string");
    } finally {
      server.stop();
    }
  });

  test("connect emits initial session_config snapshot", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const messages = await collectMessages(url, 4);
      const configEvt = messages.find((msg: any) => msg.type === "session_config");
      expect(configEvt).toBeDefined();
      expect(configEvt.config).toBeDefined();
      expect(typeof configEvt.config.yolo).toBe("boolean");
      expect(typeof configEvt.config.observabilityEnabled).toBe("boolean");
      expect(typeof configEvt.config.defaultBackupsEnabled).toBe("boolean");
      expect(typeof configEvt.config.toolOutputOverflowChars).toBe("number");
      expect("defaultToolOutputOverflowChars" in configEvt.config).toBe(false);
      expect(typeof configEvt.config.subAgentModel).toBe("string");
      expect(typeof configEvt.config.maxSteps).toBe("number");
    } finally {
      server.stop();
    }
  });

  test("connect emits editable provider options when startup defaults are supplied", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir, { providerOptions: DEFAULT_PROVIDER_OPTIONS }));
    try {
      const messages = await collectMessages(url, 4);
      const configEvt = messages.find((msg: any) => msg.type === "session_config");
      expect(configEvt?.config.providerOptions).toEqual({
        openai: {
          reasoningEffort: "high",
          reasoningSummary: "detailed",
          textVerbosity: "medium",
        },
        "codex-cli": {
          reasoningEffort: "high",
          reasoningSummary: "detailed",
          textVerbosity: "medium",
        },
      });
    } finally {
      server.stop();
    }
  });

  test("first user_message triggers a session_info title update", async () => {
    const tmpDir = await makeTmpProject();
    const runTurnImpl = async () => ({
      text: "",
      reasoningText: undefined,
      responseMessages: [],
    });
    const { server, url } = await startAgentServer({
      ...serverOpts(tmpDir),
      runTurnImpl: runTurnImpl as any,
    });

    try {
      const infoEvents = await new Promise<any[]>((resolve, reject) => {
        const ws = new WebSocket(url);
        const seen: any[] = [];
        let sessionId = "";
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          ws.close();
          reject(new Error("Timed out waiting for session_info title update"));
        }, 15_000);

        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ws.close();
          resolve(seen.filter((evt) => evt.type === "session_info"));
        };

        ws.onmessage = (e) => {
          const msg = JSON.parse(typeof e.data === "string" ? e.data : "");
          seen.push(msg);
          if (!sessionId && msg.type === "server_hello") {
            sessionId = msg.sessionId;
            ws.send(JSON.stringify({ type: "user_message", sessionId, text: "build websocket title persistence" }));
            return;
          }
          if (msg.type === "session_info" && msg.titleSource !== "default") {
            finish();
          }
        };

        ws.onerror = (e) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ws.close();
          reject(new Error(`WebSocket error: ${e}`));
        };
      });

      expect(infoEvents.length).toBeGreaterThanOrEqual(2);
      expect(infoEvents[0]?.titleSource).toBe("default");
      const updated = infoEvents.find((evt) => evt.titleSource !== "default");
      expect(updated).toBeDefined();
      expect(typeof updated.title).toBe("string");
      expect(updated.title.trim().length).toBeGreaterThan(0);
    } finally {
      server.stop();
    }
  }, 10_000);

  test("server_hello config.workingDirectory matches the cwd", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const messages = await collectMessages(url, 1);
      expect(messages[0].config.workingDirectory).toBe(tmpDir);
    } finally {
      server.stop();
    }
  });

  test("connect emits observability_status", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const messages = await collectMessages(url, 5);
      const status = messages.find((msg: any) => msg.type === "observability_status");
      expect(status).toBeDefined();
      expect(typeof status.enabled).toBe("boolean");
      expect(status.health).toBeDefined();
      expect(typeof status.health.status).toBe("string");
      expect(typeof status.health.reason).toBe("string");
      expect(status.config === null || status.config.provider === "langfuse").toBe(true);
      if (status.config) {
        expect(typeof status.config.hasPublicKey).toBe("boolean");
        expect(typeof status.config.hasSecretKey).toBe("boolean");
        expect(typeof status.config.configured).toBe("boolean");
      }
    } finally {
      server.stop();
    }
  });

  test("each connection gets a unique sessionId", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const [msgs1, msgs2] = await Promise.all([collectMessages(url, 1), collectMessages(url, 1)]);
      expect(msgs1[0].sessionId).not.toBe(msgs2[0].sessionId);
    } finally {
      server.stop();
    }
  });

  test("resumeSessionId query param reattaches a recently disconnected session", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const first = await collectMessages(url, 1);
      const originalSessionId = first[0]?.sessionId;
      expect(typeof originalSessionId).toBe("string");
      expect(originalSessionId.length).toBeGreaterThan(0);

      const resumed = await collectMessages(`${url}?resumeSessionId=${originalSessionId}`, 1);
      expect(resumed[0]?.type).toBe("server_hello");
      expect(resumed[0]?.sessionId).toBe(originalSessionId);
    } finally {
      server.stop();
    }
  });

  test("resumeSessionId replays turn events emitted while the client was disconnected", async () => {
    const tmpDir = await makeTmpProject();
    const runTurnImpl = async (params: any) => {
      await params.onModelStreamPart?.({ type: "start" });
      await params.onModelStreamPart?.({ type: "text-delta", id: "txt_resume", text: "before disconnect" });
      await new Promise((resolve) => setTimeout(resolve, 75));
      await params.onModelStreamPart?.({ type: "text-delta", id: "txt_resume", text: "after disconnect" });
      await params.onModelStreamPart?.({ type: "finish", finishReason: "stop" });
      return {
        text: "after disconnect",
        responseMessages: [],
      };
    };

    const { server, url } = await startAgentServer(serverOpts(tmpDir, {
      runTurnImpl: runTurnImpl as any,
    }));

    try {
      const originalSessionId = await new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(url);
        let sessionId = "";
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error("Timed out waiting for disconnect replay setup"));
        }, 5000);

        ws.onmessage = (e) => {
          const msg = JSON.parse(typeof e.data === "string" ? e.data : "");
          if (!sessionId && msg.type === "server_hello") {
            sessionId = msg.sessionId;
            ws.send(JSON.stringify({ type: "user_message", sessionId, text: "resume me" }));
            return;
          }

          if (
            msg.type === "model_stream_chunk" &&
            msg.partType === "text_delta" &&
            typeof msg.part?.text === "string" &&
            msg.part.text.includes("before disconnect")
          ) {
            clearTimeout(timer);
            ws.close();
            resolve(sessionId);
          }
        };

        ws.onerror = (event) => {
          clearTimeout(timer);
          reject(new Error(`WebSocket error during replay setup: ${event}`));
        };
      });

      await new Promise((resolve) => setTimeout(resolve, 150));

      const resumedEvents = await new Promise<any[]>((resolve, reject) => {
        const ws = new WebSocket(`${url}?resumeSessionId=${originalSessionId}`);
        const seen: any[] = [];
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error("Timed out waiting for replayed disconnect events"));
        }, 5000);

        ws.onmessage = (e) => {
          const msg = JSON.parse(typeof e.data === "string" ? e.data : "");
          seen.push(msg);
          if (msg.type === "assistant_message" && msg.text === "after disconnect") {
            clearTimeout(timer);
            ws.close();
            resolve(seen);
          }
        };

        ws.onerror = (event) => {
          clearTimeout(timer);
          ws.close();
          reject(new Error(`WebSocket error during replay verification: ${event}`));
        };
      });

      expect(resumedEvents.some((evt) => evt.type === "server_hello" && evt.sessionId === originalSessionId)).toBe(true);
      expect(
        resumedEvents.some(
          (evt) =>
            evt.type === "model_stream_chunk" &&
            evt.partType === "text_delta" &&
            typeof evt.part?.text === "string" &&
            evt.part.text.includes("after disconnect")
        )
      ).toBe(true);
      expect(resumedEvents.some((evt) => evt.type === "assistant_message" && evt.text === "after disconnect")).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("resumeSessionId cold-rehydrates from storage after full server restart", async () => {
    const tmpDir = await makeTmpProject();

    const first = await startAgentServer(serverOpts(tmpDir));
    const originalSessionId = (await collectMessages(first.url, 1))[0]?.sessionId as string;
    expect(typeof originalSessionId).toBe("string");
    first.server.stop();

    const second = await startAgentServer(serverOpts(tmpDir));
    try {
      const resumed = await collectMessages(`${second.url}?resumeSessionId=${originalSessionId}`, 1);
      expect(resumed[0]?.type).toBe("server_hello");
      expect(resumed[0]?.sessionId).toBe(originalSessionId);
      expect(resumed[0]?.isResume).toBe(true);
      expect(resumed[0]?.resumedFromStorage).toBe(true);
    } finally {
      second.server.stop();
    }
  });

  test("session_close disposes runtime binding but keeps persisted history resumable", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const originalSessionId = await new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(url);
        let sessionId = "";
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error("Timed out waiting for session_close flow"));
        }, 5000);

        ws.onmessage = (e) => {
          const msg = JSON.parse(typeof e.data === "string" ? e.data : "");
          if (msg.type !== "server_hello") return;
          sessionId = msg.sessionId;
          ws.send(JSON.stringify({ type: "session_close", sessionId }));
        };

        ws.onclose = () => {
          clearTimeout(timer);
          if (!sessionId) {
            reject(new Error("Session closed before server_hello"));
            return;
          }
          resolve(sessionId);
        };

        ws.onerror = (event) => {
          clearTimeout(timer);
          reject(new Error(`WebSocket error during session_close flow: ${event}`));
        };
      });

      const resumed = await collectMessages(`${url}?resumeSessionId=${originalSessionId}`, 1);
      expect(resumed[0]?.type).toBe("server_hello");
      expect(resumed[0]?.sessionId).toBe(originalSessionId);
      expect(resumed[0]?.isResume).toBe(true);
      expect(resumed[0]?.resumedFromStorage).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("subagent_create creates a durable child session with resumable replay and child metadata", async () => {
    const tmpDir = await makeTmpProject();
    const runTurnImpl = async (params: any) => {
      await params.onModelStreamPart?.({ type: "start" });
      await params.onModelStreamPart?.({ type: "text-delta", id: "txt_child", text: "subagent stream" });
      await params.onModelStreamPart?.({ type: "finish", finishReason: "stop" });
      return {
        text: "subagent finished",
        responseMessages: [],
      };
    };
    const { server, url } = await startAgentServer(serverOpts(tmpDir, {
      runTurnImpl: runTurnImpl as any,
    }));

    try {
      const created = await createPersistentSubagent(url, "subagent task", "general");
      const childId = created.subagent.sessionId as string;

      const resumedEvents = await collectSessionEventsUntil(
        url,
        childId,
        (msg) => msg.type === "assistant_message" && msg.text === "subagent finished",
        5000,
      );

      const hello = resumedEvents.find((msg) => msg.type === "server_hello");
      const info = resumedEvents.find((msg) => msg.type === "session_info");
      expect(hello).toMatchObject({
        sessionId: childId,
        isResume: true,
        sessionKind: "subagent",
        parentSessionId: created.parentSessionId,
        agentType: "general",
      });
      expect(info).toMatchObject({
        sessionId: childId,
        sessionKind: "subagent",
        parentSessionId: created.parentSessionId,
        agentType: "general",
      });
      expect(
        resumedEvents.some(
          (msg) =>
            msg.type === "model_stream_chunk" &&
            msg.partType === "text_delta" &&
            typeof msg.part?.text === "string" &&
            msg.part.text.includes("subagent stream"),
        ),
      ).toBe(true);
      expect(resumedEvents.some((msg) => msg.type === "assistant_message" && msg.text === "subagent finished")).toBe(
        true,
      );
    } finally {
      server.stop();
    }
  });

  test("subagent_sessions_get lists child sessions and child sessions cannot call list_sessions", async () => {
    const tmpDir = await makeTmpProject();
    const runTurnImpl = async () => ({
      text: "done",
      responseMessages: [],
    });
    const { server, url } = await startAgentServer(serverOpts(tmpDir, {
      runTurnImpl: runTurnImpl as any,
    }));

    try {
      const listing = await new Promise<any>((resolve, reject) => {
        const ws = new WebSocket(url);
        let rootId = "";
        let createdChildId = "";
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error("Timed out waiting for subagent_sessions"));
        }, 5000);

        ws.onmessage = (e) => {
          const msg = JSON.parse(typeof e.data === "string" ? e.data : "");
          if (!rootId && msg.type === "server_hello") {
            rootId = msg.sessionId;
            ws.send(JSON.stringify({ type: "subagent_create", sessionId: rootId, agentType: "research", task: "research this" }));
            return;
          }
          if (msg.type === "subagent_created") {
            createdChildId = msg.subagent.sessionId;
            ws.send(JSON.stringify({ type: "subagent_sessions_get", sessionId: rootId }));
            return;
          }
          if (msg.type !== "subagent_sessions") return;
          clearTimeout(timer);
          ws.close();
          resolve({ rootId, createdChildId, subagents: msg.subagents });
        };

        ws.onerror = (e) => {
          clearTimeout(timer);
          ws.close();
          reject(new Error(`WebSocket error: ${e}`));
        };
      });

      expect(listing.subagents).toHaveLength(1);
      expect(listing.subagents[0]).toMatchObject({
        sessionId: listing.createdChildId,
        parentSessionId: listing.rootId,
        agentType: "research",
      });

      const childError = await sendAndWaitForEvent(
        `${url}?resumeSessionId=${listing.createdChildId}`,
        (sessionId) => ({ type: "list_sessions", sessionId }),
        (msg) => msg.type === "error",
      );
      expect(childError.code).toBe("validation_failed");
      expect(childError.message).toContain("Only root sessions can list sessions");
    } finally {
      server.stop();
    }
  });

  test("research children use model while general children use subAgentModel", async () => {
    const tmpDir = await makeTmpProject();
    await fs.writeFile(
      path.join(tmpDir, ".agent", "config.json"),
      `${JSON.stringify({
        provider: "google",
        model: "gemini-3-pro-preview",
        subAgentModel: "gemini-3-flash-preview",
      }, null, 2)}\n`,
      "utf-8",
    );
    const runTurnImpl = async () => ({
      text: "done",
      responseMessages: [],
    });
    const { server, url } = await startAgentServer(serverOpts(tmpDir, {
      runTurnImpl: runTurnImpl as any,
    }));

    try {
      const general = await createPersistentSubagent(url, "general task", "general");
      const research = await createPersistentSubagent(url, "research task", "research");

      expect(general.subagent.model).toBe("gemini-3-flash-preview");
      expect(research.subagent.model).toBe("gemini-3-pro-preview");
    } finally {
      server.stop();
    }
  });

  test("deleting a root session removes its persistent subagent resume target", async () => {
    const tmpDir = await makeTmpProject();
    const runTurnImpl = async () => ({
      text: "done",
      responseMessages: [],
    });
    const { server, url } = await startAgentServer(serverOpts(tmpDir, {
      runTurnImpl: runTurnImpl as any,
    }));

    try {
      const created = await createPersistentSubagent(url, "child task", "general");

      await sendAndWaitForEvent(
        url,
        (sessionId) => ({ type: "delete_session", sessionId, targetSessionId: created.parentSessionId }),
        (msg) => msg.type === "session_deleted" && msg.targetSessionId === created.parentSessionId,
      );

      const hello = (await collectMessages(`${url}?resumeSessionId=${created.subagent.sessionId}`, 1))[0];
      expect(hello.type).toBe("server_hello");
      expect(hello.sessionId).not.toBe(created.subagent.sessionId);
      expect(hello.sessionKind).toBe("root");
    } finally {
      server.stop();
    }
  });

  test("child session model changes stay session-local and do not persist project defaults", async () => {
    const tmpDir = await makeTmpProject();
    const runTurnImpl = async () => ({
      text: "done",
      responseMessages: [],
    });
    const { server, url } = await startAgentServer(serverOpts(tmpDir, {
      runTurnImpl: runTurnImpl as any,
    }));

    try {
      const created = await createPersistentSubagent(url, "child task", "general");
      const childId = created.subagent.sessionId as string;

      const update = await sendAndWaitForEvent(
        `${url}?resumeSessionId=${childId}`,
        (sessionId) => ({ type: "set_model", sessionId, model: "gemini-3-pro-preview" }),
        (msg) => msg.type === "config_updated",
      );
      expect(update.config.model).toBe("gemini-3-pro-preview");

      await expect(fs.readFile(path.join(tmpDir, ".agent", "config.json"), "utf-8")).rejects.toThrow();
    } finally {
      server.stop();
    }
  });

  test("sending client_hello is handled gracefully (no error returned)", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const { hello, responses } = await sendAndCollect(
        url,
        () => ({ type: "client_hello", client: "test", version: "1.0" }),
        0,
        1500
      );
      expect(hello.type).toBe("server_hello");
      // client_hello should not trigger an error
      expect(responses.filter((r: any) => r.type === "error")).toHaveLength(0);
    } finally {
      server.stop();
    }
  });

  test("sending invalid JSON receives error event", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const result = await new Promise<any>((resolve, reject) => {
        const ws = new WebSocket(url);
        let hello = false;
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error("Timed out"));
        }, 5000);

        ws.onmessage = (e) => {
          const msg = JSON.parse(typeof e.data === "string" ? e.data : "");
          if (!hello && msg.type === "server_hello") {
            hello = true;
            ws.send("this is not valid json {{{");
            return;
          }
          if (msg.type !== "error") return;
          clearTimeout(timer);
          ws.close();
          resolve(msg);
        };
      });

      expect(result.type).toBe("error");
      expect(result.message).toContain("Invalid JSON");
      expect(result.code).toBe("invalid_json");
      expect(result.source).toBe("protocol");
    } finally {
      server.stop();
    }
  });

  test("sending message with missing type receives error", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const { responses } = await sendAndCollect(
        url,
        () => ({ notType: "something" }),
        1
      );
      expect(responses[0].type).toBe("error");
      expect(responses[0].message).toContain("Missing type");
      expect(responses[0].code).toBe("missing_type");
      expect(responses[0].source).toBe("protocol");
    } finally {
      server.stop();
    }
  });

  test("sending unknown message type receives error", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const { responses } = await sendAndCollect(
        url,
        () => ({ type: "nonexistent_type", sessionId: "whatever" }),
        1
      );
      expect(responses[0].type).toBe("error");
      expect(responses[0].message).toContain("Unknown type");
      expect(responses[0].code).toBe("unknown_type");
      expect(responses[0].source).toBe("protocol");
    } finally {
      server.stop();
    }
  });

  test("sending message with wrong sessionId receives error", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const { hello, responses } = await sendAndCollect(
        url,
        () => ({ type: "user_message", sessionId: "wrong-session-id", text: "hello" }),
        1
      );
      expect(responses[0].type).toBe("error");
      expect(responses[0].message).toContain("Unknown sessionId");
      expect(responses[0].message).toContain("wrong-session-id");
      expect(responses[0].code).toBe("unknown_session");
      expect(responses[0].source).toBe("protocol");
    } finally {
      server.stop();
    }
  });

  test("sending reset with correct sessionId does not error", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const { hello, responses } = await sendAndCollect(
        url,
        (sessionId) => ({ type: "reset", sessionId }),
        2,
        2000
      );
      expect(hello.type).toBe("server_hello");
      const todosEvt = responses.find((msg) => msg.type === "todos");
      const resetEvt = responses.find((msg) => msg.type === "reset_done");
      expect(todosEvt?.todos).toEqual([]);
      expect(resetEvt).toMatchObject({ type: "reset_done", sessionId: hello.sessionId });
    } finally {
      server.stop();
    }
  });

  test("sending reset with wrong sessionId receives error", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const { responses } = await sendAndCollect(
        url,
        () => ({ type: "reset", sessionId: "bogus-id" }),
        1
      );
      expect(responses[0].type).toBe("error");
      expect(responses[0].message).toContain("Unknown sessionId");
    } finally {
      server.stop();
    }
  });

  test("sending session_backup_get returns session_backup_state", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const { responses } = await sendAndCollect(
        url,
        (sessionId) => ({ type: "session_backup_get", sessionId }),
        1,
        5000
      );

      const backupEvt = responses[0];
      expect(backupEvt.type).toBe("session_backup_state");
      expect(backupEvt.backup).toBeDefined();
      expect(typeof backupEvt.backup.status).toBe("string");
      expect(backupEvt.sessionId).toBeDefined();
    } finally {
      server.stop();
    }
  });

  test("workspace backup control messages emit refreshed workspace_backups snapshots", async () => {
    const tmpDir = await makeTmpProject();
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-server-home-"));
    await fs.writeFile(path.join(tmpDir, "backup.txt"), "one\n", "utf-8");

    const { server, url } = await startAgentServer(serverOpts(tmpDir, { homedir: homeDir }));
    try {
      const result = await new Promise<{ snapshots: any[]; checkpointId: string }>((resolve, reject) => {
        const seen: any[] = [];
        const ws = new WebSocket(url);
        let sessionId = "";
        let stage: "load" | "checkpoint" | "restore" | "delete" = "load";
        let checkpointId = "";
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error("Timed out waiting for workspace backup flow"));
        }, 8000);

        ws.onmessage = async (e) => {
          const msg = JSON.parse(typeof e.data === "string" ? e.data : "");
          if (!sessionId && msg.type === "server_hello") {
            sessionId = msg.sessionId;
            ws.send(JSON.stringify({ type: "workspace_backups_get", sessionId }));
            return;
          }
          if (msg.type !== "workspace_backups" || msg.sessionId !== sessionId) return;

          seen.push(msg);
          const entry = msg.backups.find((item: any) => item.targetSessionId === sessionId);
          if (!entry) return;

          if (stage === "load") {
            stage = "checkpoint";
            ws.send(JSON.stringify({ type: "workspace_backup_checkpoint", sessionId, targetSessionId: sessionId }));
            return;
          }

          if (stage === "checkpoint") {
            checkpointId = entry.checkpoints.at(-1)?.id ?? "";
            if (!checkpointId) return;
            stage = "restore";
            ws.send(JSON.stringify({
              type: "workspace_backup_restore",
              sessionId,
              targetSessionId: sessionId,
              checkpointId,
            }));
            return;
          }

          if (stage === "restore") {
            if (!entry.checkpoints.some((checkpoint: any) => checkpoint.id === checkpointId)) return;
            expect(entry.checkpoints.length).toBeGreaterThanOrEqual(2);
            stage = "delete";
            ws.send(JSON.stringify({
              type: "workspace_backup_delete_checkpoint",
              sessionId,
              targetSessionId: sessionId,
              checkpointId,
            }));
            return;
          }

          clearTimeout(timer);
          ws.close();
          resolve({ snapshots: seen, checkpointId });
        };

        ws.onerror = (e) => {
          clearTimeout(timer);
          ws.close();
          reject(new Error(`WebSocket error: ${e}`));
        };
      });

      expect(result.snapshots).toHaveLength(4);
      expect(result.snapshots.every((snapshot) => snapshot.type === "workspace_backups")).toBe(true);
      const finalSnapshot = result.snapshots.at(-1);
      const finalEntry = finalSnapshot?.backups.find((item: any) => item.targetSessionId === finalSnapshot?.sessionId);
      expect(finalEntry?.checkpoints.some((checkpoint: any) => checkpoint.id === result.checkpointId)).toBe(false);
    } finally {
      server.stop();
    }
  }, 15000);

  test("workspace_backup_delete_entry disables a live backup until re-enabled", async () => {
    const tmpDir = await makeTmpProject();
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-server-home-"));
    await fs.writeFile(path.join(tmpDir, "backup.txt"), "one\n", "utf-8");

    const { server, url } = await startAgentServer(serverOpts(tmpDir, { homedir: homeDir }));
    try {
      const result = await new Promise<{
        sawDisabledConfig: boolean;
        sawReenabledConfig: boolean;
        checkpoints: any[];
      }>((resolve, reject) => {
        const ws = new WebSocket(url);
        let sessionId = "";
        let stage: "load" | "delete" | "wait_reenable" | "reload" = "load";
        let sawDisabledConfig = false;
        let sawReenabledConfig = false;
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error("Timed out waiting for delete/re-enable backup flow"));
        }, 8000);

        ws.onmessage = (e) => {
          const msg = JSON.parse(typeof e.data === "string" ? e.data : "");
          if (!sessionId && msg.type === "server_hello") {
            sessionId = msg.sessionId;
            ws.send(JSON.stringify({ type: "workspace_backups_get", sessionId }));
            return;
          }

          if (msg.sessionId !== sessionId) return;

          if (msg.type === "session_config") {
            if (stage === "delete" && msg.config?.backupsEnabled === false) {
              sawDisabledConfig = true;
              return;
            }
            if (stage === "wait_reenable" && msg.config?.backupsEnabled === true) {
              sawReenabledConfig = true;
              stage = "reload";
              ws.send(JSON.stringify({ type: "workspace_backups_get", sessionId }));
              return;
            }
          }

          if (msg.type !== "workspace_backups") return;

          if (stage === "load") {
            const entry = msg.backups.find((item: any) => item.targetSessionId === sessionId);
            if (!entry) return;
            expect(entry.checkpoints).toHaveLength(1);
            expect(entry.checkpoints[0]?.id).toBe("cp-0001");
            expect(entry.checkpoints[0]?.trigger).toBe("initial");
            stage = "delete";
            ws.send(JSON.stringify({ type: "workspace_backup_delete_entry", sessionId, targetSessionId: sessionId }));
            return;
          }

          if (stage === "delete") {
            const entry = msg.backups.find((item: any) => item.targetSessionId === sessionId);
            if (entry) return;
            stage = "wait_reenable";
            ws.send(JSON.stringify({ type: "set_config", sessionId, config: { backupsEnabled: true } }));
            return;
          }

          if (stage === "reload") {
            const entry = msg.backups.find((item: any) => item.targetSessionId === sessionId);
            if (!entry) return;
            clearTimeout(timer);
            ws.close();
            resolve({
              sawDisabledConfig,
              sawReenabledConfig,
              checkpoints: entry.checkpoints,
            });
          }
        };

        ws.onerror = (e) => {
          clearTimeout(timer);
          ws.close();
          reject(new Error(`WebSocket error: ${e}`));
        };
      });

      expect(result.sawDisabledConfig).toBe(true);
      expect(result.sawReenabledConfig).toBe(true);
      expect(result.checkpoints).toHaveLength(1);
      expect(result.checkpoints[0]?.id).toBe("cp-0001");
      expect(result.checkpoints[0]?.trigger).toBe("initial");
    } finally {
      server.stop();
    }
  }, 15000);

  test("set_enable_mcp updates session_settings deterministically", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const result = await new Promise<any>((resolve, reject) => {
        const ws = new WebSocket(url);
        let sessionId = "";
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error("Timed out waiting for session_settings update"));
        }, 5000);

        ws.onmessage = (e) => {
          const msg = JSON.parse(typeof e.data === "string" ? e.data : "");
          if (!sessionId && msg.type === "server_hello") {
            sessionId = msg.sessionId;
            ws.send(JSON.stringify({ type: "set_enable_mcp", sessionId, enableMcp: false }));
            return;
          }
          if (msg.type === "session_settings" && msg.enableMcp === false) {
            clearTimeout(timer);
            ws.close();
            resolve(msg);
          }
        };

        ws.onerror = (e) => {
          clearTimeout(timer);
          ws.close();
          reject(new Error(`WebSocket error: ${e}`));
        };
      });

      expect(result.type).toBe("session_settings");
      expect(result.enableMcp).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("mcp_servers_get returns layered MCP snapshot", async () => {
    const tmpDir = await makeTmpProject();
    const mcpPath = path.join(tmpDir, ".cowork", "mcp-servers.json");
    await fs.mkdir(path.dirname(mcpPath), { recursive: true });
    await fs.writeFile(
      mcpPath,
      JSON.stringify(
        {
          servers: [
            {
              name: "grep",
              transport: { type: "http", url: "https://mcp.grep.app" },
              auth: { type: "oauth", oauthMode: "auto" },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const response = await sendAndWaitForEvent(
        url,
        (sessionId) => ({ type: "mcp_servers_get", sessionId }),
        (msg) => msg.type === "mcp_servers",
      );
      expect(response.type).toBe("mcp_servers");
      expect(Array.isArray(response.servers)).toBe(true);
      expect(Array.isArray(response.files)).toBe(true);
      expect(response.servers[0]?.name).toBe("grep");
      expect(response.servers[0]?.source).toBe("workspace");
      expect(response.files.some((file: any) => file.path === mcpPath)).toBe(true);
      expect(
        path.normalize(response.legacy.workspace.path).endsWith(path.join(".agent", "mcp-servers.json"))
      ).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("mcp_server_upsert persists workspace .cowork config and re-emits mcp_servers", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const response = await sendAndWaitForEvent(
        url,
        (sessionId) => ({
          type: "mcp_server_upsert",
          sessionId,
          server: {
            name: "local",
            transport: { type: "stdio", command: "echo", args: ["ok"] },
            auth: { type: "none" },
          },
        }),
        (msg) => msg.type === "mcp_servers" && msg.servers.some((server: any) => server.name === "local"),
      );
      expect(response.type).toBe("mcp_servers");
      expect(response.servers.some((entry: any) => entry.name === "local")).toBe(true);

      const persistedRaw = await fs.readFile(path.join(tmpDir, ".cowork", "mcp-servers.json"), "utf-8");
      const persisted = JSON.parse(persistedRaw) as any;
      expect(Array.isArray(persisted.servers)).toBe(true);
      expect(persisted.servers.some((entry: any) => entry.name === "local")).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("mcp_server_validate emits validation event", async () => {
    const tmpDir = await makeTmpProject();
    const configPath = path.join(tmpDir, ".cowork", "mcp-servers.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          servers: [{ name: "broken", transport: { type: "stdio", command: "echo", args: ["hello"] } }],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const response = await sendAndWaitForEvent(
        url,
        (sessionId) => ({ type: "mcp_server_validate", sessionId, name: "broken" }),
        (msg) => msg.type === "mcp_server_validation" && msg.name === "broken",
      );
      expect(response.type).toBe("mcp_server_validation");
      expect(typeof response.ok).toBe("boolean");
      expect(typeof response.message).toBe("string");
    } finally {
      server.stop();
    }
  });

  test("mcp_server_auth_set_api_key stores credential outside mcp-servers.json", async () => {
    const tmpDir = await makeTmpProject();
    const configPath = path.join(tmpDir, ".cowork", "mcp-servers.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          servers: [
            {
              name: "protected",
              transport: { type: "http", url: "https://mcp.example.com" },
              auth: { type: "api_key", headerName: "Authorization", prefix: "Bearer" },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const response = await sendAndWaitForEvent(
        url,
        (sessionId) => ({
          type: "mcp_server_auth_set_api_key",
          sessionId,
          name: "protected",
          apiKey: "test-secret",
        }),
        (msg) => msg.type === "mcp_server_auth_result" && msg.name === "protected",
      );
      expect(response.type).toBe("mcp_server_auth_result");
      expect(response.ok).toBe(true);
      expect(response.mode).toBe("api_key");

      const credentialsPath = path.join(tmpDir, ".cowork", "auth", "mcp-credentials.json");
      const credentialsRaw = await fs.readFile(credentialsPath, "utf-8");
      expect(credentialsRaw).toContain("test-secret");

      const configRaw = await fs.readFile(configPath, "utf-8");
      expect(configRaw).not.toContain("test-secret");
    } finally {
      server.stop();
    }
  });

  test("list_commands returns commands metadata", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const { responses } = await sendAndCollect(
        url,
        (sessionId) => ({ type: "list_commands", sessionId }),
        1
      );

      expect(responses[0].type).toBe("commands");
      expect(Array.isArray(responses[0].commands)).toBe(true);
      expect(responses[0].commands.some((cmd: any) => cmd.name === "init")).toBe(true);
      expect(responses[0].commands.some((cmd: any) => cmd.name === "review")).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("execute_command with unknown name returns validation error", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const { responses } = await sendAndCollect(
        url,
        (sessionId) => ({ type: "execute_command", sessionId, name: "does-not-exist" }),
        1
      );

      expect(responses[0].type).toBe("error");
      expect(responses[0].code).toBe("validation_failed");
      expect(responses[0].message).toContain("Unknown command");
    } finally {
      server.stop();
    }
  });

  test("execute_command known command enters normal turn flow", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const { responses } = await sendAndCollect(
        url,
        (sessionId) => ({
          type: "execute_command",
          sessionId,
          name: "review",
          arguments: "HEAD~1..HEAD",
        }),
        2
      );

      expect(responses[0].type).toBe("user_message");
      expect(responses[0].text).toBe("/review HEAD~1..HEAD");
      expect(responses[1].type).toBe("session_busy");
      expect(responses[1].busy).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("harness_context_set returns harness_context", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const { responses } = await sendAndCollect(
        url,
        (sessionId) => ({
          type: "harness_context_set",
          sessionId,
          context: {
            runId: "run-01",
            objective: "Improve startup reliability",
            acceptanceCriteria: ["startup < 800ms"],
            constraints: ["no API changes"],
          },
        }),
        1
      );
      expect(responses[0].type).toBe("harness_context");
      expect(responses[0].context.runId).toBe("run-01");
    } finally {
      server.stop();
    }
  });

  test("removed observability_query message is rejected", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const { responses } = await sendAndCollect(
        url,
        (sessionId) => ({
          type: "observability_query",
          sessionId,
          query: { queryType: "promql", query: "up" },
        }),
        1
      );
      expect(responses[0].type).toBe("error");
      expect(responses[0].code).toBe("unknown_type");
      expect(String(responses[0].message)).toContain("Unknown type: observability_query");
    } finally {
      server.stop();
    }
  });

  test("removed harness_slo_evaluate message is rejected", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const { responses } = await sendAndCollect(
        url,
        (sessionId) => ({
          type: "harness_slo_evaluate",
          sessionId,
          checks: [
            {
              id: "vector_errors",
              type: "custom",
              queryType: "promql",
              query: "sum(rate(vector_component_errors_total[5m]))",
              op: "<=",
              threshold: 0,
              windowSec: 300,
            },
          ],
        }),
        1
      );
      expect(responses[0].type).toBe("error");
      expect(responses[0].code).toBe("unknown_type");
      expect(String(responses[0].message)).toContain("Unknown type: harness_slo_evaluate");
    } finally {
      server.stop();
    }
  });

  test("sending a non-object JSON value receives error", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const result = await new Promise<any>((resolve, reject) => {
        const ws = new WebSocket(url);
        let hello = false;
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error("Timed out"));
        }, 5000);

        ws.onmessage = (e) => {
          const msg = JSON.parse(typeof e.data === "string" ? e.data : "");
          if (!hello && msg.type === "server_hello") {
            hello = true;
            ws.send(JSON.stringify("just a string"));
            return;
          }
          if (msg.type !== "error") return;
          clearTimeout(timer);
          ws.close();
          resolve(msg);
        };
      });

      expect(result.type).toBe("error");
      expect(result.message).toContain("Expected object");
      expect(result.code).toBe("invalid_payload");
      expect(result.source).toBe("protocol");
    } finally {
      server.stop();
    }
  });

  test("sending a JSON null receives error", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const result = await new Promise<any>((resolve, reject) => {
        const ws = new WebSocket(url);
        let hello = false;
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error("Timed out"));
        }, 5000);

        ws.onmessage = (e) => {
          const msg = JSON.parse(typeof e.data === "string" ? e.data : "");
          if (!hello && msg.type === "server_hello") {
            hello = true;
            ws.send("null");
            return;
          }
          if (msg.type !== "error") return;
          clearTimeout(timer);
          ws.close();
          resolve(msg);
        };
      });

      expect(result.type).toBe("error");
      expect(result.message).toContain("Expected object");
      expect(result.code).toBe("invalid_payload");
      expect(result.source).toBe("protocol");
    } finally {
      server.stop();
    }
  });

  test("sending a JSON array receives error", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const result = await new Promise<any>((resolve, reject) => {
        const ws = new WebSocket(url);
        let hello = false;
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error("Timed out"));
        }, 5000);

        ws.onmessage = (e) => {
          const msg = JSON.parse(typeof e.data === "string" ? e.data : "");
          if (!hello && msg.type === "server_hello") {
            hello = true;
            ws.send(JSON.stringify([1, 2, 3]));
            return;
          }
          if (msg.type !== "error") return;
          clearTimeout(timer);
          ws.close();
          resolve(msg);
        };
      });

      expect(result.type).toBe("error");
      expect(result.message).toContain("Expected object");
      expect(result.code).toBe("invalid_payload");
      expect(result.source).toBe("protocol");
    } finally {
      server.stop();
    }
  });

  test("on close, session is disposed (no crash on subsequent operations)", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      // Connect, get the hello, then immediately close
      const result = await new Promise<{ hello: any; closed: boolean }>((resolve, reject) => {
        const ws = new WebSocket(url);
        const timer = setTimeout(() => {
          reject(new Error("Timed out"));
        }, 5000);

        ws.onmessage = (e) => {
          const msg = JSON.parse(typeof e.data === "string" ? e.data : "");
          if (msg.type === "server_hello") {
            ws.close();
          }
        };

        ws.onclose = () => {
          clearTimeout(timer);
          resolve({ hello: true, closed: true });
        };
      });

      expect(result.closed).toBe(true);

      // The server should still be healthy after client disconnect -- open another connection
      const messages = await collectMessages(url, 1);
      expect(messages[0].type).toBe("server_hello");
    } finally {
      server.stop();
    }
  });

  test("multiple concurrent connections each get their own session", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const [m1, m2, m3] = await Promise.all([
        collectMessages(url, 1),
        collectMessages(url, 1),
        collectMessages(url, 1),
      ]);
      const ids = new Set([m1[0].sessionId, m2[0].sessionId, m3[0].sessionId]);
      expect(ids.size).toBe(3);
    } finally {
      server.stop();
    }
  });
});

describe("Message Parsing (via protocol)", () => {
  test("valid user_message with correct sessionId does not return protocol error", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      // user_message triggers session.sendUserMessage which calls runTurn.
      // runTurn will likely fail (no actual AI provider), but the message
      // should be parsed successfully -- we expect either a user_message echo
      // or an error from the agent, but NOT a protocol parsing error.
      const { hello, responses } = await sendAndCollect(
        url,
        (sessionId) => ({ type: "user_message", sessionId, text: "test message" }),
        1,
        5000
      );
      expect(hello.type).toBe("server_hello");
      // The response should be the user_message echo or an agent error,
      // but not a protocol parsing error about sessionId or type
      const firstResponse = responses[0];
      if (firstResponse.type === "error") {
        // If there is an error, it should be from the agent (runTurn), not from parsing
        expect(firstResponse.message).not.toContain("Unknown sessionId");
        expect(firstResponse.message).not.toContain("Invalid JSON");
        expect(firstResponse.message).not.toContain("Missing type");
        expect(firstResponse.message).not.toContain("Unknown type");
      } else {
        expect(firstResponse.type).toBe("user_message");
      }
    } finally {
      server.stop();
    }
  });

  test("valid approval_response with wrong sessionId returns sessionId error", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const { responses } = await sendAndCollect(
        url,
        () => ({
          type: "approval_response",
          sessionId: "not-a-real-session",
          requestId: "some-request",
          approved: true,
        }),
        1
      );
      expect(responses[0].type).toBe("error");
      expect(responses[0].message).toContain("Unknown sessionId");
    } finally {
      server.stop();
    }
  });

  test("valid ask_response with wrong sessionId returns sessionId error", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const { responses } = await sendAndCollect(
        url,
        () => ({
          type: "ask_response",
          sessionId: "not-a-real-session",
          requestId: "some-request",
          answer: "yes",
        }),
        1
      );
      expect(responses[0].type).toBe("error");
      expect(responses[0].message).toContain("Unknown sessionId");
    } finally {
      server.stop();
    }
  });

  test("whitespace ask_response is rejected and the same ask is replayed", async () => {
    const tmpDir = await makeTmpProject();
    const runTurnImpl = async (params: any) => {
      const answer = await params.askUser("What kind of doc?");
      return { text: `answer:${answer}`, reasoningText: undefined, responseMessages: [] };
    };
    const { server, url } = await startAgentServer({
      ...serverOpts(tmpDir),
      runTurnImpl: runTurnImpl as any,
    });

    try {
      const result = await new Promise<{
        askRequestIds: string[];
        errors: any[];
        assistant: any;
      }>((resolve, reject) => {
        const ws = new WebSocket(url);
        const askRequestIds: string[] = [];
        const errors: any[] = [];
        let sessionId = "";
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          ws.close();
          reject(new Error("Timed out waiting for ask replay flow"));
        }, 15_000);

        const finish = (assistant: any) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ws.close();
          resolve({ askRequestIds, errors, assistant });
        };

        ws.onmessage = (e) => {
          const msg = JSON.parse(typeof e.data === "string" ? e.data : "");
          if (!sessionId && msg.type === "server_hello") {
            sessionId = msg.sessionId;
            ws.send(JSON.stringify({ type: "user_message", sessionId, text: "start ask" }));
            return;
          }

          if (msg.type === "ask") {
            askRequestIds.push(msg.requestId);
            if (askRequestIds.length === 1) {
              ws.send(JSON.stringify({
                type: "ask_response",
                sessionId,
                requestId: msg.requestId,
                answer: "   ",
              }));
            } else if (askRequestIds.length === 2) {
              ws.send(JSON.stringify({
                type: "ask_response",
                sessionId,
                requestId: msg.requestId,
                answer: ASK_SKIP_TOKEN,
              }));
            }
            return;
          }

          if (msg.type === "error") {
            errors.push(msg);
            return;
          }

          if (msg.type === "assistant_message") {
            finish(msg);
          }
        };

        ws.onerror = (e) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ws.close();
          reject(new Error(`WebSocket error: ${e}`));
        };
      });

      expect(result.askRequestIds.length).toBeGreaterThanOrEqual(2);
      expect(result.askRequestIds[0]).toBe(result.askRequestIds[1]);
      expect(
        result.errors.some(
          (err) =>
            err.type === "error" &&
            err.code === "validation_failed" &&
            err.source === "session" &&
            typeof err.message === "string" &&
            err.message.includes("cannot be empty")
        )
      ).toBe(true);
      expect(result.assistant.text).toBe(`answer:${ASK_SKIP_TOKEN}`);
    } finally {
      server.stop();
    }
  });

  test("ask_response accepts explicit skip token without validation error", async () => {
    const tmpDir = await makeTmpProject();
    const runTurnImpl = async (params: any) => {
      const answer = await params.askUser("Pick one");
      return { text: `answer:${answer}`, reasoningText: undefined, responseMessages: [] };
    };
    const { server, url } = await startAgentServer({
      ...serverOpts(tmpDir),
      runTurnImpl: runTurnImpl as any,
    });

    try {
      const result = await new Promise<{
        askCount: number;
        validationErrors: any[];
        assistant: any;
      }>((resolve, reject) => {
        const ws = new WebSocket(url);
        let askCount = 0;
        const validationErrors: any[] = [];
        let sessionId = "";
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          ws.close();
          reject(new Error("Timed out waiting for explicit skip ask flow"));
        }, 15_000);

        const finish = (assistant: any) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ws.close();
          resolve({ askCount, validationErrors, assistant });
        };

        ws.onmessage = (e) => {
          const msg = JSON.parse(typeof e.data === "string" ? e.data : "");
          if (!sessionId && msg.type === "server_hello") {
            sessionId = msg.sessionId;
            ws.send(JSON.stringify({ type: "user_message", sessionId, text: "start ask" }));
            return;
          }

          if (msg.type === "ask") {
            askCount += 1;
            ws.send(JSON.stringify({
              type: "ask_response",
              sessionId,
              requestId: msg.requestId,
              answer: ASK_SKIP_TOKEN,
            }));
            return;
          }

          if (
            msg.type === "error" &&
            msg.code === "validation_failed" &&
            msg.source === "session"
          ) {
            validationErrors.push(msg);
            return;
          }

          if (msg.type === "assistant_message") {
            finish(msg);
          }
        };

        ws.onerror = (e) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ws.close();
          reject(new Error(`WebSocket error: ${e}`));
        };
      });

      expect(result.askCount).toBe(1);
      expect(result.validationErrors.length).toBe(0);
      expect(result.assistant.text).toBe(`answer:${ASK_SKIP_TOKEN}`);
    } finally {
      server.stop();
    }
  });

  test("error events include the session sessionId", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const result = await new Promise<{ hello: any; error: any }>((resolve, reject) => {
        const ws = new WebSocket(url);
        let helloMsg: any;
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error("Timed out"));
        }, 5000);

        ws.onmessage = (e) => {
          const msg = JSON.parse(typeof e.data === "string" ? e.data : "");
          if (msg.type === "server_hello") {
            helloMsg = msg;
            ws.send("not json!!!");
            return;
          }
          if (msg.type === "error") {
            clearTimeout(timer);
            ws.close();
            resolve({ hello: helloMsg, error: msg });
          }
        };
      });

      // The error event should carry the same sessionId as the hello
      expect(result.error.sessionId).toBe(result.hello.sessionId);
      expect(typeof result.error.code).toBe("string");
      expect(typeof result.error.source).toBe("string");
    } finally {
      server.stop();
    }
  });

  test("sending an empty object (no type field) returns Missing type error", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const { responses } = await sendAndCollect(url, () => ({}), 1);
      expect(responses[0].type).toBe("error");
      expect(responses[0].message).toContain("Missing type");
    } finally {
      server.stop();
    }
  });

  test("sending type with non-string value returns Missing type error", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const { responses } = await sendAndCollect(url, () => ({ type: 42 }), 1);
      expect(responses[0].type).toBe("error");
      expect(responses[0].message).toContain("Missing type");
    } finally {
      server.stop();
    }
  });
});

describe("Server Resilience", () => {
  test("server remains healthy after a client sends bad data and disconnects", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      // First client: send garbage then disconnect
      await new Promise<void>((resolve) => {
        const ws = new WebSocket(url);
        ws.onopen = () => {
          ws.send("garbage garbage garbage");
          setTimeout(() => {
            ws.close();
            resolve();
          }, 200);
        };
      });

      // Second client: should still connect fine
      const messages = await collectMessages(url, 1);
      expect(messages[0].type).toBe("server_hello");
      expect(typeof messages[0].sessionId).toBe("string");
    } finally {
      server.stop();
    }
  });

  test("server remains healthy after rapid connect/disconnect cycles", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      // Rapidly open and close 5 connections
      const promises = Array.from({ length: 5 }, () =>
        new Promise<void>((resolve) => {
          const ws = new WebSocket(url);
          ws.onopen = () => {
            ws.close();
            resolve();
          };
          ws.onerror = () => resolve();
        })
      );
      await Promise.all(promises);

      // Server should still work
      const messages = await collectMessages(url, 1);
      expect(messages[0].type).toBe("server_hello");
    } finally {
      server.stop();
    }
  });

  test("handles 5 parallel sessions with concurrent user_message/cancel/checkpoint traffic", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    const runTraffic = (label: string): Promise<{ sessionId: string; messages: any[] }> =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const messages: any[] = [];
        let sessionId = "";
        let settled = false;
        let sawBusyTrue = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          ws.close();
          reject(new Error(`Timed out in traffic run ${label}`));
        }, 7000);
        let finalizeTimer: ReturnType<typeof setTimeout> | null = null;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (finalizeTimer) {
            clearTimeout(finalizeTimer);
          }
          ws.close();
          resolve({ sessionId, messages });
        };

        ws.onmessage = (e) => {
          const msg = JSON.parse(typeof e.data === "string" ? e.data : "");
          messages.push(msg);

          if (!sessionId && msg.type === "server_hello") {
            sessionId = msg.sessionId;
            ws.send(JSON.stringify({ type: "user_message", sessionId, text: `hello-${label}` }));
            ws.send(JSON.stringify({ type: "cancel", sessionId }));
            ws.send(JSON.stringify({ type: "session_backup_checkpoint", sessionId }));
            finalizeTimer = setTimeout(finish, 2500);
            return;
          }

          if (msg.type === "session_busy" && msg.busy === true) {
            sawBusyTrue = true;
            return;
          }

          if (sawBusyTrue && msg.type === "session_busy" && msg.busy === false) {
            finish();
          }
        };

        ws.onerror = (e) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (finalizeTimer) {
            clearTimeout(finalizeTimer);
          }
          ws.close();
          reject(new Error(`WebSocket error in ${label}: ${e}`));
        };
      });

    try {
      const runs = await Promise.all(
        Array.from({ length: 5 }, (_x, i) => runTraffic(`s${i + 1}`))
      );

      const ids = runs.map((r) => r.sessionId);
      expect(new Set(ids).size).toBe(5);

      for (const run of runs) {
        expect(run.messages.some((m) => m.type === "server_hello")).toBe(true);
        expect(
          run.messages.some(
            (m) =>
              typeof m.sessionId === "string" &&
              m.sessionId !== "" &&
              m.sessionId !== run.sessionId
          )
        ).toBe(false);

        const busyTrueIdx = run.messages.findIndex((m) => m.type === "session_busy" && m.busy === true);
        const busyFalseIdx = run.messages.findIndex((m) => m.type === "session_busy" && m.busy === false);
        if (busyTrueIdx >= 0 && busyFalseIdx >= 0) {
          expect(busyFalseIdx).toBeGreaterThan(busyTrueIdx);
        }

        const backupEvents = run.messages.filter((m) => m.type === "session_backup_state");
        for (const evt of backupEvents) {
          expect(evt.sessionId).toBe(run.sessionId);
        }
      }

      const hello = await collectMessages(url, 1);
      expect(hello[0].type).toBe("server_hello");
    } finally {
      server.stop();
    }
  });

  test("websocket flow emits ordered model_stream_chunk events before legacy final events", async () => {
    const tmpDir = await makeTmpProject();
    const runTurnImpl = async (params: any) => {
      await params.onModelStreamPart?.({ type: "start" });
      await params.onModelStreamPart?.({ type: "text-delta", id: "txt_1", text: "hello" });
      await params.onModelStreamPart?.({ type: "finish", finishReason: "stop" });
      return {
        text: "hello",
        reasoningText: "thinking",
        responseMessages: [],
      };
    };

    const { server, url } = await startAgentServer({
      cwd: tmpDir,
      hostname: "127.0.0.1",
      port: 0,
      homedir: tmpDir,
      env: {
        AGENT_WORKING_DIR: tmpDir,
        AGENT_PROVIDER: "google",
        COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP: "1",
      },
      runTurnImpl: runTurnImpl as any,
    });

    try {
      const events = await new Promise<any[]>((resolve, reject) => {
        const ws = new WebSocket(url);
        const seen: any[] = [];
        let sessionId = "";
        let settled = false;

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          ws.close();
          const observed = seen.map((evt) => evt.type).join(", ");
          reject(new Error(`Timed out waiting for model stream flow. observed=[${observed}]`));
        }, 25_000);

        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ws.close();
          resolve(seen);
        };

        ws.onmessage = (e) => {
          const msg = JSON.parse(typeof e.data === "string" ? e.data : "");
          seen.push(msg);

          if (!sessionId && msg.type === "server_hello") {
            sessionId = msg.sessionId;
            ws.send(JSON.stringify({ type: "user_message", sessionId, text: "hello server" }));
            return;
          }
          if (msg.type === "model_stream_chunk" && msg.partType === "finish") {
            setTimeout(finish, 25);
            return;
          }
          if (msg.type === "assistant_message") {
            setTimeout(finish, 25);
          }
        };

        ws.onerror = (e) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ws.close();
          reject(new Error(`WebSocket error: ${e}`));
        };
      });

      const chunks = events.filter((evt) => evt.type === "model_stream_chunk");
      expect(chunks.map((evt: any) => evt.partType)).toEqual(["start", "text_delta", "finish"]);
      expect(chunks.map((evt: any) => evt.index)).toEqual([0, 1, 2]);
      expect(new Set(chunks.map((evt: any) => evt.turnId)).size).toBe(1);
      expect(new Set(chunks.map((evt: any) => evt.sessionId)).size).toBe(1);

      const streamEnd = events.map((evt) => evt.type).lastIndexOf("model_stream_chunk");
      const reasoningIndex = events.findIndex((evt) => evt.type === "reasoning");
      const assistantIndex = events.findIndex((evt) => evt.type === "assistant_message");
      expect(streamEnd).toBeGreaterThanOrEqual(0);
      expect(reasoningIndex).toBeGreaterThan(streamEnd);
      expect(assistantIndex).toBeGreaterThan(reasoningIndex);
    } finally {
      server.stop();
    }
  }, 30_000);

  test("server.stop() prevents new connections", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    // Confirm it works before stopping
    const messages = await collectMessages(url, 1);
    expect(messages[0].type).toBe("server_hello");

    server.stop();

    // After stopping, connection should fail
    const failed = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        resolve(true);
      }, 2000);
      ws.onopen = () => {
        clearTimeout(timer);
        ws.close();
        resolve(false);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        resolve(true);
      };
    });

    expect(failed).toBe(true);
  });
});

describe("Protocol Doc Parity", () => {
  test("documented client/server message headings match protocol type exports", async () => {
    const docPath = path.join(repoRoot(), "docs", "websocket-protocol.md");
    const doc = await fs.readFile(docPath, "utf-8");

    const documentedClientTypes = extractProtocolHeadings(
      doc,
      "## Client -> Server Messages",
      "## Server -> Client Events",
    );
    const documentedServerTypes = extractProtocolHeadings(
      doc,
      "## Server -> Client Events",
      "## Message Flow Examples",
    );

    expect([...documentedClientTypes].sort()).toEqual([...Array.from(CLIENT_MESSAGE_TYPES)].sort());
    expect([...documentedServerTypes].sort()).toEqual([...Array.from(SERVER_EVENT_TYPES)].sort());
  });

  test("documented control flows remain executable", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const ping = await sendAndCollect(url, (sessionId) => ({ type: "ping", sessionId }), 1);
      expect(ping.responses[0].type).toBe("pong");
      expect(ping.responses[0].sessionId).toBe(ping.hello.sessionId);

      const tools = await sendAndCollect(url, (sessionId) => ({ type: "list_tools", sessionId }), 1);
      expect(tools.responses[0].type).toBe("tools");

      const commands = await sendAndCollect(url, (sessionId) => ({ type: "list_commands", sessionId }), 1);
      expect(commands.responses[0].type).toBe("commands");

      const model = await sendAndCollect(
        url,
        (sessionId) => ({ type: "set_model", sessionId, provider: "openai", model: "gpt-5.2" }),
        1,
      );
      expect(model.responses[0].type).toBe("config_updated");
      if (model.responses[0].type === "config_updated") {
        expect(model.responses[0].config.provider).toBe("openai");
        expect(model.responses[0].config.model).toBe("gpt-5.2");
      }

      const nextSessionHello = (await collectMessages(url, 1))[0];
      expect(nextSessionHello.type).toBe("server_hello");
      expect(nextSessionHello.config.provider).toBe("openai");
      expect(nextSessionHello.config.model).toBe("gpt-5.2");

      const persistedConfigPath = path.join(tmpDir, ".agent", "config.json");
      const persistedConfig = JSON.parse(await fs.readFile(persistedConfigPath, "utf-8")) as Record<string, unknown>;
      expect(persistedConfig.provider).toBe("openai");
      expect(persistedConfig.model).toBe("gpt-5.2");
    } finally {
      server.stop();
    }
  });

  test("set_model applies runtime updates even when project config parse fails", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      await fs.writeFile(path.join(tmpDir, ".agent", "config.json"), "{ not valid json", "utf-8");

      const result = await sendAndCollect(
        url,
        (sessionId) => ({ type: "set_model", sessionId, provider: "openai", model: "gpt-5.2" }),
        2,
      );

      expect(result.responses[0].type).toBe("config_updated");
      if (result.responses[0].type === "config_updated") {
        expect(result.responses[0].config.provider).toBe("openai");
        expect(result.responses[0].config.model).toBe("gpt-5.2");
      }

      expect(result.responses[1].type).toBe("error");
      if (result.responses[1].type === "error") {
        expect(result.responses[1].code).toBe("internal_error");
        expect(result.responses[1].message).toContain("Invalid JSON in config file");
      }

      const nextSessionHello = (await collectMessages(url, 1))[0];
      expect(nextSessionHello.type).toBe("server_hello");
      // Persistence failed, so newly created sessions keep project defaults.
      expect(nextSessionHello.config.provider).toBe("google");
    } finally {
      server.stop();
    }
  });

  test("set_config deep-merges editable providerOptions into project config", async () => {
    const tmpDir = await makeTmpProject();
    await fs.writeFile(
      path.join(tmpDir, ".agent", "config.json"),
      `${JSON.stringify({
        providerOptions: {
          openai: {
            reasoningEffort: "high",
            reasoningSummary: "detailed",
            textVerbosity: "medium",
          },
          google: {
            thinkingConfig: {
              includeThoughts: true,
              thinkingLevel: "low",
            },
          },
        },
      }, null, 2)}\n`,
      "utf-8",
    );

    const { server, url } = await startAgentServer(serverOpts(tmpDir, { providerOptions: DEFAULT_PROVIDER_OPTIONS }));
    try {
      const event = await sendAndWaitForEvent(
        url,
        (sessionId) => ({
          type: "set_config",
          sessionId,
          config: {
            providerOptions: {
              openai: {
                textVerbosity: "low",
              },
              "codex-cli": {
                reasoningEffort: "xhigh",
              },
            },
          },
        }),
        (message) =>
          message.type === "session_config" &&
          message.config?.providerOptions?.openai?.textVerbosity === "low" &&
          message.config?.providerOptions?.["codex-cli"]?.reasoningEffort === "xhigh",
      );

      expect(event.config.providerOptions).toEqual({
        openai: {
          reasoningEffort: "high",
          reasoningSummary: "detailed",
          textVerbosity: "low",
        },
        "codex-cli": {
          reasoningEffort: "xhigh",
          reasoningSummary: "detailed",
          textVerbosity: "medium",
        },
      });
      expect((event.config.providerOptions as any)?.google).toBeUndefined();

      const persistedConfig = JSON.parse(
        await fs.readFile(path.join(tmpDir, ".agent", "config.json"), "utf-8"),
      ) as any;
      expect(persistedConfig.providerOptions.google.thinkingConfig.includeThoughts).toBe(true);
      expect(persistedConfig.providerOptions.google.thinkingConfig.thinkingLevel).toBe("low");
      expect(persistedConfig.providerOptions.openai.reasoningEffort).toBe("high");
      expect(persistedConfig.providerOptions.openai.reasoningSummary).toBe("detailed");
      expect(persistedConfig.providerOptions.openai.textVerbosity).toBe("low");
      expect(persistedConfig.providerOptions["codex-cli"].reasoningEffort).toBe("xhigh");
      expect(persistedConfig.providerOptions["codex-cli"].reasoningSummary).toBe("detailed");
      expect(persistedConfig.providerOptions["codex-cli"].textVerbosity).toBe("medium");
    } finally {
      server.stop();
    }
  });

  test("set_config accepts empty user profile values to clear persisted prompt context", async () => {
    const tmpDir = await makeTmpProject();
    await fs.writeFile(
      path.join(tmpDir, ".agent", "config.json"),
      `${JSON.stringify({
        userName: "Alice",
        userProfile: {
          instructions: "Be concise",
          work: "Engineer",
          details: "Uses TypeScript",
        },
      }, null, 2)}\n`,
      "utf-8",
    );

    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const event = await sendAndWaitForEvent(
        url,
        (sessionId) => ({
          type: "set_config",
          sessionId,
          config: {
            userName: "",
            userProfile: {
              instructions: "",
              work: "",
              details: "",
            },
          },
        }),
        (message) =>
          message.type === "session_config" &&
          message.config?.userName === "" &&
          message.config?.userProfile?.instructions === "" &&
          message.config?.userProfile?.work === "" &&
          message.config?.userProfile?.details === "",
      );

      expect(event.config.userName).toBe("");
      expect(event.config.userProfile).toEqual({
        instructions: "",
        work: "",
        details: "",
      });

      const persistedConfig = JSON.parse(
        await fs.readFile(path.join(tmpDir, ".agent", "config.json"), "utf-8"),
      ) as any;
      expect(persistedConfig.userName).toBe("");
      expect(persistedConfig.userProfile).toEqual({
        instructions: "",
        work: "",
        details: "",
      });
    } finally {
      server.stop();
    }

    const restarted = await startAgentServer(serverOpts(tmpDir));
    try {
      const initialMessages = await collectMessages(restarted.url, 5);
      const sessionConfig = initialMessages.find((message) => message.type === "session_config");
      expect(sessionConfig?.config?.userName).toBe("");
      expect(sessionConfig?.config?.userProfile).toEqual({
        instructions: "",
        work: "",
        details: "",
      });
    } finally {
      restarted.server.stop();
    }
  });

  test("set_config rejects unsupported subAgentModel values before persisting them", async () => {
    const tmpDir = await makeTmpProject();
    await fs.writeFile(
      path.join(tmpDir, ".agent", "config.json"),
      `${JSON.stringify({
        provider: "openai",
        model: "gpt-5.2",
        subAgentModel: "gpt-5.2",
      }, null, 2)}\n`,
      "utf-8",
    );

    const { server, url } = await startAgentServer(serverOpts(tmpDir, {
      env: {
        AGENT_WORKING_DIR: tmpDir,
        AGENT_PROVIDER: "openai",
        COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP: "1",
      },
    }));
    try {
      const errorEvent = await sendAndWaitForEvent(
        url,
        (sessionId) => ({
          type: "set_config",
          sessionId,
          config: {
            subAgentModel: "gemini-3-pro-preview",
          },
        }),
        (message) => message.type === "error",
      );

      expect(errorEvent.code).toBe("validation_failed");
      expect(errorEvent.source).toBe("session");
      expect(errorEvent.message).toContain('Unsupported sub-agent model "gemini-3-pro-preview" for provider openai');

      const persistedConfig = JSON.parse(
        await fs.readFile(path.join(tmpDir, ".agent", "config.json"), "utf-8"),
      ) as any;
      expect(persistedConfig.subAgentModel).toBe("gpt-5.2");
    } finally {
      server.stop();
    }
  });

  test("set_config persists toolOutputOverflowChars null and new sessions inherit it", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const event = await sendAndWaitForEvent(
        url,
        (sessionId) => ({
          type: "set_config",
          sessionId,
          config: {
            toolOutputOverflowChars: null,
          },
        }),
        (message) => message.type === "session_config" && message.config?.toolOutputOverflowChars === null,
      );

      expect(event.config.toolOutputOverflowChars).toBeNull();
      expect(event.config.defaultToolOutputOverflowChars).toBeNull();

      const persistedConfig = JSON.parse(
        await fs.readFile(path.join(tmpDir, ".agent", "config.json"), "utf-8"),
      ) as any;
      expect(persistedConfig.toolOutputOverflowChars).toBeNull();

      const nextMessages = await collectMessages(url, 4);
      const nextConfigEvt = nextMessages.find((msg: any) => msg.type === "session_config");
      expect(nextConfigEvt?.config.toolOutputOverflowChars).toBeNull();
      expect(nextConfigEvt?.config.defaultToolOutputOverflowChars).toBeNull();
    } finally {
      server.stop();
    }
  });

  test("set_config can clear toolOutputOverflowChars and restore inherited defaults", async () => {
    const tmpDir = await makeTmpProject();
    const homeDir = path.join(tmpDir, "home");
    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, ".agent", "config.json"),
      `${JSON.stringify({ toolOutputOverflowChars: 12000 }, null, 2)}\n`,
      "utf-8",
    );
    const { server, url } = await startAgentServer(serverOpts(tmpDir, { homedir: homeDir }));
    try {
      const event = await sendAndWaitForEvent(
        url,
        (sessionId) => ({
          type: "set_config",
          sessionId,
          config: {
            clearToolOutputOverflowChars: true,
          },
        }),
        (message) =>
          message.type === "session_config"
          && message.config?.toolOutputOverflowChars === 25000
          && message.config?.defaultToolOutputOverflowChars === undefined,
        10_000,
      );

      expect(event.config.toolOutputOverflowChars).toBe(25000);
      expect("defaultToolOutputOverflowChars" in event.config).toBe(false);

      const persistedConfig = JSON.parse(
        await fs.readFile(path.join(tmpDir, ".agent", "config.json"), "utf-8"),
      ) as any;
      expect("toolOutputOverflowChars" in persistedConfig).toBe(false);

      const nextMessages = await collectMessages(url, 4);
      const nextConfigEvt = nextMessages.find((msg: any) => msg.type === "session_config");
      expect(nextConfigEvt?.config.toolOutputOverflowChars).toBe(25000);
      expect("defaultToolOutputOverflowChars" in (nextConfigEvt?.config ?? {})).toBe(false);
    } finally {
      server.stop();
    }
  }, 15_000);
});
