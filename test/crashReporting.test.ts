import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  __internal,
  addBreadcrumb,
  type CrashReportingSdk,
  captureError,
  initCrashReporting,
} from "../src/telemetry/crashReporting";

function createFakeSdk() {
  const init = mock(() => {});
  const captureException = mock(() => {});
  const addBreadcrumbMock = mock(() => {});
  const close = mock(async () => true);
  const sdk: CrashReportingSdk = {
    init,
    captureException,
    addBreadcrumb: addBreadcrumbMock,
    close,
  };
  return { sdk, init, captureException, addBreadcrumbMock, close };
}

describe("crash reporting wrapper", () => {
  afterEach(async () => {
    await __internal.resetCrashReportingForTests();
  });

  test("disabled mode does not load the Sentry SDK", async () => {
    let loaderCalls = 0;
    const status = await initCrashReporting({
      component: "cowork-server",
      enabled: false,
      dsn: "https://public@sentry.example/1",
      loadSdk: async () => {
        loaderCalls += 1;
        return createFakeSdk().sdk;
      },
    });

    expect(status.initialized).toBe(false);
    expect(status.reason).toBe("disabled");
    expect(loaderCalls).toBe(0);
  });

  test("missing DSN leaves crash reporting as a no-op without loading the SDK", async () => {
    let loaderCalls = 0;
    const status = await initCrashReporting({
      component: "electron-main",
      enabled: true,
      env: {},
      loadSdk: async () => {
        loaderCalls += 1;
        return createFakeSdk().sdk;
      },
    });

    expect(status.initialized).toBe(false);
    expect(status.reason).toBe("not_configured");
    expect(loaderCalls).toBe(0);
  });

  test("global kill switch does not load the Sentry SDK", async () => {
    let loaderCalls = 0;
    const status = await initCrashReporting({
      component: "cowork-server",
      enabled: true,
      dsn: "https://public@sentry.example/1",
      env: { COWORK_DISABLE_NETWORK_TELEMETRY: "true" },
      loadSdk: async () => {
        loaderCalls += 1;
        return createFakeSdk().sdk;
      },
    });

    expect(status.initialized).toBe(false);
    expect(status.reason).toBe("disabled");
    expect(loaderCalls).toBe(0);
  });

  test("sdk load failures report a sanitized detail", async () => {
    const status = await initCrashReporting({
      component: "electron-main",
      enabled: true,
      dsn: "https://public@sentry.example/1",
      homeDir: "/Users/alice",
      loadSdk: async () => {
        throw new Error("Cannot find module /Users/alice/app.asar/@sentry/electron/main");
      },
    });

    expect(status.initialized).toBe(false);
    expect(status.reason).toBe("sdk_unavailable");
    expect(status.detail).toContain("Cannot find module [LOCAL_PATH]/app.asar");
    expect(status.detail).not.toContain("/Users/alice");
  });

  test("enabled mode initializes, captures, and breadcrumbs through the loaded SDK", async () => {
    const fake = createFakeSdk();
    const status = await initCrashReporting({
      component: "electron-renderer",
      enabled: true,
      dsn: "https://public@sentry.example/1",
      release: "1.2.3",
      environment: "production",
      appVersion: "1.2.3",
      platform: "darwin",
      arch: "arm64",
      tags: { packaged: true },
      loadSdk: async () => fake.sdk,
    });

    expect(status.initialized).toBe(true);
    expect(fake.init).toHaveBeenCalledTimes(1);

    captureError(new Error("boom"), {
      tags: { operation: "test" },
      extra: { token: "secret-token" },
    });
    addBreadcrumb({ category: "startup", message: "booted" });

    expect(fake.captureException).toHaveBeenCalledTimes(1);
    expect(fake.addBreadcrumbMock).toHaveBeenCalledWith({
      category: "startup",
      message: "booted",
    });
  });

  test("scrubber redacts local paths, secret-like keys, request bodies, and long messages", () => {
    const context = {
      homeDir: "/Users/alice",
      workspacePaths: ["/Users/alice/Projects/private-workspace"],
    };
    const scrubbed = __internal.scrubSentryEvent(
      {
        message: `${"/Users/alice/Projects/private-workspace/src/index.ts"} ${"C:\\Users\\alice\\repo\\file.ts"} ${"a".repeat(2_000)}`,
        request: {
          url: "http://127.0.0.1:7337/ws",
          data: "prompt text",
          body: "completion text",
          headers: {
            authorization: "Bearer token",
            cookie: "session=value",
            "x-safe": "/home/alice/project/file.ts",
          },
        },
        extra: {
          api_key: "sk-test",
          nested: {
            privateKey: "key",
            workspace: "/Users/alice/Projects/private-workspace/README.md",
          },
        },
      },
      context,
    );

    const encoded = JSON.stringify(scrubbed);
    expect(encoded).toContain("[LOCAL_PATH]");
    expect(encoded).toContain("[REDACTED]");
    expect(encoded).toContain("[TRUNCATED]");
    expect(encoded).not.toContain("/Users/alice");
    expect(encoded).not.toContain("C:\\Users\\alice");
    expect(encoded).not.toContain("/home/alice");
    expect(encoded).not.toContain("prompt text");
    expect(encoded).not.toContain("completion text");
    expect(encoded).not.toContain("Bearer token");
    expect(encoded).not.toContain("session=value");
    expect(encoded).not.toContain("sk-test");
  });

  test("scrubber drops console and unsafe automatic breadcrumbs", () => {
    expect(
      __internal.scrubSentryBreadcrumb({
        category: "console",
        message: "do not keep console output",
      }),
    ).toBeNull();
    expect(
      __internal.scrubSentryBreadcrumb({ category: "ui.click", message: "button" }),
    ).toBeNull();
    expect(
      __internal.scrubSentryBreadcrumb({ category: "startup", message: "server starting" }),
    ).toEqual({ category: "startup", message: "server starting" });
  });

  test("integration filtering disables replay, console capture, profiling, and AI hooks", () => {
    const filtered = __internal.filterIntegrations([
      { name: "Http" },
      { name: "Replay" },
      { name: "CaptureConsole" },
      { name: "OpenAI" },
      { name: "LocalVariables" },
      { name: "Breadcrumbs" },
    ]);

    expect(filtered.map((integration) => integration.name)).toEqual(["Http", "Breadcrumbs"]);
  });
});
