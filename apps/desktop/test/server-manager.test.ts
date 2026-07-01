import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import {
  WINDOWS_SANDBOX_COMMAND_RUNNER_NAME,
  WINDOWS_SANDBOX_HASH_MANIFEST_NAME,
  WINDOWS_SANDBOX_HELPER_NAME,
  WINDOWS_SANDBOX_SETUP_NAME,
} from "../../../src/platform/sandbox/windows";

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
    getVersion: () => "1.2.3",
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

type ServerManagerTestHandle = {
  child: FakeChild;
  cleanup: () => void;
};

type ServerManagerTestInternals = {
  servers: Map<
    string,
    ServerManagerTestHandle & {
      url: string;
      mobileH3: null;
    }
  >;
  pendingStarts: Map<string, ServerManagerTestHandle>;
  finishWorkspaceServerExit: (
    workspaceId: string,
    child: FakeChild,
    url: string | null,
    cleanup: () => void,
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => void;
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

function getServerManagerTestInternals(
  manager: InstanceType<typeof ServerManager>,
): ServerManagerTestInternals {
  return manager as unknown as ServerManagerTestInternals;
}

function createCountingCleanup(): { cleanup: () => void; getCount: () => number } {
  let cleaned = false;
  let count = 0;
  return {
    cleanup: () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      count += 1;
    },
    getCount: () => count,
  };
}

function forwardFakeExitToManager(
  internals: ServerManagerTestInternals,
  workspaceId: string,
  child: FakeChild,
  url: string | null,
  cleanup: () => void,
): void {
  child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
    internals.finishWorkspaceServerExit(workspaceId, child, url, cleanup, code, signal);
  });
}

