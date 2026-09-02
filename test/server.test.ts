import { Database } from "bun:sqlite";
import { describe, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAiCoworkerPaths } from "../src/connect";
import { DEFAULT_PROVIDER_OPTIONS } from "../src/providers";
import { resolveListeningHintsFromInterfaces } from "../src/server/index";
import { ASK_SKIP_TOKEN } from "../src/server/protocol";
import * as serverRuntime from "../src/server/runtime/ServerRuntime";
import type { AgentSession } from "../src/server/session/AgentSession";
import { SessionDb } from "../src/server/sessionDb";
import { refreshSessionsForSkillMutation } from "../src/server/skillMutationRefresh";
import { type StartAgentServerOptions, startAgentServer } from "../src/server/startServer";
import {
  loadH3PairingStoreState,
  rememberH3TrustedDevice,
} from "../src/server/transport/h3/pairing";
import * as h3Server from "../src/server/transport/h3/server";
import { getOneOffChatsRoot } from "../src/utils/oneOffChats";
import { stopTestServer } from "./helpers/wsHarness";
import { connectJsonRpc } from "./jsonrpc/flow.harness";

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
  // Ensure the .cowork dir exists so loadConfig can resolve it.
  await fs.mkdir(path.join(tmp, ".cowork"), { recursive: true });
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

async function reservePort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("OK") });
  const port = server.port;
  await Promise.resolve(server.stop(true));
  return port;
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

