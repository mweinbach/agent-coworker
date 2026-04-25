import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAiCoworkerPaths } from "../src/connect";
import { DEFAULT_PROVIDER_OPTIONS } from "../src/providers";
import { ASK_SKIP_TOKEN } from "../src/server/protocol";
import type { AgentSession } from "../src/server/session/AgentSession";
import { SessionDb } from "../src/server/sessionDb";
import { refreshSessionsForSkillMutation } from "../src/server/skillMutationRefresh";
import { type StartAgentServerOptions, startAgentServer } from "../src/server/startServer";
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
function serverOpts(
  tmpDir: string,
  overrides?: Partial<StartAgentServerOptions>,
): StartAgentServerOptions {
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
      serverOpts(tmpDir, { hostname: "127.0.0.1", port: 0 }),
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
      }),
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
    const { server, config } = await startAgentServer(
      serverOpts(tmpDir, {
        env: {
          AGENT_WORKING_DIR: tmpDir,
          AGENT_PROVIDER: "google",
          COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP: "1",
          COWORK_DISABLE_BUILTIN_SKILLS: "1",
        },
      }),
    );
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

  test("shared skill refresh includes workspace control sessions and preserves source-session behavior", async () => {
    const calls: string[] = [];
    const makeSession = (id: string, cwd: string) =>
      ({
        id,
        getWorkingDirectory: () => cwd,
        refreshSystemPromptWithSkills: async (reason: string) => {
          calls.push(`${id}:system:${reason}`);
        },
        refreshSkillStateFromExternalMutation: async (reason: string) => {
          calls.push(`${id}:external:${reason}`);
        },
      }) as unknown as AgentSession;
    const sourceSession = makeSession("source", "/tmp/workspace-a");
    const workspacePeer = makeSession("workspace-peer", "/tmp/workspace-a");
    const controlPeer = makeSession("control-peer", "/tmp/workspace-a");
    const otherWorkspace = makeSession("other-workspace", "/tmp/workspace-b");

    const bindingFor = (session: AgentSession) => ({
      session,
      socket: null,
      sinks: new Map(),
    });

    await refreshSessionsForSkillMutation({
      sessionBindings: [
        bindingFor(sourceSession),
        bindingFor(workspacePeer),
        bindingFor(otherWorkspace),
      ],
      workspaceControlBindings: [bindingFor(controlPeer)],
      workingDirectory: "/tmp/workspace-a",
      sourceSessionId: "source",
    });

    expect(calls.sort()).toEqual([
      "control-peer:external:skills.workspace_refresh",
      "source:system:skills.workspace_refresh",
      "workspace-peer:external:skills.workspace_refresh",
    ]);
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

  test("loopback CORS preflight advertises DELETE for transcript routes", async () => {
    const tmpDir = await makeTmpProject();
    const { server } = await startAgentServer(serverOpts(tmpDir));
    try {
      const httpUrl = `http://127.0.0.1:${server.port}/cowork/desktop/transcript?threadId=thread-1`;
      const res = await fetch(httpUrl, {
        method: "OPTIONS",
        headers: {
          Origin: "http://127.0.0.1:5173",
          "Access-Control-Request-Method": "DELETE",
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
      expect(res.headers.get("access-control-allow-methods")).toContain("DELETE");
    } finally {
      await stopTestServer(server);
    }
  });

  test("web desktop service enablement follows merged opts.env", async () => {
    const tmpDir = await makeTmpProject();
    const previous = process.env.COWORK_WEB_DESKTOP_SERVICE;
    delete process.env.COWORK_WEB_DESKTOP_SERVICE;
    const { server } = await startAgentServer(
      serverOpts(tmpDir, {
        env: {
          AGENT_WORKING_DIR: tmpDir,
          AGENT_PROVIDER: "google",
          AGENT_OBSERVABILITY_ENABLED: "false",
          COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP: "1",
          COWORK_WEB_DESKTOP_SERVICE: "1",
        },
      }),
    );
    try {
      const httpUrl = `http://127.0.0.1:${server.port}/cowork/desktop/state`;
      const res = await fetch(httpUrl);
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload).toHaveProperty("workspaces");
    } finally {
      if (previous === undefined) {
        delete process.env.COWORK_WEB_DESKTOP_SERVICE;
      } else {
        process.env.COWORK_WEB_DESKTOP_SERVICE = previous;
      }
      await stopTestServer(server);
    }
  });
});

// NOTE: Historical raw event WebSocket tests were removed when JSON-RPC became
// the only wire protocol. See test/server.jsonrpc.test.ts and
// test/server.jsonrpc.flow.test.ts for protocol coverage.
