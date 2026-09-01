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

function makeService() {
  const initCalls: unknown[] = [];
  const service = new DesktopProductAnalyticsService({
    env: { COWORK_POSTHOG_KEY: "phc_test", COWORK_PRODUCT_ANALYTICS_ENABLED: "true" },
    appVersion: () => "1.2.23",
    isPackaged: () => true,
    platform: "win32",
    arch: "x64",
    generateAnonymousId: () => "anon_0123456789abcdef0123456789abcdef",
    // Injected rather than module-mocked: mock.module is process-global and
    // would follow this file into every later suite.
    initProductAnalyticsImpl: async (context) => {
      initCalls.push(context);
      return {
        initialized: false,
        reason: "disabled",
        enabled: false,
        keyConfigured: true,
      } as never;
    },
  });
  return { service, initCalls };
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
    const second = await service.applyPersistedState(first.state);

    expect(first.state).toBeDefined();
    expect(second.state).toBeDefined();
    expect(second.changed).toBe(false);
  });

  test("preserves the known installation identity when a caller omits analytics state", async () => {
    const { service } = makeService();
    const consented = makeState({
      privacyTelemetrySettings: { productAnalyticsEnabled: true },
    });
    const first = await service.applyPersistedState(consented);
    const second = await service.applyPersistedState(consented);

    expect(second.state.productAnalytics).toEqual(first.state.productAnalytics);
    expect(second.changed).toBe(true);
  });

  test("does not treat its own environment output as consent after a local opt-out", async () => {
    const env = {
      COWORK_POSTHOG_KEY: "phc_test",
      COWORK_TELEMETRY_MODE: "local-dev",
    };
    const enabledCalls: boolean[] = [];
    const service = new DesktopProductAnalyticsService({
      env,
      appVersion: () => "1.2.23",
      isPackaged: () => false,
      generateAnonymousId: () => "anon_0123456789abcdef0123456789abcdef",
      initProductAnalyticsImpl: async (context) => {
        enabledCalls.push(context.enabled);
        return {
          initialized: false,
          reason: "disabled",
          enabled: context.enabled,
          keyConfigured: true,
        } as never;
      },
    });
    const consented = await service.applyPersistedState(
      makeState({ privacyTelemetrySettings: { productAnalyticsEnabled: true } }),
    );
    await service.applyPersistedState({
      ...consented.state,
      privacyTelemetrySettings: { productAnalyticsEnabled: false },
    });
    await service.applyPersistedState(consented.state);

    expect(enabledCalls).toEqual([true, false, true]);
  });
});