function mockServerLifecycle(stop = mock(async () => {})) {
  const nativeStop = mock(async (_closeActiveConnections?: boolean) => {});
  const runtime = {
    config: {},
    env: {},
    system: "",
    stop,
    isAddrInUse: (error: unknown) =>
      Boolean(error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE"),
    startIdleEviction: () => {
      const timer = setInterval(() => {}, 60_000);
      timer.unref();
      return timer;
    },
    waitForStartupReady: async () => {},
  } as serverRuntime.AgentServerRuntime;
  const createRuntime = spyOn(serverRuntime, "createAgentServerRuntime").mockResolvedValue(runtime);
  const serve = spyOn(Bun, "serve").mockReturnValue({ port: 7337, stop: nativeStop } as never);
  return {
    stop,
    nativeStop,
    serve,
    createRuntime,
    restore() {
      serve.mockRestore();
      createRuntime.mockRestore();
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Server Startup", () => {
  test.each(["explicit", "environment"] as const)(
    "shares the %s home with the runtime, web desktop, and mobile listener",
    async (homeSource) => {
      const project = await makeTmpProject();
      const overrideHome = path.join(project, "override-home");
      const explicitHome = path.join(project, "explicit-home");
      const expectedHome = homeSource === "explicit" ? explicitHome : overrideHome;
      const lifecycle = mockServerLifecycle();
      const startMobile = spyOn(h3Server, "startH3MobileServer").mockResolvedValue({
        stop: mock(async () => {}),
      } as never);
      let started: Awaited<ReturnType<typeof startAgentServer>> | undefined;
      try {
        started = await startAgentServer(
          serverOpts(project, {
            homedir: homeSource === "explicit" ? explicitHome : undefined,
            mobileH3: { port: 0 },
            env: {
              COWORK_HOME_OVERRIDE: overrideHome,
              HOME: path.join(project, "other-home"),
              COWORK_WEB_DESKTOP_SERVICE: "1",
              COWORK_DESKTOP_USER_DATA_DIR: path.join(project, "desktop-data"),
            },
          }),
        );

        const runtimeOptions = lifecycle.createRuntime.mock.calls[0]?.[0];
        expect(runtimeOptions?.homedir).toBe(expectedHome);
        expect(await runtimeOptions?.desktopService?.getWorkspaceRoots(project)).toContain(
          getOneOffChatsRoot(expectedHome),
        );
        expect(startMobile).toHaveBeenCalledWith(
          expect.objectContaining({ storeRootPath: expectedHome }),
        );
      } finally {
        await started?.server.stop(true);
        startMobile.mockRestore();
        lifecycle.restore();
        await fs.rm(project, { recursive: true, force: true });
      }
    },
  );

  test("releases the runtime when the primary listener cannot bind", async () => {
    const lifecycle = mockServerLifecycle();
    const failure = Object.assign(new Error("Primary port is occupied"), { code: "EADDRINUSE" });
    lifecycle.serve.mockImplementation(() => {
      throw failure;
    });
    try {
      await expect(startAgentServer(serverOpts("/test/project", { port: 7337 }))).rejects.toBe(
        failure,
      );
      expect(lifecycle.stop).toHaveBeenCalledTimes(1);
    } finally {
      lifecycle.restore();
    }
  });

  test("closes the listener even if runtime cleanup fails and retains the failure for later callers", async () => {
    const failure = new Error("Runtime cleanup failed");
    const lifecycle = mockServerLifecycle(
      mock(async () => {
        throw failure;
      }),
    );
    try {
      const { server } = await startAgentServer(serverOpts("/test/project"));
      await expect(server.stop(true)).rejects.toBe(failure);
      expect(lifecycle.nativeStop).toHaveBeenCalledWith(true);
      await expect(server.stop(true)).rejects.toBe(failure);
      expect(lifecycle.stop).toHaveBeenCalledTimes(1);
      expect(lifecycle.nativeStop).toHaveBeenCalledTimes(1);
    } finally {
      lifecycle.restore();
    }
  });

  test("concurrent stop callers wait for the same cleanup to finish", async () => {
    const cleanup = Promise.withResolvers<void>();
    const lifecycle = mockServerLifecycle(mock(async () => await cleanup.promise));
    let firstStop: Promise<void> | undefined;
    try {
      const { server } = await startAgentServer(serverOpts("/test/project"));
      firstStop = server.stop(true);
      let secondFinished = false;
      const secondStop = server.stop(true).then(() => {
        secondFinished = true;
      });
      await Promise.resolve();
      expect(secondFinished).toBe(false);

      cleanup.resolve();
      await Promise.all([firstStop, secondStop]);
      expect(lifecycle.stop).toHaveBeenCalledTimes(1);
      expect(lifecycle.nativeStop).toHaveBeenCalledTimes(1);
    } finally {
      cleanup.resolve();
      await firstStop;
      lifecycle.restore();
    }
  });

  test("shutdown closes subscribed sockets and persists cancelled turns before closing the database", async () => {
    const project = await makeTmpProject();
    const turnStarted = Promise.withResolvers<void>();
    const cancellationStarted = Promise.withResolvers<void>();
    const settlement = Promise.withResolvers<void>();
    const { server, url } = await startAgentServer(
      serverOpts(project, {
        runTurnImpl: async (params) => {
          turnStarted.resolve();
          try {
            return await waitForAbort(params.abortSignal!, () => cancellationStarted.resolve());
          } finally {
            await settlement.promise;
          }
        },
      }),
    );
    const closeDatabase = spyOn(SessionDb.prototype, "close");
    let rpc: Awaited<ReturnType<typeof connectJsonRpc>> | undefined;
    let stop: Promise<void> | undefined;
    try {
      rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: project });
      const threadId = started.result.thread.id;
      const turn = await rpc.sendRequest("turn/start", {
        threadId,
        input: "Keep this turn active until shutdown.",
      });
      await turnStarted.promise;
      const socketClosed = new Promise<void>((resolve) => {
        rpc!.ws.addEventListener("close", () => resolve(), { once: true });
      });
      let stopFinished = false;
      stop = server.stop(true).then(() => {
        stopFinished = true;
      });
      await cancellationStarted.promise;
      expect(stopFinished).toBe(false);
      expect(closeDatabase).not.toHaveBeenCalled();

      settlement.resolve();
      await Promise.all([stop, socketClosed]);
      expect(closeDatabase).toHaveBeenCalledTimes(1);
      expect(rpc.ws.readyState).toBe(WebSocket.CLOSED);
      closeDatabase.mockRestore();

      const persisted = await SessionDb.create({ paths: getAiCoworkerPaths({ homedir: project }) });
      try {
        expect(persisted.getSessionSnapshot(threadId)?.feed).toContainEqual(
          expect.objectContaining({
            kind: "message",
            role: "user",
            text: "Keep this turn active until shutdown.",
          }),
        );
        expect(persisted.listThreadJournalEvents(threadId)).toContainEqual(
          expect.objectContaining({
            eventType: "turn/completed",
            turnId: turn.result.turn.id,
            payload: expect.objectContaining({
              turn: { id: turn.result.turn.id, status: "interrupted" },
            }),
          }),
        );
      } finally {
        persisted.close();
      }
    } finally {
      settlement.resolve();
      await (stop ?? server.stop(true));
      closeDatabase.mockRestore();
      rpc?.close();
      await fs.rm(project, { recursive: true, force: true });
    }
  });

  test("mobile H3 host hints prefer stable LAN addresses over link-local interfaces", () => {
    const hints = resolveListeningHintsFromInterfaces("0.0.0.0", {
      en5: [
        {
          address: "fe80::1847:4ad5:9c84:fc93",
          family: "IPv6",
          internal: false,
          netmask: "ffff:ffff:ffff:ffff::",
          mac: "36:45:a2:7f:6d:4c",
          cidr: "fe80::1847:4ad5:9c84:fc93/64",
          scopeid: 20,
        },
        {
          address: "169.254.96.244",
          family: "IPv4",
          internal: false,
          netmask: "255.255.0.0",
          mac: "36:45:a2:7f:6d:4c",
          cidr: "169.254.96.244/16",
        },
      ],
      en0: [
        {
          address: "192.168.6.69",
          family: "IPv4",
          internal: false,
          netmask: "255.255.252.0",
          mac: "1c:1d:d3:df:eb:0f",
          cidr: "192.168.6.69/22",
        },
      ],
    });

    expect(hints).toEqual(["192.168.6.69", "169.254.96.244", "127.0.0.1"]);
  });

  test("startAgentServer returns server, config, system, and url", async () => {
    const tmpDir = await makeTmpProject();
    const started = await startAgentServer(serverOpts(tmpDir));
    const { server, config, url } = started;
    try {
      await started.ready;
      expect(server).toBeDefined();
      expect(typeof server.port).toBe("number");
      expect(server.port).toBeGreaterThan(0);
      expect(config).toBeDefined();
      expect(typeof config.provider).toBe("string");
      expect(typeof started.system).toBe("string");
      expect(started.system.length).toBeGreaterThan(0);
      expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/ws$/);
    } finally {
      await stopTestServer(server);
    }
  });

  test("serves explicit cowork health endpoint with diagnostics payload", async () => {
    const tmpDir = await makeTmpProject();
    const { server, ready } = await startAgentServer(serverOpts(tmpDir));
    try {
      await ready;
      const response = await fetch(`http://127.0.0.1:${server.port}/cowork/health`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        ok: boolean;
        version: string;
        uptimeMs: number;
        cwd: string;
        activeSessions: number;
        db: { ok: boolean; lockWaitMs?: number };
        journal: { healthy: boolean; backlog: number };
        sendQueue: { dropped: number; queued: number };
        startup: { ready: boolean };
      };
      // Liveness stays true; subsystem detail rides in the body booleans.
      expect(body.ok).toBe(true);
      expect(typeof body.version).toBe("string");
      expect(body.version.length).toBeGreaterThan(0);
      expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
      expect(body.cwd).toBe(tmpDir);
      expect(body.activeSessions).toBe(0);
      expect(body.db.ok).toBe(true);
      // lockWaitMs is optional (present only once the write lock has recorded a
      // wait); when present it must be a non-negative number.
      if (body.db.lockWaitMs !== undefined) {
        expect(body.db.lockWaitMs).toBeGreaterThanOrEqual(0);
      }
      expect(body.journal).toEqual({ healthy: true, backlog: 0 });
      expect(body.sendQueue).toEqual({ dropped: 0, queued: 0 });
      expect(body.startup).toEqual({ ready: true });
    } finally {
      await stopTestServer(server);
    }
  });

  test("serves health while background startup readiness is still pending", async () => {
    const tmpDir = await makeTmpProject();
    let releaseRuntimeSetup: () => void = () => undefined;
    const runtimeSetupGate = new Promise<void>((resolve) => {
      releaseRuntimeSetup = resolve;
    });
    const started = await startAgentServer(
      serverOpts(tmpDir, {
        preloadSystemPrompt: false,
        ensureCoworkRuntimeReadyImpl: async () => {
          await runtimeSetupGate;
          return null;
        },
        ensureDefaultGlobalSkillsReadyImpl: async () => null,
      }),
    );
    try {
      let readySettled = false;
      void started.ready.then(() => {
        readySettled = true;
      });

      const pendingResponse = await fetch(`http://127.0.0.1:${started.server.port}/cowork/health`);
      const pendingBody = (await pendingResponse.json()) as { startup: { ready: boolean } };
      expect(pendingBody.startup).toEqual({ ready: false });
      expect(readySettled).toBe(false);

      releaseRuntimeSetup();
      await started.ready;

      const readyResponse = await fetch(`http://127.0.0.1:${started.server.port}/cowork/health`);
      const readyBody = (await readyResponse.json()) as { startup: { ready: boolean } };
      expect(readyBody.startup).toEqual({ ready: true });
    } finally {
      await stopTestServer(started.server);
    }
  });

  test("creates projectCoworkDir on startup", async () => {
    const tmpDir = await makeTmpProject();
    // Remove the .cowork dir so startServer has to create it.
    await fs.rm(path.join(tmpDir, ".cowork"), { recursive: true, force: true });
    const { server, config } = await startAgentServer(serverOpts(tmpDir));
    try {
      const stat = await fs.stat(config.projectCoworkDir);
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
    // The bundled memories skill is feature-gated; enable advanced memory so it
    // surfaces in the prompt and proves the built-in fallback tier loads.
    const started = await startAgentServer(
      serverOpts(tmpDir, {
        env: {
          AGENT_WORKING_DIR: tmpDir,
          AGENT_PROVIDER: "google",
          COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP: "1",
          AGENT_ADVANCED_MEMORY: "1",
        },
      }),
    );
    const { server, config } = started;
    try {
      await started.ready;
      expect(config.skillsDirs).toHaveLength(3);
      expect(config.skillsDirs[0]).toBe(path.join(tmpDir, ".cowork", "skills"));
      expect(config.skillsDirs[2]).toBe(path.join(config.builtInDir, "skills"));
      expect(started.system).toContain("## Available Skills");
      expect(started.system).toContain("**memories**");
      expect(started.system).not.toContain("**presentations**");
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
      expect(config.skillsDirs).toHaveLength(2);
      expect(config.skillsDirs).not.toContain(path.join(config.builtInDir, "skills"));
    } finally {
      await stopTestServer(server);
    }
  });

  test("loads system prompt as a non-empty string", async () => {
    const tmpDir = await makeTmpProject();
    const started = await startAgentServer(serverOpts(tmpDir));
    try {
      await started.ready;
      expect(typeof started.system).toBe("string");
      expect(started.system.length).toBeGreaterThan(10);
    } finally {
      await stopTestServer(started.server);
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
    const runtimeFor = (session: AgentSession) =>
      ({
        id: session.id,
        read: {
          workingDirectory: session.getWorkingDirectory(),
        },
        skills: {
          refreshSystemPrompt: async (reason: string) => {
            await session.refreshSystemPromptWithSkills(reason);
          },
          refreshFromExternalMutation: async (reason: string) => {
            await session.refreshSkillStateFromExternalMutation(reason);
          },
        },
      }) as any;
    const sourceSession = makeSession("source", "/tmp/workspace-a");
    const workspacePeer = makeSession("workspace-peer", "/tmp/workspace-a");
    const controlPeer = makeSession("control-peer", "/tmp/workspace-a");
    const otherWorkspace = makeSession("other-workspace", "/tmp/workspace-b");

    const bindingFor = (session: AgentSession) => ({
      session,
      runtime: runtimeFor(session),
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

  test("/ws rejects retired query parameter protocol negotiation", async () => {
    const tmpDir = await makeTmpProject();
    const { server } = await startAgentServer(serverOpts(tmpDir));
    try {
      const httpUrl = `http://127.0.0.1:${server.port}/ws?protocol=jsonrpc`;
      const res = await fetch(httpUrl);
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toBe(
        "The ?protocol= WebSocket query parameter is no longer supported. Use the cowork.jsonrpc.v1 subprotocol or omit protocol negotiation.",
      );
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

  test("exposes file preview metadata to authenticated cross-origin desktop clients", async () => {
    const tmpDir = await makeTmpProject();
    const filePath = path.join(tmpDir, "preview.txt");
    await fs.writeFile(filePath, "preview contents", "utf8");
    const token = "preview-test-browser-token";
    const { server } = await startAgentServer(
      serverOpts(tmpDir, { env: { COWORK_BROWSER_ACCESS_TOKEN: token } }),
    );
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/cowork/fs/preview?path=${encodeURIComponent(filePath)}`,
        {
          headers: {
            Origin: "http://127.0.0.1:5173",
            "X-Cowork-Browser-Token": token,
          },
        },
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("preview contents");
      const exposedHeaders = (response.headers.get("access-control-expose-headers") ?? "")
        .split(",")
        .map((header) => header.trim().toLowerCase());
      for (const header of [
        "x-cowork-file-path",
        "x-cowork-byte-length",
        "x-cowork-truncated",
        "x-cowork-file-modified-at",
        "x-cowork-file-change-time",
        "x-cowork-file-size",
        "x-cowork-file-fingerprint",
      ]) {
        expect(response.headers.get(header)).not.toBeNull();
        expect(exposedHeaders).toContain(header);
      }
      expect(exposedHeaders).not.toContain("*");
    } finally {
      await stopTestServer(server);
    }
  });

  test("rejects local HTTP route requests from non-loopback browser origins", async () => {
    const tmpDir = await makeTmpProject();
    const targetPath = path.join(tmpDir, "csrf-target.txt");
    await fs.writeFile(targetPath, "keep me", "utf-8");
    const { server } = await startAgentServer(serverOpts(tmpDir));
    try {
      const httpUrl = `http://127.0.0.1:${server.port}/cowork/fs/trash`;
      const res = await fetch(httpUrl, {
        method: "POST",
        headers: {
          Origin: "https://evil.example",
          "Content-Type": "text/plain;charset=UTF-8",
        },
        body: JSON.stringify({ path: targetPath }),
      });
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("Forbidden origin");
      expect(await fs.readFile(targetPath, "utf-8")).toBe("keep me");
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

  test("mobile H3 trusted-device DELETE requires admin token and revokes encoded device id", async () => {
    const tmpDir = await makeTmpProject();
    const { server, mobileServer } = await startAgentServer(
      serverOpts(tmpDir, {
        mobileH3: {
          hostname: "127.0.0.1",
          port: 0,
        },
      }),
    );
    try {
      if (!mobileServer) {
        throw new Error("Expected mobile H3 server to start for admin route test");
      }
      const deviceId = "phone 1/alpha";
      await rememberH3TrustedDevice(tmpDir, {
        deviceId,
        identityPub: "phone-identity",
        displayName: "Phone",
        sessionToken: "session-token",
      });
      const httpUrl = `http://127.0.0.1:${server.port}/mobile-h3/trusted/${encodeURIComponent(deviceId)}`;

      const unauthorized = await fetch(httpUrl, { method: "DELETE" });
      expect(unauthorized.status).toBe(401);
      await expect(unauthorized.json()).resolves.toEqual({ error: "Unauthorized." });
      await expect(loadH3PairingStoreState(tmpDir)).resolves.toMatchObject({
        trustedDevices: [expect.objectContaining({ deviceId })],
      });

      const listResponse = await fetch(`http://127.0.0.1:${server.port}/mobile-h3/trusted`, {
        headers: {
          Authorization: `Bearer ${mobileServer.adminToken}`,
        },
      });
      expect(listResponse.status).toBe(200);
      await expect(listResponse.json()).resolves.toMatchObject({
        trustedDevices: [
          {
            deviceId,
            permissions: {
              turns: false,
              serverRequests: false,
              providerAuth: false,
              mcpAuth: false,
              workspaceSettings: false,
              backups: false,
            },
          },
        ],
      });

      const permissionsResponse = await fetch(`${httpUrl}/permissions`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${mobileServer.adminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          permissions: {
            turns: true,
            backups: true,
            unknownPermission: true,
          },
        }),
      });
      expect(permissionsResponse.status).toBe(200);
      await expect(permissionsResponse.json()).resolves.toMatchObject({
        trustedDevice: {
          deviceId,
          permissions: {
            turns: true,
            backups: true,
            providerAuth: false,
          },
        },
      });
      await expect(loadH3PairingStoreState(tmpDir)).resolves.toMatchObject({
        trustedDevices: [
          expect.objectContaining({
            deviceId,
            permissions: expect.objectContaining({ turns: true, backups: true }),
          }),
        ],
      });

      const authorized = await fetch(httpUrl, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${mobileServer.adminToken}`,
        },
      });
      expect(authorized.status).toBe(200);
      await expect(authorized.json()).resolves.toEqual({ ok: true, removed: true });
      await expect(loadH3PairingStoreState(tmpDir)).resolves.toEqual({
        version: 1,
        trustedDevices: [],
      });
    } finally {
      await stopTestServer(server);
    }
  });

  test("falls back to an alternate H3 port when the requested mobile port is occupied", async () => {
    const tmpDir = await makeTmpProject();
    const mainPort = await reservePort();
    const occupiedMobileServer = Bun.serve({
      hostname: "0.0.0.0",
      port: 0,
      fetch: () => new Response("occupied"),
    });

    try {
      const started = await startAgentServer(
        serverOpts(tmpDir, {
          port: mainPort,
          mobileH3: {
            hostname: "0.0.0.0",
            port: occupiedMobileServer.port,
          },
        }),
      );

      expect(started.mobileServer?.port).toBeDefined();
      expect(started.mobileServer?.port).not.toBe(occupiedMobileServer.port);
      await stopTestServer(started.server);
    } finally {
      await Promise.resolve(occupiedMobileServer.stop(true));
    }
  });
});

// NOTE: Historical raw event WebSocket tests were removed when JSON-RPC became
// the only wire protocol. See test/jsonrpc/flow.*.test.ts and
// test/jsonrpc/control.*.test.ts for protocol coverage.
