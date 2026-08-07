import { beforeEach, describe, expect, mock, test } from "bun:test";

import { createElectronMock, setElectronMockOverrides } from "./helpers/mockElectron";

const electronMockOverrides = {
  app: {
    getVersion: () => "1.2.23",
    getPath: () => "/tmp/cowork-userdata",
    isPackaged: true,
  },
};

setElectronMockOverrides(electronMockOverrides);
mock.module("electron", () => createElectronMock());

const { DesktopProductAnalyticsService } = await import("../electron/services/productAnalytics");

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    version: 2,
    workspaces: [],
    threads: [],
    ...overrides,
  } as never;
}

function makeService(opts?: {
  appVersion?: () => string;
  initialized?: boolean;
}) {
  const initCalls: unknown[] = [];
  const captured: Array<{ name: string; properties: unknown }> = [];
  const service = new DesktopProductAnalyticsService({
    env: { COWORK_POSTHOG_KEY: "phc_test", COWORK_PRODUCT_ANALYTICS_ENABLED: "true" },
    appVersion: opts?.appVersion ?? (() => "1.2.23"),
    isPackaged: () => true,
    platform: "win32",
    arch: "x64",
    generateAnonymousId: () => "anon_0123456789abcdef0123456789abcdef",
    // Injected rather than module-mocked: mock.module is process-global and
    // would follow this file into every later suite.
    initProductAnalyticsImpl: async (context) => {
      initCalls.push(context);
      return {
        initialized: opts?.initialized ?? false,
        reason: opts?.initialized ? "ready" : "disabled",
        enabled: Boolean(opts?.initialized),
        keyConfigured: true,
      } as never;
    },
    captureProductEventImpl: ((name, properties) => {
      captured.push({ name, properties });
    }) as never,
  });
  return { service, initCalls, captured };
}

describe("DesktopProductAnalyticsService.applyPersistedState", () => {
  beforeEach(() => {
    setElectronMockOverrides(electronMockOverrides);
  });

  test("only re-applies when the analytics configuration actually changes", async () => {
    const { service, initCalls } = makeService();
    const consented = makeState({
      privacyTelemetrySettings: { productAnalyticsEnabled: true },
    });

    await service.applyPersistedState(consented);
    expect(initCalls).toHaveLength(1);

    // The renderer persists desktop state several times a second; those saves are
    // identical as far as analytics is concerned.
    await service.applyPersistedState(
      makeState({ privacyTelemetrySettings: { productAnalyticsEnabled: true }, threads: [] }),
    );
    await service.applyPersistedState(consented);
    expect(initCalls).toHaveLength(1);

    // Withdrawing consent is a real change and must be applied.
    await service.applyPersistedState(
      makeState({ privacyTelemetrySettings: { productAnalyticsEnabled: false } }),
    );
    expect(initCalls).toHaveLength(2);

    // Repeating the withdrawn-consent state stays quiet again.
    await service.applyPersistedState(
      makeState({ privacyTelemetrySettings: { productAnalyticsEnabled: false } }),
    );
    expect(initCalls).toHaveLength(2);
  });

  test("still returns the prepared state on every call", async () => {
    const { service } = makeService();

    const first = await service.applyPersistedState(makeState());
    const second = await service.applyPersistedState(makeState());

    expect(first.state).toBeDefined();
    expect(second.state).toBeDefined();
    expect(second.changed).toBe(false);
  });

  test("captures app_started once after a successful analytics init", async () => {
    const { service, captured } = makeService({ initialized: true });
    const consented = makeState({
      privacyTelemetrySettings: { productAnalyticsEnabled: true },
      workspaces: [{ id: "ws-1" }],
      threads: [{ id: "t-1" }, { id: "t-2" }],
    });

    await service.applyPersistedState(consented);
    await service.applyPersistedState(consented);

    const started = captured.filter((event) => event.name === "app_started");
    expect(started).toHaveLength(1);
    expect(started[0]?.properties).toMatchObject({
      eventSource: "main",
      workspaceCount: 1,
      threadCount: 2,
      productAnalyticsEnabled: true,
    });
    expect(captured.some((event) => event.name === "app_updated")).toBe(false);
  });

  test("captures app_updated once when the app version changes", async () => {
    let version = "1.2.23";
    const { service, captured } = makeService({
      initialized: true,
      appVersion: () => version,
    });

    const first = await service.applyPersistedState(
      makeState({
        privacyTelemetrySettings: { productAnalyticsEnabled: true },
        productAnalytics: {
          anonymousInstallationId: "anon_0123456789abcdef0123456789abcdef",
          lastAppVersion: "1.2.23",
        },
      }),
    );
    expect(captured.filter((event) => event.name === "app_started")).toHaveLength(1);
    expect(captured.some((event) => event.name === "app_updated")).toBe(false);
    expect(first.state.productAnalytics?.lastAppVersion).toBe("1.2.23");

    version = "1.2.24";
    await service.applyPersistedState(
      makeState({
        privacyTelemetrySettings: { productAnalyticsEnabled: true },
        productAnalytics: first.state.productAnalytics,
      }),
    );

    const updated = captured.filter((event) => event.name === "app_updated");
    expect(updated).toHaveLength(1);
    expect(updated[0]?.properties).toMatchObject({
      eventSource: "main",
      status: "version_changed",
    });
    // Startup must stay a once-per-process capture even across version bumps.
    expect(captured.filter((event) => event.name === "app_started")).toHaveLength(1);
  });
});
