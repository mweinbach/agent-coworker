import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startAgentServer, type StartAgentServerOptions } from "../src/server/startServer";
import { getAiCoworkerPaths } from "../src/connect";
import { SessionDb } from "../src/server/sessionDb";
import {
  ASK_SKIP_TOKEN,
} from "../src/server/protocol";
import { DEFAULT_PROVIDER_OPTIONS } from "../src/providers";
import { stopTestServer } from "./helpers/wsHarness";

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

function fixturePath(name: string): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", name);
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
  const baseEnv = {
    AGENT_WORKING_DIR: tmpDir,
    AGENT_PROVIDER: "google",
    AGENT_OBSERVABILITY_ENABLED: "false",
    COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP: "1",
  };

  return {
    cwd: tmpDir,
    hostname: "127.0.0.1",
    port: 0,
    homedir: tmpDir,
    ...overrides,
    env: {
      ...baseEnv,
      ...(overrides?.env ?? {}),
    },
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
  timeoutMs = 5000,
  options?: { includeEventTypes?: string[] },
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
      const explicitlyIncluded = options?.includeEventTypes?.includes(msg.type) ?? false;

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
        !explicitlyIncluded &&
        (
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
          msg.type === "model_stream_chunk" ||
          msg.type === "session_backup_state"
        )
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

function sendToExistingSessionAndWaitForEvent(
  url: string,
  resumeSessionId: string,
  buildMsg: (sessionId: string) => object,
  match: (message: any) => boolean,
  timeoutMs = 5000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    let sent = false;
    const ws = new WebSocket(`${url}?resumeSessionId=${resumeSessionId}`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Timed out waiting for matching event"));
    }, timeoutMs);

    ws.onmessage = (e) => {
      const msg = JSON.parse(typeof e.data === "string" ? e.data : "");
      if (!sent && msg.type === "server_hello" && msg.sessionId === resumeSessionId) {
        sent = true;
        ws.send(JSON.stringify(buildMsg(resumeSessionId)));
        return;
      }
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

function connectAndWaitForEvent(
  url: string,
  match: (message: any) => boolean,
  timeoutMs = 5000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Timed out waiting for matching event"));
    }, timeoutMs);

    ws.onmessage = (e) => {
      const msg = JSON.parse(typeof e.data === "string" ? e.data : "");
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

function createPersistentAgent(
  url: string,
  message = "child agent task",
  role: "default" | "worker" | "research" | "explorer" = "worker",
  timeoutMs = 5000,
): Promise<{ parentSessionId: string; agent: any }> {
  return new Promise((resolve, reject) => {
    let parentSessionId = "";
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Timed out waiting for agent_spawned"));
    }, timeoutMs);

    ws.onmessage = (e) => {
      const msg = JSON.parse(typeof e.data === "string" ? e.data : "");
      if (!parentSessionId && msg.type === "server_hello") {
        parentSessionId = msg.sessionId;
        ws.send(JSON.stringify({ type: "agent_spawn", sessionId: parentSessionId, role, message }));
        return;
      }

      if (msg.type !== "agent_spawned" || msg.sessionId !== parentSessionId) return;
      clearTimeout(timer);
      ws.close();
      resolve({ parentSessionId, agent: msg.agent });
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

function createSessionWithAssistantTurn(
  url: string,
  text = "hello",
  timeoutMs = 5000,
): Promise<{ sessionId: string; assistantText: string }> {
  return new Promise((resolve, reject) => {
    let sessionId = "";
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Timed out waiting for assistant_message"));
    }, timeoutMs);

    ws.onmessage = (e) => {
      const msg = JSON.parse(typeof e.data === "string" ? e.data : "");
      if (!sessionId && msg.type === "server_hello") {
        sessionId = msg.sessionId;
        ws.send(JSON.stringify({ type: "user_message", sessionId, text }));
        return;
      }
      if (msg.type !== "assistant_message" || msg.sessionId !== sessionId) return;
      clearTimeout(timer);
      ws.close();
      resolve({ sessionId, assistantText: msg.text });
    };

    ws.onerror = (e) => {
      clearTimeout(timer);
      ws.close();
      reject(new Error(`WebSocket error: ${e}`));
    };
  });
}

function makeAbortError(): Error & { name: string } {
  return Object.assign(new Error("Aborted"), { name: "AbortError" });
}

async function waitForAbort(signal: AbortSignal, onAbort?: () => void): Promise<never> {
  if (signal.aborted) {
    onAbort?.();
    throw makeAbortError();
  }

  await new Promise((_, reject) => {
    signal.addEventListener(
      "abort",
      () => {
        onAbort?.();
        reject(makeAbortError());
      },
      { once: true },
    );
  });

  throw makeAbortError();
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
      await stopTestServer(server);
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
      await stopTestServer(server);
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
      await stopTestServer(server);
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
      await stopTestServer(server);
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
      await stopTestServer(server);
    }
  });

  test("shared startup keeps built-in skills as the final runtime fallback", async () => {
    const tmpDir = await makeTmpProject();
    const { server, config, system } = await startAgentServer(serverOpts(tmpDir));
    try {
      expect(config.skillsDirs).toHaveLength(4);
      expect(config.skillsDirs[1]).toBe(path.join(tmpDir, ".cowork", "skills"));
      expect(config.skillsDirs[3]).toBe(path.join(config.builtInDir, "skills"));
      expect(system).toContain("## Available Skills");
      expect(system).toContain("**slides**");
    } finally {
      await stopTestServer(server);
    }
  });

  test("shared startup still honors explicit built-in skill opt-out", async () => {
    const tmpDir = await makeTmpProject();
    const { server, config } = await startAgentServer(serverOpts(tmpDir, {
      env: {
        AGENT_WORKING_DIR: tmpDir,
        AGENT_PROVIDER: "google",
        COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP: "1",
        COWORK_DISABLE_BUILTIN_SKILLS: "1",
      },
    }));
    try {
      expect(config.skillsDirs).toHaveLength(3);
      expect(config.skillsDirs).not.toContain(path.join(config.builtInDir, "skills"));
    } finally {
      await stopTestServer(server);
    }
  });

  test("loads system prompt as a non-empty string", async () => {
    const tmpDir = await makeTmpProject();
    const { server, system } = await startAgentServer(serverOpts(tmpDir));
    try {
      expect(typeof system).toBe("string");
      expect(system.length).toBeGreaterThan(10);
    } finally {
      await stopTestServer(server);
    }
  });

  test("config workingDirectory matches cwd", async () => {
    const tmpDir = await makeTmpProject();
    const { server, config } = await startAgentServer(serverOpts(tmpDir));
    try {
      expect(config.workingDirectory).toBe(tmpDir);
    } finally {
      await stopTestServer(server);
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
      await stopTestServer(server);
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
      await stopTestServer(server);
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
      await stopTestServer(server);
    }
  });

});


// NOTE: Legacy "WebSocket Lifecycle", "Message Parsing", and "Server Resilience"
// test sections have been removed. They tested the legacy WebSocket protocol
// (raw ServerEvent/ClientMessage over WebSocket) which has been replaced by
// JSON-RPC. See test/server.jsonrpc.test.ts and test/server.jsonrpc.flow.test.ts
// for JSON-RPC protocol tests.
