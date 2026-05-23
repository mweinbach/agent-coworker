import { beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import {
  resolvePackagedSidecarFilename,
  resolveWindowsAiElectronPrebuildTriplet,
} from "../electron/services/sidecar";
import { createElectronMock, setElectronMockOverrides } from "./helpers/mockElectron";

let userDataDir = process.cwd();

const electronMockOverrides = {
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
};

setElectronMockOverrides(electronMockOverrides);

mock.module("electron", () => createElectronMock());

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
  beforeEach(() => {
    setElectronMockOverrides(electronMockOverrides);
  });

  test("waitForServerListening ignores non-JSON lines and resolves on server_listening", async () => {
    const child = createFakeChild();
    const waitPromise = __internal.waitForServerListening(child as any);

    child.stdout.write("warming up\n");
    child.stdout.write(`${JSON.stringify({ type: "status", phase: "boot" })}\n`);
    child.stdout.write(
      `${JSON.stringify({
        type: "server_listening",
        url: "ws://127.0.0.1:1234/ws",
        port: 1234,
        cwd: "C:\\tmp",
      })}\n`,
    );

    const payload = await waitPromise;
    expect(payload.url).toBe("ws://127.0.0.1:1234/ws");
    expect(payload.port).toBe(1234);
  });

  test("waitForServerListening preserves browser access tokens from startup JSON", async () => {
    const child = createFakeChild();
    const waitPromise = __internal.waitForServerListening(child as any);

    child.stdout.write(
      `${JSON.stringify({
        type: "server_listening",
        url: "ws://127.0.0.1:1234/ws",
        port: 1234,
        cwd: "/tmp/workspace",
        browserAccessToken: "browser-token",
      })}\n`,
    );

    const payload = await waitPromise;
    expect(payload.browserAccessToken).toBe("browser-token");
  });

  test("waitForServerListening ignores mobile H3 payloads without host hints", async () => {
    const child = createFakeChild();
    const waitPromise = __internal.waitForServerListening(child as any);

    child.stdout.write(
      `${JSON.stringify({
        type: "server_listening",
        url: "ws://127.0.0.1:1234/ws",
        port: 1234,
        cwd: "/tmp/workspace",
        mobileH3: {
          url: "https://127.0.0.1:9443",
          port: 9443,
          hostHints: [],
          ticket: "cowork-pair://ticket",
          adminToken: "admin-token",
          certSha256: "a".repeat(64),
          spkiSha256: "b".repeat(43),
          identityPub: "desktop-identity",
          nonce: "nonce-value-123456789012",
          expiresAt: Date.now() + 60_000,
        },
      })}\n`,
    );
    child.stdout.write(
      `${JSON.stringify({
        type: "server_listening",
        url: "ws://127.0.0.1:1234/ws",
        port: 1234,
        cwd: "/tmp/workspace",
        mobileH3: {
          url: "https://127.0.0.1:9443",
          port: 9443,
          hostHints: ["127.0.0.1"],
          ticket: "cowork-pair://ticket",
          adminToken: "admin-token",
          certSha256: "a".repeat(64),
          spkiSha256: "b".repeat(43),
          identityPub: "desktop-identity",
          nonce: "nonce-value-123456789012",
          expiresAt: Date.now() + 60_000,
        },
      })}\n`,
    );

    const payload = await waitPromise;
    expect(payload.mobileH3?.hostHints).toEqual(["127.0.0.1"]);
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
  beforeEach(() => {
    setElectronMockOverrides(electronMockOverrides);
  });

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
    expect(env.COWORK_BROWSER_ACCESS_TOKEN).toEqual(expect.any(String));
    expect(env.COWORK_BROWSER_ACCESS_TOKEN?.length).toBeGreaterThan(20);
    expect(env.COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP).toBe(
      process.env.COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP ?? "1",
    );
  });

  test("buildServerEnv preserves explicit browser access tokens", () => {
    const previous = process.env.COWORK_BROWSER_ACCESS_TOKEN;
    try {
      process.env.COWORK_BROWSER_ACCESS_TOKEN = "explicit-browser-token";
      expect(__internal.buildServerEnv().COWORK_BROWSER_ACCESS_TOKEN).toBe(
        "explicit-browser-token",
      );
    } finally {
      if (previous === undefined) delete process.env.COWORK_BROWSER_ACCESS_TOKEN;
      else process.env.COWORK_BROWSER_ACCESS_TOKEN = previous;
    }
  });

  test("appendBrowserAccessToken returns a browser-authorized websocket URL", () => {
    expect(__internal.appendBrowserAccessToken("ws://127.0.0.1:7337/ws", "token value")).toBe(
      "ws://127.0.0.1:7337/ws?coworkBrowserToken=token+value",
    );
    expect(__internal.appendBrowserAccessToken("ws://127.0.0.1:7337/ws?existing=1", "token")).toBe(
      "ws://127.0.0.1:7337/ws?existing=1&coworkBrowserToken=token",
    );
    expect(__internal.appendBrowserAccessToken("ws://127.0.0.1:7337/ws", null)).toBe(
      "ws://127.0.0.1:7337/ws",
    );
  });

  test("buildServerEnv points packaged server at the bundled Codex app-server when present", async () => {
    const previousOverride = process.env.COWORK_CODEX_APP_SERVER_COMMAND;
    const previousDesktopOverride = process.env.COWORK_DESKTOP_CODEX_APP_SERVER_PATH;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-bundle-"));
    const bundled = path.join(dir, "codex-app-server-aarch64-apple-darwin");

    try {
      delete process.env.COWORK_CODEX_APP_SERVER_COMMAND;
      process.env.COWORK_DESKTOP_CODEX_APP_SERVER_PATH = bundled;
      await fs.writeFile(bundled, "");

      const env = __internal.buildServerEnv();
      expect(env.COWORK_CODEX_APP_SERVER_COMMAND).toBe(bundled);
      expect(env.COWORK_CODEX_APP_SERVER_ARGS).toBe("");
    } finally {
      if (previousOverride === undefined) delete process.env.COWORK_CODEX_APP_SERVER_COMMAND;
      else process.env.COWORK_CODEX_APP_SERVER_COMMAND = previousOverride;
      if (previousDesktopOverride === undefined) {
        delete process.env.COWORK_DESKTOP_CODEX_APP_SERVER_PATH;
      } else {
        process.env.COWORK_DESKTOP_CODEX_APP_SERVER_PATH = previousDesktopOverride;
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("buildServerEnv points packaged server at bundled Foundation Models SDK when present", async () => {
    const previousSdkDir = process.env.COWORK_TSFMSDK_DIR;
    const previousSidecarPath = process.env.COWORK_DESKTOP_SIDECAR_PATH;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-tsfm-sdk-bundle-"));
    const sidecar = path.join(dir, "cowork-server-aarch64-apple-darwin");
    const sdkDir = path.join(dir, "tsfm-sdk");

    try {
      delete process.env.COWORK_TSFMSDK_DIR;
      process.env.COWORK_DESKTOP_SIDECAR_PATH = sidecar;
      await fs.writeFile(sidecar, "");
      await fs.mkdir(path.join(sdkDir, "dist"), { recursive: true });
      await fs.mkdir(path.join(sdkDir, "native"), { recursive: true });
      await fs.mkdir(path.join(sdkDir, "node_modules", "koffi", "build", "koffi", "darwin_arm64"), {
        recursive: true,
      });
      await fs.writeFile(path.join(sdkDir, "dist", "index.js"), "");
      await fs.writeFile(path.join(sdkDir, "native", "libFoundationModels.dylib"), "");
      await fs.writeFile(
        path.join(sdkDir, "node_modules", "koffi", "build", "koffi", "darwin_arm64", "koffi.node"),
        "",
      );

      expect(__internal.buildServerEnv().COWORK_TSFMSDK_DIR).toBeUndefined();

      const env = __internal.buildServerEnv(undefined, {
        includeBundledFoundationModelsSdk: true,
      });
      expect(env.COWORK_TSFMSDK_DIR).toBe(sdkDir);
    } finally {
      if (previousSdkDir === undefined) delete process.env.COWORK_TSFMSDK_DIR;
      else process.env.COWORK_TSFMSDK_DIR = previousSdkDir;
      if (previousSidecarPath === undefined) {
        delete process.env.COWORK_DESKTOP_SIDECAR_PATH;
      } else {
        process.env.COWORK_DESKTOP_SIDECAR_PATH = previousSidecarPath;
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("buildServerEnv points packaged server at bundled Windows AI Electron when present", async () => {
    if (process.platform !== "win32") {
      const env = __internal.buildServerEnv(undefined, {
        includeBundledWindowsAiElectron: true,
      });
      expect(env.COWORK_WINDOWS_AI_ELECTRON_DIR).toBeUndefined();
      return;
    }

    const previousAddonDir = process.env.COWORK_WINDOWS_AI_ELECTRON_DIR;
    const previousSidecarPath = process.env.COWORK_DESKTOP_SIDECAR_PATH;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-windows-ai-electron-bundle-"));
    const sidecar = path.join(dir, resolvePackagedSidecarFilename(process.platform, process.arch));
    const addonDir = path.join(dir, "windows-ai-electron");
    const prebuildTriplet = resolveWindowsAiElectronPrebuildTriplet(process.platform, process.arch);
    const nativeAddonPath = path.join(
      addonDir,
      "windows-ai-electron",
      "prebuilds",
      prebuildTriplet,
      "node.node",
    );

    try {
      delete process.env.COWORK_WINDOWS_AI_ELECTRON_DIR;
      process.env.COWORK_DESKTOP_SIDECAR_PATH = sidecar;
      await fs.writeFile(sidecar, "");
      await fs.mkdir(path.dirname(nativeAddonPath), { recursive: true });
      await fs.writeFile(path.join(addonDir, "index.js"), "");
      await fs.writeFile(nativeAddonPath, "");

      expect(__internal.buildServerEnv().COWORK_WINDOWS_AI_ELECTRON_DIR).toBeUndefined();

      const env = __internal.buildServerEnv(undefined, {
        includeBundledWindowsAiElectron: true,
      });
      expect(env.COWORK_WINDOWS_AI_ELECTRON_DIR).toBe(addonDir);
    } finally {
      if (previousAddonDir === undefined) delete process.env.COWORK_WINDOWS_AI_ELECTRON_DIR;
      else process.env.COWORK_WINDOWS_AI_ELECTRON_DIR = previousAddonDir;
      if (previousSidecarPath === undefined) {
        delete process.env.COWORK_DESKTOP_SIDECAR_PATH;
      } else {
        process.env.COWORK_DESKTOP_SIDECAR_PATH = previousSidecarPath;
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("buildServerEnv enables OpenAI native connectors only from the desktop feature flag", () => {
    const previous = process.env.COWORK_EXPERIMENTAL_OPENAI_NATIVE_CONNECTORS;
    delete process.env.COWORK_EXPERIMENTAL_OPENAI_NATIVE_CONNECTORS;

    try {
      expect(__internal.buildServerEnv().COWORK_EXPERIMENTAL_OPENAI_NATIVE_CONNECTORS).toBe(
        undefined,
      );
      expect(
        __internal.buildServerEnv({ openAiNativeConnectors: false })
          .COWORK_EXPERIMENTAL_OPENAI_NATIVE_CONNECTORS,
      ).toBe(undefined);
      expect(
        __internal.buildServerEnv({ openAiNativeConnectors: true })
          .COWORK_EXPERIMENTAL_OPENAI_NATIVE_CONNECTORS,
      ).toBe("1");
    } finally {
      if (typeof previous === "string") {
        process.env.COWORK_EXPERIMENTAL_OPENAI_NATIVE_CONNECTORS = previous;
      } else {
        delete process.env.COWORK_EXPERIMENTAL_OPENAI_NATIVE_CONNECTORS;
      }
    }
  });

  test("only retries source startup automatically on Windows", () => {
    expect(__internal.getSourceStartupAttemptCount(true)).toBe(
      process.platform === "win32" ? 2 : 1,
    );
    expect(__internal.getSourceStartupAttemptCount(true, "win32")).toBe(2);
    expect(__internal.getSourceStartupAttemptCount(true, "darwin")).toBe(1);
    expect(__internal.getSourceStartupAttemptCount(false, "win32")).toBe(1);
  });

  test("server startup timeout leaves room for first-run bundled bootstrap", () => {
    expect(__internal.getServerStartupTimeoutMs({})).toBe(45_000);
    expect(
      __internal.getServerStartupTimeoutMs({
        COWORK_DESKTOP_SERVER_STARTUP_TIMEOUT_MS: "1",
      }),
    ).toBe(5_000);
    expect(
      __internal.getServerStartupTimeoutMs({
        COWORK_DESKTOP_SERVER_STARTUP_TIMEOUT_MS: "12000",
      }),
    ).toBe(12_000);
    expect(
      __internal.getServerStartupTimeoutMs({
        COWORK_DESKTOP_SERVER_STARTUP_TIMEOUT_MS: "600000",
      }),
    ).toBe(300_000);
  });

  test("only injects Bun transpiler cache env for Windows source attempts", () => {
    const windowsAttempt = __internal.buildSourceEnvForAttempt(
      { PATH: process.env.PATH },
      2,
      "win32",
    );
    const linuxAttempt = __internal.buildSourceEnvForAttempt(
      { PATH: process.env.PATH },
      2,
      "linux",
    );

    try {
      expect(typeof windowsAttempt.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH).toBe("string");
      expect(windowsAttempt.env.BUN_FEATURE_FLAG_DISABLE_ASYNC_TRANSPILER).toBe("1");
      expect(linuxAttempt.env).toEqual({ PATH: process.env.PATH });
    } finally {
      windowsAttempt.cleanup();
      linuxAttempt.cleanup();
    }
  });

  test("preserves existing H3 state when mobileH3 is omitted", () => {
    expect(
      __internal.shouldReplaceForMobileH3Request(undefined, {
        url: "https://127.0.0.1:9443",
        port: 9443,
        hostHints: ["127.0.0.1"],
        ticket: "cowork-pair://ticket",
        adminToken: "admin-token",
        certSha256: "cert",
        spkiSha256: "spki",
        identityPub: "identity",
        nonce: "nonce",
        expiresAt: Date.now() + 60_000,
        trustedDevice: null,
      }),
    ).toBe(false);
    expect(__internal.shouldReplaceForMobileH3Request(false, null)).toBe(false);
    expect(
      __internal.shouldReplaceForMobileH3Request(false, {
        url: "https://127.0.0.1:9443",
        port: 9443,
        hostHints: ["127.0.0.1"],
        ticket: "cowork-pair://ticket",
        adminToken: "admin-token",
        certSha256: "cert",
        spkiSha256: "spki",
        identityPub: "identity",
        nonce: "nonce",
        expiresAt: Date.now() + 60_000,
        trustedDevice: null,
      }),
    ).toBe(true);
    expect(__internal.shouldReplaceForMobileH3Request(true, null)).toBe(true);
  });
});

describe("desktop server manager bun crash detection", () => {
  beforeEach(() => {
    setElectronMockOverrides(electronMockOverrides);
  });

  test("detects bun panic output", () => {
    expect(
      __internal.isLikelyBunSegfault("panic(main thread): Segmentation fault at address 0x1"),
    ).toBe(true);
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

  test("stopAll concurrently kills and cleans up all active and pending servers", async () => {
    const manager = new ServerManager();
    const child1 = createFakeChild();
    const child2 = createFakeChild();
    const childPending = createFakeChild();

    let cleaned1 = false;
    let cleaned2 = false;
    let cleanedPending = false;

    (manager as any).servers.set("ws-1", {
      child: child1,
      url: "ws://localhost:1234",
      mobileH3: null,
      cleanup: () => {
        cleaned1 = true;
      },
    });

    (manager as any).servers.set("ws-2", {
      child: child2,
      url: "ws://localhost:5678",
      mobileH3: null,
      cleanup: () => {
        cleaned2 = true;
      },
    });

    (manager as any).pendingStarts.set("ws-pending", {
      child: childPending,
      cleanup: () => {
        cleanedPending = true;
      },
    });

    await manager.stopAll();

    expect((manager as any).servers.size).toBe(0);
    expect((manager as any).pendingStarts.size).toBe(0);
    expect(cleaned1).toBe(true);
    expect(cleaned2).toBe(true);
    expect(cleanedPending).toBe(true);
    expect(child1.exitCode).toBe(0);
    expect(child2.exitCode).toBe(0);
    expect(childPending.exitCode).toBe(0);
  });
});
