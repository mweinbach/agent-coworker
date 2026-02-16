import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startAgentServer, type StartAgentServerOptions } from "../src/server/startServer";
import { CLIENT_MESSAGE_TYPES, SERVER_EVENT_TYPES, WEBSOCKET_PROTOCOL_VERSION } from "../src/server/protocol";

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
        msg.type === "observability_status" ||
        msg.type === "provider_catalog" ||
        msg.type === "provider_auth_methods" ||
        msg.type === "provider_status"
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

  test("creates outputDirectory on startup", async () => {
    const tmpDir = await makeTmpProject();
    const { server, config } = await startAgentServer(serverOpts(tmpDir));
    try {
      const stat = await fs.stat(config.outputDirectory);
      expect(stat.isDirectory()).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("creates uploadsDirectory on startup", async () => {
    const tmpDir = await makeTmpProject();
    const { server, config } = await startAgentServer(serverOpts(tmpDir));
    try {
      const stat = await fs.stat(config.uploadsDirectory);
      expect(stat.isDirectory()).toBe(true);
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
      serverOpts(tmpDir, { env: { AGENT_WORKING_DIR: tmpDir, AGENT_PROVIDER: "anthropic" } })
    );
    try {
      expect(config.provider).toBe("anthropic");
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

  test("server_hello contains config with provider, model, workingDirectory, outputDirectory", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const messages = await collectMessages(url, 1);
      const hello = messages[0];
      expect(hello.config).toBeDefined();
      expect(typeof hello.config.provider).toBe("string");
      expect(typeof hello.config.model).toBe("string");
      expect(typeof hello.config.workingDirectory).toBe("string");
      expect(typeof hello.config.outputDirectory).toBe("string");
    } finally {
      server.stop();
    }
  });

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
      const messages = await collectMessages(url, 3);
      const status = messages.find((msg: any) => msg.type === "observability_status");
      expect(status).toBeDefined();
      expect(typeof status.enabled).toBe("boolean");
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
          if (
            msg.type === "session_settings" ||
            msg.type === "observability_status" ||
            msg.type === "provider_catalog" ||
            msg.type === "provider_auth_methods" ||
            msg.type === "provider_status"
          ) return;
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
        1,
        2000
      );
      // reset emits a "todos" event with empty array
      expect(hello.type).toBe("server_hello");
      expect(responses[0].type).toBe("todos");
      expect(responses[0].todos).toEqual([]);
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

  test("observability_query returns result envelope", async () => {
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
      expect(responses[0].type).toBe("observability_query_result");
      expect(responses[0].result.status).toBe("error");
    } finally {
      server.stop();
    }
  });

  test("observability_query surfaces thrown failures as result envelopes", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        env: {
          AGENT_WORKING_DIR: tmpDir,
          AGENT_PROVIDER: "google",
          AGENT_OBSERVABILITY_ENABLED: "true",
          AGENT_OBS_METRICS_URL: "not-a-valid-url",
        },
      })
    );
    try {
      const { responses } = await sendAndCollect(
        url,
        (sessionId) => ({
          type: "observability_query",
          sessionId,
          query: { queryType: "promql", query: "up", fromMs: 1000, toMs: 2000 },
        }),
        1
      );
      expect(responses[0].type).toBe("observability_query_result");
      expect(responses[0].result.status).toBe("error");
      expect(responses[0].result.fromMs).toBe(1000);
      expect(responses[0].result.toMs).toBe(2000);
      expect(String(responses[0].result.error)).toContain("Failed to run observability query");
    } finally {
      server.stop();
    }
  });

  test("harness_slo_evaluate surfaces thrown failures as result envelopes", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        env: {
          AGENT_WORKING_DIR: tmpDir,
          AGENT_PROVIDER: "google",
          AGENT_OBSERVABILITY_ENABLED: "true",
          AGENT_OBS_METRICS_URL: "not-a-valid-url",
        },
      })
    );
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
      expect(responses[0].type).toBe("harness_slo_result");
      expect(responses[0].result.passed).toBe(false);
      expect(responses[0].result.checks).toHaveLength(1);
      expect(responses[0].result.checks[0].pass).toBe(false);
      expect(String(responses[0].result.checks[0].reason)).toContain("Failed to evaluate SLO checks");
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
          if (
            msg.type === "session_settings" ||
            msg.type === "observability_status" ||
            msg.type === "provider_catalog" ||
            msg.type === "provider_auth_methods" ||
            msg.type === "provider_status"
          ) return;
          clearTimeout(timer);
          ws.close();
          resolve(msg);
        };
      });

      expect(result.type).toBe("error");
      expect(result.message).toContain("Expected object");
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
          if (
            msg.type === "session_settings" ||
            msg.type === "observability_status" ||
            msg.type === "provider_catalog" ||
            msg.type === "provider_auth_methods" ||
            msg.type === "provider_status"
          ) return;
          clearTimeout(timer);
          ws.close();
          resolve(msg);
        };
      });

      expect(result.type).toBe("error");
      expect(result.message).toContain("Expected object");
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
          if (
            msg.type === "session_settings" ||
            msg.type === "observability_status" ||
            msg.type === "provider_catalog" ||
            msg.type === "provider_auth_methods" ||
            msg.type === "provider_status"
          ) return;
          clearTimeout(timer);
          ws.close();
          resolve(msg);
        };
      });

      expect(result.type).toBe("error");
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
    } finally {
      server.stop();
    }
  });
});