async function withProcessEnv<T>(
  patch: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(patch)) {
    previous.set(key, process.env[key]);
    const value = patch[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
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

  test("waitForServerListening forwards validated runtime progress without treating it as log noise", async () => {
    const child = createFakeChild();
    const progress: Array<Record<string, unknown>> = [];
    const stdoutLines: string[] = [];
    const waitPromise = __internal.waitForServerListening(child as any, {
      onCoworkRuntimeBootstrapProgress: (next: Record<string, unknown>) => progress.push(next),
      onStdoutLine: (line: string) => stdoutLines.push(line),
    });

    child.stdout.write(
      `${JSON.stringify({
        type: "server_startup_progress",
        component: "cowork-runtime",
        progress: {
          phase: "downloading",
          version: "2026-06-22",
          transferredBytes: 25,
          totalBytes: 100,
          percent: 25,
        },
      })}\n`,
    );
    child.stdout.write(
      `${JSON.stringify({
        type: "server_listening",
        url: "ws://127.0.0.1:1234/ws",
        port: 1234,
        cwd: "/tmp/workspace",
      })}\n`,
    );

    await expect(waitPromise).resolves.toMatchObject({ port: 1234 });
    expect(progress).toEqual([
      {
        phase: "downloading",
        version: "2026-06-22",
        transferredBytes: 25,
        totalBytes: 100,
        percent: 25,
      },
    ]);
    expect(stdoutLines).toEqual([]);
  });

  test("runtime download progress refreshes the startup inactivity timeout", async () => {
    const child = createFakeChild();
    const waitPromise = __internal.waitForServerListening(child as any, { timeoutMs: 50 });

    setTimeout(() => {
      child.stdout.write(
        `${JSON.stringify({
          type: "server_startup_progress",
          component: "cowork-runtime",
          progress: {
            phase: "downloading",
            version: "2026-06-22",
            transferredBytes: 1,
            totalBytes: 2,
            percent: 50,
          },
        })}\n`,
      );
    }, 30);
    setTimeout(() => {
      child.stdout.write(
        `${JSON.stringify({
          type: "server_listening",
          url: "ws://127.0.0.1:1234/ws",
          port: 1234,
          cwd: "/tmp/workspace",
        })}\n`,
      );
    }, 65);

    await expect(waitPromise).resolves.toMatchObject({ port: 1234 });
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

  test("waitForServerListening keeps forwarding non-JSON stdout after readiness", async () => {
    const child = createFakeChild();
    const stdoutLines: string[] = [];
    const waitPromise = __internal.waitForServerListening(child as any, {
      onStdoutLine: (line: string) => {
        stdoutLines.push(line);
      },
    });

    child.stdout.write(
      `${JSON.stringify({
        type: "server_listening",
        url: "ws://127.0.0.1:1234/ws",
        port: 1234,
        cwd: "/tmp/workspace",
      })}\n`,
    );

    await expect(waitPromise).resolves.toMatchObject({
      url: "ws://127.0.0.1:1234/ws",
    });

    child.stdout.write("server log after ready\n");
    child.stdout.write(`${JSON.stringify({ type: "status", phase: "logged" })}\n`);
    await Bun.sleep(0);

    expect(stdoutLines).toEqual([
      "server log after ready",
      JSON.stringify({ type: "status", phase: "logged" }),
    ]);
    child.emit("exit", 0, null);
  });

  test("withStderrTail appends compact server stderr diagnostics", () => {
    expect(__internal.withStderrTail("startup failed", " first line\n\nsecond\tline ")).toBe(
      "startup failed; stderr=first line second line",
    );
    expect(__internal.withStderrTail("startup failed", " \n ")).toBe("startup failed");
  });

  test("server output mirror prefixes complete lines and flushes partial chunks", () => {
    const stdoutWrites: string[] = [];
    const stderrWrites: string[] = [];
    const mirror = __internal.createServerOutputMirror({
      stdoutWrite: (chunk: string) => {
        stdoutWrites.push(chunk);
      },
      stderrWrite: (chunk: string) => {
        stderrWrites.push(chunk);
      },
    });

    mirror.writeLine("stdout", "ready log");
    mirror.writeChunk("stderr", "first");
    mirror.writeChunk("stderr", " line\nsecond line\npartial");
    mirror.flush();

    expect(stdoutWrites).toEqual(["[cowork-server:stdout] ready log\n"]);
    expect(stderrWrites).toEqual([
      "[cowork-server:stderr] first line\n",
      "[cowork-server:stderr] second line\n",
      "[cowork-server:stderr] partial\n",
    ]);
  });

  test("server output mirroring is enabled for dev and explicit packaged debugging", () => {
    expect(__internal.shouldMirrorServerOutput({}, false)).toBe(true);
    expect(__internal.shouldMirrorServerOutput({}, true)).toBe(false);
    expect(
      __internal.shouldMirrorServerOutput({ COWORK_DESKTOP_DEBUG_SERVER_STDERR: "1" }, true),
    ).toBe(true);
    expect(
      __internal.shouldMirrorServerOutput({ COWORK_DESKTOP_MIRROR_SERVER_LOGS: "1" }, true),
    ).toBe(true);
    expect(
      __internal.shouldMirrorServerOutput({ COWORK_DESKTOP_MIRROR_SERVER_LOGS: "0" }, false),
    ).toBe(false);
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

  test("buildServerEnv enables independent marketplace and runtime downloads by default", () => {
    const env = __internal.buildServerEnv();
    expect(env).not.toBe(process.env);
    expect(env.COWORK_WEB_DESKTOP_SERVICE).toBe("1");
    expect(env.COWORK_DESKTOP_STARTUP_EVENTS).toBe("1");
    expect(env.COWORK_DESKTOP_USER_DATA_DIR).toBe(userDataDir);
    expect(env.COWORK_BROWSER_ACCESS_TOKEN).toEqual(expect.any(String));
    expect(env.COWORK_BROWSER_ACCESS_TOKEN?.length).toBeGreaterThan(20);
    expect(env.COWORK_BOOTSTRAP_DEFAULT_SKILLS).toBe(
      process.env.COWORK_BOOTSTRAP_DEFAULT_SKILLS ?? "1",
    );
    expect(env.COWORK_RUNTIME_ALLOW_NETWORK).toBe(process.env.COWORK_RUNTIME_ALLOW_NETWORK ?? "1");
    expect(env.COWORK_HARNESS_TERMINAL_LOGS).toBe(
      process.env.COWORK_HARNESS_TERMINAL_LOGS?.trim() || "1",
    );
    expect(env.AGENT_OBSERVABILITY_ENABLED).toBe("false");
    expect(env.AGENT_OBSERVABILITY_RECORD_PAYLOADS).toBe("false");
  });

  test("buildServerEnv does not inherit the child-server default-skills skip flag", async () => {
    await withProcessEnv({ COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP: "1" }, () => {
      expect(__internal.buildServerEnv().COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP).toBeUndefined();
    });
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

  test("buildServerEnv forces Langfuse off and strips inherited env by default", () => {
    const previousLangfusePublicKey = process.env.LANGFUSE_PUBLIC_KEY;
    const previousLangfuseSecretKey = process.env.LANGFUSE_SECRET_KEY;
    const previousLangfuseBaseUrl = process.env.LANGFUSE_BASE_URL;
    const previousAgentObservabilityEnabled = process.env.AGENT_OBSERVABILITY_ENABLED;
    try {
      process.env.LANGFUSE_PUBLIC_KEY = "pk-inherited";
      process.env.LANGFUSE_SECRET_KEY = "sk-inherited";
      process.env.LANGFUSE_BASE_URL = "https://langfuse.example";
      process.env.AGENT_OBSERVABILITY_ENABLED = "true";

      const env = __internal.buildServerEnv();

      expect(env.LANGFUSE_PUBLIC_KEY).toBeUndefined();
      expect(env.LANGFUSE_SECRET_KEY).toBeUndefined();
      expect(env.LANGFUSE_BASE_URL).toBeUndefined();
      expect(env.AGENT_OBSERVABILITY_ENABLED).toBe("false");
      expect(env.AGENT_OBSERVABILITY_RECORD_INPUTS).toBe("false");
      expect(env.AGENT_OBSERVABILITY_RECORD_OUTPUTS).toBe("false");
      expect(env.AGENT_OBSERVABILITY_RECORD_PAYLOADS).toBe("false");
    } finally {
      if (previousLangfusePublicKey === undefined) delete process.env.LANGFUSE_PUBLIC_KEY;
      else process.env.LANGFUSE_PUBLIC_KEY = previousLangfusePublicKey;
      if (previousLangfuseSecretKey === undefined) delete process.env.LANGFUSE_SECRET_KEY;
      else process.env.LANGFUSE_SECRET_KEY = previousLangfuseSecretKey;
      if (previousLangfuseBaseUrl === undefined) delete process.env.LANGFUSE_BASE_URL;
      else process.env.LANGFUSE_BASE_URL = previousLangfuseBaseUrl;
      if (previousAgentObservabilityEnabled === undefined) {
        delete process.env.AGENT_OBSERVABILITY_ENABLED;
      } else {
        process.env.AGENT_OBSERVABILITY_ENABLED = previousAgentObservabilityEnabled;
      }
    }
  });

  test("buildServerEnv enables metadata-only Langfuse env from privacy settings", () => {
    const env = __internal.buildServerEnv(undefined, {
      privacyTelemetrySettings: {
        aiTraceTelemetryEnabled: true,
        aiTracePayloadsEnabled: false,
      },
    });

    expect(env.AGENT_OBSERVABILITY_ENABLED).toBe("true");
    expect(env.AGENT_OBSERVABILITY_RECORD_INPUTS).toBe("false");
    expect(env.AGENT_OBSERVABILITY_RECORD_OUTPUTS).toBe("false");
    expect(env.AGENT_OBSERVABILITY_RECORD_PAYLOADS).toBe("false");
    expect(env.LANGFUSE_TRACING_ENVIRONMENT).toBe("desktop-dev");
    expect(env.LANGFUSE_RELEASE).toBe("1.2.3");
  });

  test("buildServerEnv enables full payload Langfuse env only from payload consent", () => {
    const env = __internal.buildServerEnv(undefined, {
      privacyTelemetrySettings: {
        aiTraceTelemetryEnabled: true,
        aiTracePayloadsEnabled: true,
      },
    });

    expect(env.AGENT_OBSERVABILITY_ENABLED).toBe("true");
    expect(env.AGENT_OBSERVABILITY_RECORD_INPUTS).toBe("true");
    expect(env.AGENT_OBSERVABILITY_RECORD_OUTPUTS).toBe("true");
    expect(env.AGENT_OBSERVABILITY_RECORD_PAYLOADS).toBe("true");
  });

  test("buildServerEnv strips inherited Sentry env and disables crash reporting without consent", async () => {
    await withProcessEnv(
      {
        COWORK_CRASH_REPORTS_ENABLED: "true",
        COWORK_SENTRY_DSN: "https://cowork@sentry.example/1",
        COWORK_SENTRY_ENVIRONMENT: "production",
        SENTRY_AUTH_TOKEN: "auth-token",
        SENTRY_DSN: "https://fallback@sentry.example/1",
      },
      () => {
        const env = __internal.buildServerEnv(undefined, {
          privacyTelemetrySettings: {
            crashReportsEnabled: false,
            aiTraceTelemetryEnabled: true,
          },
        });

        expect(env.COWORK_CRASH_REPORTS_ENABLED).toBe("false");
        expect(env.COWORK_SENTRY_DSN).toBeUndefined();
        expect(env.COWORK_SENTRY_ENVIRONMENT).toBeUndefined();
        expect(env.SENTRY_AUTH_TOKEN).toBeUndefined();
        expect(env.SENTRY_DSN).toBeUndefined();
      },
    );
  });

  test("buildServerEnv passes only safe crash reporting env when enabled and configured", async () => {
    await withProcessEnv(
      {
        COWORK_SENTRY_DSN: "https://cowork@sentry.example/1",
        COWORK_SENTRY_ENVIRONMENT: "production",
        COWORK_RELEASE: "desktop-release",
        SENTRY_AUTH_TOKEN: "auth-token",
        SENTRY_DSN: "https://fallback@sentry.example/1",
      },
      () => {
        const env = __internal.buildServerEnv(undefined, {
          privacyTelemetrySettings: {
            crashReportsEnabled: true,
          },
        });

        expect(env.COWORK_CRASH_REPORTS_ENABLED).toBe("true");
        expect(env.COWORK_SENTRY_DSN).toBe("https://cowork@sentry.example/1");
        expect(env.COWORK_SENTRY_ENVIRONMENT).toBe("production");
        expect(env.COWORK_RELEASE).toBe("desktop-release");
        expect(env.SENTRY_AUTH_TOKEN).toBeUndefined();
        expect(env.SENTRY_DSN).toBeUndefined();
      },
    );
  });

  test("buildServerEnv strips inherited PostHog env and disables product analytics without consent", async () => {
    await withProcessEnv(
      {
        COWORK_PRODUCT_ANALYTICS_ENABLED: "true",
        COWORK_PRODUCT_ANALYTICS_INSTALLATION_ID: "anon_inherited123456",
        COWORK_POSTHOG_KEY: "phc_inherited",
        COWORK_POSTHOG_HOST: "https://posthog.example",
        COWORK_POSTHOG_ENVIRONMENT: "production",
        POSTHOG_API_KEY: "legacy-key",
      },
      () => {
        const env = __internal.buildServerEnv(undefined, {
          privacyTelemetrySettings: {
            productAnalyticsEnabled: false,
          },
        });

        expect(env.COWORK_PRODUCT_ANALYTICS_ENABLED).toBe("false");
        expect(env.COWORK_PRODUCT_ANALYTICS_INSTALLATION_ID).toBeUndefined();
        expect(env.COWORK_POSTHOG_KEY).toBeUndefined();
        expect(env.COWORK_POSTHOG_HOST).toBeUndefined();
        expect(env.COWORK_POSTHOG_ENVIRONMENT).toBeUndefined();
        expect(env.POSTHOG_API_KEY).toBeUndefined();
      },
    );
  });

  test("buildServerEnv passes safe PostHog env only when enabled and configured", async () => {
    await withProcessEnv(
      {
        COWORK_POSTHOG_KEY: "phc_configured",
        COWORK_POSTHOG_HOST: "https://posthog.example",
        COWORK_POSTHOG_ENVIRONMENT: "production",
        COWORK_RELEASE: "desktop-release",
        POSTHOG_API_KEY: "legacy-key",
      },
      () => {
        const env = __internal.buildServerEnv(undefined, {
          privacyTelemetrySettings: {
            productAnalyticsEnabled: true,
          },
          productAnalyticsState: {
            anonymousInstallationId: "anon_1234567890123456",
            lastAppVersion: "1.2.3",
          },
        });

        expect(env.COWORK_PRODUCT_ANALYTICS_ENABLED).toBe("true");
        expect(env.COWORK_PRODUCT_ANALYTICS_INSTALLATION_ID).toBe("anon_1234567890123456");
        expect(env.COWORK_POSTHOG_KEY).toBe("phc_configured");
        expect(env.COWORK_POSTHOG_HOST).toBe("https://posthog.example");
        expect(env.COWORK_POSTHOG_ENVIRONMENT).toBe("production");
        expect(env.COWORK_RELEASE).toBe("desktop-release");
        expect(env.POSTHOG_API_KEY).toBeUndefined();
      },
    );
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

  test("buildServerEnv ignores bundled Codex app-server fallbacks", async () => {
    const previousOverride = process.env.COWORK_CODEX_APP_SERVER_COMMAND;
    const previousBundledOverride = process.env.COWORK_BUNDLED_CODEX_APP_SERVER_COMMAND;
    const previousDesktopOverride = process.env.COWORK_DESKTOP_CODEX_APP_SERVER_PATH;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-bundle-"));
    const bundled = path.join(dir, "codex-app-server-aarch64-apple-darwin");

    try {
      delete process.env.COWORK_CODEX_APP_SERVER_COMMAND;
      delete process.env.COWORK_BUNDLED_CODEX_APP_SERVER_COMMAND;
      process.env.COWORK_DESKTOP_CODEX_APP_SERVER_PATH = bundled;
      await fs.writeFile(bundled, "");

      const env = __internal.buildServerEnv();
      expect(env.COWORK_CODEX_APP_SERVER_COMMAND).toBeUndefined();
      expect(env.COWORK_CODEX_APP_SERVER_ARGS).toBeUndefined();
      expect(env.COWORK_BUNDLED_CODEX_APP_SERVER_COMMAND).toBeUndefined();
    } finally {
      if (previousOverride === undefined) delete process.env.COWORK_CODEX_APP_SERVER_COMMAND;
      else process.env.COWORK_CODEX_APP_SERVER_COMMAND = previousOverride;
      if (previousBundledOverride === undefined) {
        delete process.env.COWORK_BUNDLED_CODEX_APP_SERVER_COMMAND;
      } else {
        process.env.COWORK_BUNDLED_CODEX_APP_SERVER_COMMAND = previousBundledOverride;
      }
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
      await fs.writeFile(path.join(sdkDir, "node_modules", "koffi", "index.js"), "");
      await fs.writeFile(path.join(sdkDir, "node_modules", "koffi", "package.json"), "{}");
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

  test("buildServerEnv points Windows source servers at the bundled sandbox helper", async () => {
    const previousHelper = process.env.COWORK_WIN_SANDBOX_HELPER;
    const previousSidecarPath = process.env.COWORK_DESKTOP_SIDECAR_PATH;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-windows-sandbox-helper-"));
    const sidecar = path.join(dir, resolvePackagedSidecarFilename(process.platform, process.arch));
    const helper = path.join(dir, WINDOWS_SANDBOX_HELPER_NAME);
    const setup = path.join(dir, WINDOWS_SANDBOX_SETUP_NAME);
    const commandRunner = path.join(dir, WINDOWS_SANDBOX_COMMAND_RUNNER_NAME);
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");

    try {
      delete process.env.COWORK_WIN_SANDBOX_HELPER;
      process.env.COWORK_DESKTOP_SIDECAR_PATH = sidecar;
      await fs.writeFile(sidecar, "");
      await fs.writeFile(helper, "helper");
      await fs.writeFile(setup, "setup");
      await fs.writeFile(commandRunner, "runner");
      await fs.writeFile(
        path.join(dir, WINDOWS_SANDBOX_HASH_MANIFEST_NAME),
        JSON.stringify({
          schemaVersion: 1,
          files: {
            [WINDOWS_SANDBOX_HELPER_NAME]: digest("helper"),
            [WINDOWS_SANDBOX_SETUP_NAME]: digest("setup"),
            [WINDOWS_SANDBOX_COMMAND_RUNNER_NAME]: digest("runner"),
          },
        }),
      );

      expect(__internal.findBundledWindowsSandboxHelper()).toBe(helper);
      if (process.platform === "win32") {
        const env = __internal.buildServerEnv();
        expect(env.COWORK_WIN_SANDBOX_HELPER).toBe(helper);
        expect(env.COWORK_WIN_SANDBOX_HELPER_SHA256).toBe(digest("helper"));
        expect(env.COWORK_WIN_SANDBOX_SETUP).toBe(setup);
        expect(env.COWORK_WIN_SANDBOX_COMMAND_RUNNER).toBe(commandRunner);
      }
    } finally {
      if (previousHelper === undefined) delete process.env.COWORK_WIN_SANDBOX_HELPER;
      else process.env.COWORK_WIN_SANDBOX_HELPER = previousHelper;
      if (previousSidecarPath === undefined) {
        delete process.env.COWORK_DESKTOP_SIDECAR_PATH;
      } else {
        process.env.COWORK_DESKTOP_SIDECAR_PATH = previousSidecarPath;
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("records UAC cancellation and does not repeat setup prompts in one desktop session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-sandbox-readiness-"));
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const actions: string[] = [];
    __internal.resetWindowsSandboxSetupAttemptForTests();
    const bundle = {
      helperPath: "C:\\trusted\\cowork-win-sandbox.exe",
      helperSha256: "a".repeat(64),
      setupPath: "C:\\trusted\\codex-windows-sandbox-setup.exe",
      setupSha256: "b".repeat(64),
      commandRunnerPath: "C:\\trusted\\codex-command-runner.exe",
      commandRunnerSha256: "c".repeat(64),
    };
    const runHelper = async (_helperPath: string, args: string[]) => {
      actions.push(args[0]!);
      return args[0] === "probe"
        ? {
            code: 3,
            stdout:
              '{"ready":false,"filesystem":false,"network":false,"process":false,"integrity":true,"setup_required":true}',
            stderr: "",
          }
        : { code: 2, stdout: "", stderr: "orchestrator_helper_launch_canceled" };
    };

    try {
      await __internal.ensureWindowsSandboxReady(workspace, {
        platform: "win32",
        userDataDir: root,
        resolveBundle: () => bundle,
        runHelper,
      });
      const readiness = JSON.parse(
        await fs.readFile(path.join(root, "windows-sandbox", "readiness.json"), "utf8"),
      );
      expect(actions).toEqual(["probe", "setup"]);
      expect(readiness).toMatchObject({
        state: "setup-failed",
        bundleTrusted: true,
        setupRequired: true,
      });

      actions.splice(0);
      await __internal.ensureWindowsSandboxReady(workspace, {
        platform: "win32",
        userDataDir: root,
        resolveBundle: () => bundle,
        runHelper,
      });
      expect(actions).toEqual(["probe"]);
    } finally {
      __internal.resetWindowsSandboxSetupAttemptForTests();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("records a stale sandbox setup upgrade only after every native probe passes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-sandbox-readiness-"));
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    __internal.resetWindowsSandboxSetupAttemptForTests();
    try {
      await __internal.ensureWindowsSandboxReady(workspace, {
        platform: "win32",
        userDataDir: root,
        resolveBundle: () => ({
          helperPath: "C:\\trusted\\cowork-win-sandbox.exe",
          helperSha256: "a".repeat(64),
          setupPath: "C:\\trusted\\codex-windows-sandbox-setup.exe",
          setupSha256: "b".repeat(64),
          commandRunnerPath: "C:\\trusted\\codex-command-runner.exe",
          commandRunnerSha256: "c".repeat(64),
        }),
        runHelper: async (_helperPath: string, args: string[]) =>
          args[0] === "probe"
            ? {
                code: 3,
                stdout:
                  '{"ready":false,"filesystem":false,"network":false,"process":false,"integrity":true,"setup_required":true}',
                stderr: "",
              }
            : {
                code: 0,
                stdout:
                  '{"ready":true,"filesystem":true,"network":true,"process":true,"integrity":true,"setup_required":false}',
                stderr: "",
              },
      });
      const readiness = JSON.parse(
        await fs.readFile(path.join(root, "windows-sandbox", "readiness.json"), "utf8"),
      );
      expect(readiness).toMatchObject({
        state: "ready",
        setupRequired: false,
        enforcement: { filesystem: true, network: true, process: true, integrity: true },
      });
    } finally {
      __internal.resetWindowsSandboxSetupAttemptForTests();
      await fs.rm(root, { recursive: true, force: true });
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

  test("packaged server startup leaves room for first-run runtime bootstrap", () => {
    expect(__internal.getServerStartupTimeoutMs({}, false)).toBe(45_000);
    expect(__internal.getServerStartupTimeoutMs({}, true)).toBe(300_000);
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

  test("getWorkspaceServerStatus verifies the named health endpoint", async () => {
    const child = createFakeChild();
    const requestedUrls: string[] = [];
    const manager = new ServerManager({
      fetch: mock(async (url: string | URL | Request) => {
        requestedUrls.push(String(url));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as typeof fetch,
    });
    (manager as any).servers.set("ws-health", {
      child,
      url: "ws://127.0.0.1:7337/ws?coworkBrowserToken=token",
      mobileH3: null,
      cleanup: () => {},
    });

    await expect(manager.getWorkspaceServerStatus("ws-health")).resolves.toEqual({
      workspaceId: "ws-health",
      running: true,
      url: "ws://127.0.0.1:7337/ws?coworkBrowserToken=token",
      reason: "running",
    });
    expect(requestedUrls).toEqual(["http://127.0.0.1:7337/cowork/health?coworkBrowserToken=token"]);
  });

  test("getWorkspaceServerStatus reports failed health checks without reusing the handle", async () => {
    const child = createFakeChild();
    const manager = new ServerManager({
      fetch: mock(async () => new Response("unavailable", { status: 503 })) as typeof fetch,
    });
    (manager as any).servers.set("ws-unhealthy", {
      child,
      url: "ws://127.0.0.1:7337/ws",
      mobileH3: null,
      cleanup: () => {},
    });

    await expect(manager.getWorkspaceServerStatus("ws-unhealthy")).resolves.toEqual({
      workspaceId: "ws-unhealthy",
      running: false,
      url: "ws://127.0.0.1:7337/ws",
      reason: "health_failed",
      error: "HTTP 503",
    });
  });

  test("getWorkspaceServerStatus reports live pending starts", async () => {
    const child = createFakeChild();
    const manager = new ServerManager();
    (manager as any).pendingStarts.set("ws-pending", {
      child,
      cleanup: () => {},
    });

    await expect(manager.getWorkspaceServerStatus("ws-pending")).resolves.toEqual({
      workspaceId: "ws-pending",
      running: false,
      url: null,
      reason: "starting",
    });
  });

  test("forceRestart skips the existing workspace server reuse branch", () => {
    const existing = {
      child: createFakeChild(),
      url: "ws://127.0.0.1:7337/ws",
      mobileH3: null,
      cleanup: () => {},
    };

    expect(__internal.shouldReuseExistingWorkspaceServer({}, existing as never)).toBe(true);
    expect(
      __internal.shouldReuseExistingWorkspaceServer({ forceRestart: true }, existing as never),
    ).toBe(false);
  });

  test("reusing a healthy workspace server does not increment restart diagnostics", async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-server-reuse-"));
    try {
      const manager = new ServerManager();
      (manager as any).servers.set("ws-reuse", {
        child: createFakeChild(),
        url: "ws://127.0.0.1:7337/ws",
        mobileH3: null,
        cleanup: () => {},
      });
      (manager as any).startCountsByWorkspace.set("ws-reuse", 1);

      await expect(
        manager.startWorkspaceServer({
          workspaceId: "ws-reuse",
          workspacePath,
          yolo: false,
        }),
      ).resolves.toEqual({
        url: "ws://127.0.0.1:7337/ws",
        mobileH3: null,
      });

      expect(manager.getDiagnostics().workspaces).toContainEqual(
        expect.objectContaining({
          workspaceId: "ws-reuse",
          restartCount: 0,
        }),
      );
    } finally {
      await fs.rm(workspacePath, { recursive: true, force: true });
    }
  });

  test("server exit cleanup emits a workspaceServerExited event", () => {
    const child = createFakeChild();
    const exits: unknown[] = [];
    let cleaned = false;
    const manager = new ServerManager({
      onWorkspaceServerExited: (event) => exits.push(event),
    });
    (manager as any).servers.set("ws-exit", {
      child,
      url: "ws://127.0.0.1:7337/ws",
      mobileH3: null,
      cleanup: () => {
        cleaned = true;
      },
    });

    (manager as any).finishWorkspaceServerExit(
      "ws-exit",
      child,
      "ws://127.0.0.1:7337/ws",
      () => {
        cleaned = true;
      },
      1,
      null,
    );

    expect((manager as any).servers.has("ws-exit")).toBe(false);
    expect(cleaned).toBe(true);
    expect(exits).toEqual([
      {
        workspaceId: "ws-exit",
        url: "ws://127.0.0.1:7337/ws",
        code: 1,
        signal: null,
      },
    ]);
  });

  test("stopWorkspaceServer suppresses active server exit notifications", async () => {
    const child = createFakeChild();
    const exits: unknown[] = [];
    const manager = new ServerManager({
      onWorkspaceServerExited: (event) => exits.push(event),
    });
    const internals = getServerManagerTestInternals(manager);
    const cleanupCounter = createCountingCleanup();

    internals.servers.set("ws-stop", {
      child,
      url: "ws://127.0.0.1:7337/ws",
      mobileH3: null,
      cleanup: cleanupCounter.cleanup,
    });
    forwardFakeExitToManager(
      internals,
      "ws-stop",
      child,
      "ws://127.0.0.1:7337/ws",
      cleanupCounter.cleanup,
    );

    await manager.stopWorkspaceServer("ws-stop");

    expect(internals.servers.has("ws-stop")).toBe(false);
    expect(cleanupCounter.getCount()).toBe(1);
    expect(child.exitCode).toBe(0);
    expect(exits).toEqual([]);
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

  test("stopAll suppresses exit notifications for active and pending servers", async () => {
    const childActive = createFakeChild();
    const childPending = createFakeChild();
    const exits: unknown[] = [];
    const manager = new ServerManager({
      onWorkspaceServerExited: (event) => exits.push(event),
    });
    const internals = getServerManagerTestInternals(manager);
    const activeCleanup = createCountingCleanup();
    const pendingCleanup = createCountingCleanup();

    internals.servers.set("ws-active", {
      child: childActive,
      url: "ws://127.0.0.1:7337/ws",
      mobileH3: null,
      cleanup: activeCleanup.cleanup,
    });
    internals.pendingStarts.set("ws-pending", {
      child: childPending,
      cleanup: pendingCleanup.cleanup,
    });
    forwardFakeExitToManager(
      internals,
      "ws-active",
      childActive,
      "ws://127.0.0.1:7337/ws",
      activeCleanup.cleanup,
    );
    forwardFakeExitToManager(internals, "ws-pending", childPending, null, pendingCleanup.cleanup);

    await manager.stopAll();

    expect(internals.servers.size).toBe(0);
    expect(internals.pendingStarts.size).toBe(0);
    expect(activeCleanup.getCount()).toBe(1);
    expect(pendingCleanup.getCount()).toBe(1);
    expect(childActive.exitCode).toBe(0);
    expect(childPending.exitCode).toBe(0);
    expect(exits).toEqual([]);
  });
});
