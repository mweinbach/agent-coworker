import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

let userDataDir = process.cwd();

mock.module("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" ? userDataDir : process.cwd()),
    getAppPath: () => process.cwd(),
    isPackaged: false,
  },
  BrowserWindow: {
    getAllWindows: () => [],
    fromWebContents: () => null,
    getFocusedWindow: () => null,
  },
  Menu: {
    buildFromTemplate() {
      return {
        popup() {},
      };
    },
  },
}));

const { ServerManager, __internal } = await import("../electron/services/serverManager");

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: (signal?: NodeJS.Signals | number) => boolean;
};

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    child.exitCode = 0;
    queueMicrotask(() => {
      child.emit("exit", 0, null);
    });
    return true;
  };
  return child;
}

describe("desktop server manager startup parsing", () => {
  test("waitForServerListening ignores non-JSON lines and resolves on server_listening", async () => {
    const child = createFakeChild();
    const waitPromise = __internal.waitForServerListening(child as any);

    child.stdout.write("warming up\n");
    child.stdout.write(JSON.stringify({ type: "status", phase: "boot" }) + "\n");
    child.stdout.write(
      JSON.stringify({ type: "server_listening", url: "ws://127.0.0.1:1234/ws", port: 1234, cwd: "C:\\tmp" }) + "\n"
    );

    const payload = await waitPromise;
    expect(payload.url).toBe("ws://127.0.0.1:1234/ws");
    expect(payload.port).toBe(1234);
  });

  test("waitForServerListening includes recent stdout lines when process exits early", async () => {
    const child = createFakeChild();
    const waitPromise = __internal.waitForServerListening(child as any);

    child.stdout.write("warming up\n");
    child.emit("exit", 1, null);

    try {
      await waitPromise;
      throw new Error("expected startup to reject when child exits early");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("Server exited before startup JSON");
      expect(message).toContain("output=warming up");
    }
  });
});

describe("desktop server manager startup mode", () => {
  test("resolveSourceStartup does not resolve repo root when source mode is disabled", () => {
    const startup = __internal.resolveSourceStartup(false, () => {
      throw new Error("resolveRepoRoot should not be called");
    });

    expect(startup).toEqual({
      repoRoot: null,
      sourceEntry: null,
    });
  });

  test("resolveSourceStartup resolves source entry when source mode is enabled", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-repo-"));
    const sourceEntry = path.join(repoRoot, "src", "server", "index.ts");

    try {
      await fs.mkdir(path.dirname(sourceEntry), { recursive: true });
      await fs.writeFile(sourceEntry, 'console.log("ok");\n', "utf-8");

      const startup = __internal.resolveSourceStartup(true, () => repoRoot);
      expect(startup.repoRoot).toBe(repoRoot);
      expect(startup.sourceEntry).toBe(sourceEntry);
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("buildServerEnv mirrors process env without desktop-only skill bootstrap flags", () => {
    const env = __internal.buildServerEnv();
    expect(env).not.toBe(process.env);
    expect(env.COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP).toBe(process.env.COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP ?? "1");
  });

  test("only retries source startup automatically on Windows", () => {
    expect(__internal.getSourceStartupAttemptCount(true)).toBe(process.platform === "win32" ? 2 : 1);
    expect(__internal.getSourceStartupAttemptCount(true, "win32")).toBe(2);
    expect(__internal.getSourceStartupAttemptCount(true, "darwin")).toBe(1);
    expect(__internal.getSourceStartupAttemptCount(false, "win32")).toBe(1);
  });

  test("only injects Bun transpiler cache env for Windows source attempts", () => {
    const windowsAttempt = __internal.buildSourceEnvForAttempt({ PATH: process.env.PATH }, 2, "win32");
    const linuxAttempt = __internal.buildSourceEnvForAttempt({ PATH: process.env.PATH }, 2, "linux");

    try {
      expect(typeof windowsAttempt.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH).toBe("string");
      expect(windowsAttempt.env.BUN_FEATURE_FLAG_DISABLE_ASYNC_TRANSPILER).toBe("1");
      expect(linuxAttempt.env).toEqual({ PATH: process.env.PATH });
    } finally {
      windowsAttempt.cleanup();
      linuxAttempt.cleanup();
    }
  });
});

describe("desktop server manager bun crash detection", () => {
  test("detects bun panic output", () => {
    expect(__internal.isLikelyBunSegfault("panic(main thread): Segmentation fault at address 0x1")).toBe(true);
    expect(__internal.isLikelyBunSegfault("oh no: Bun has crashed.")).toBe(true);
    expect(__internal.isLikelyBunSegfault("normal stderr line")).toBe(false);
  });

  test("writes persistent server-manager diagnostics under userData logs", async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-logs-"));

    try {
      __internal.logServerManagerEvent("workspace=ws_1 start_failed error=boom");
      await __internal.flushServerManagerLogWrites();
      const logPath = __internal.getServerLogPath();
      const contents = await fs.readFile(logPath, "utf8");

      expect(logPath).toBe(path.join(userDataDir, "logs", "server.log"));
      expect(contents).toContain("workspace=ws_1 start_failed error=boom");
    } finally {
      await fs.rm(userDataDir, { recursive: true, force: true });
      userDataDir = process.cwd();
    }
  });

  test("stopWorkspaceServer kills a pending startup before server_listening", async () => {
    const manager = new ServerManager();
    const child = createFakeChild();
    let cleaned = false;

    (manager as any).pendingStarts.set("ws-pending", {
      child,
      cleanup: () => {
        cleaned = true;
      },
    });

    await manager.stopWorkspaceServer("ws-pending");

    expect((manager as any).pendingStarts.has("ws-pending")).toBe(false);
    expect(cleaned).toBe(true);
    expect(child.exitCode).toBe(0);
  });
});
