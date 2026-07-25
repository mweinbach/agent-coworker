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

const localLogLines: Array<Record<string, unknown>> = [];
mock.module("../electron/services/localLogs", () => ({
  writeLocalLog: (
    _file: string,
    _level: string,
    category: string,
    message: string,
    meta?: Record<string, unknown>,
  ) => {
    localLogLines.push({ category, message, meta });
  },
}));

const { DesktopProductAnalyticsService } = await import("../electron/services/productAnalytics");

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    version: 2,
    workspaces: [],
    threads: [],
    ...overrides,
  } as never;
}

describe("DesktopProductAnalyticsService.applyPersistedState", () => {
  beforeEach(() => {
    setElectronMockOverrides(electronMockOverrides);
    localLogLines.length = 0;
  });

  test("only re-applies when the analytics configuration actually changes", async () => {
    const service = new DesktopProductAnalyticsService({
      env: { COWORK_POSTHOG_KEY: "phc_test", COWORK_PRODUCT_ANALYTICS_ENABLED: "true" },
      appVersion: () => "1.2.23",
      isPackaged: () => true,
      platform: "win32",
      arch: "x64",
      generateAnonymousId: () => "anon_0123456789abcdef0123456789abcdef",
    });

    const consented = makeState({
      privacyTelemetrySettings: { productAnalyticsEnabled: true },
    });

    // The renderer persists desktop state several times a second; those saves
    // are identical as far as analytics is concerned.
    await service.applyPersistedState(consented);
    await service.applyPersistedState(
      makeState({ privacyTelemetrySettings: { productAnalyticsEnabled: true }, threads: [] }),
    );
    await service.applyPersistedState(consented);

    expect(localLogLines).toHaveLength(1);

    // Withdrawing consent is a real change and must be applied.
    await service.applyPersistedState(
      makeState({ privacyTelemetrySettings: { productAnalyticsEnabled: false } }),
    );

    expect(localLogLines).toHaveLength(2);
    expect(localLogLines.at(-1)).toMatchObject({ message: "product analytics status" });

    // Repeating the withdrawn-consent state stays quiet again.
    await service.applyPersistedState(
      makeState({ privacyTelemetrySettings: { productAnalyticsEnabled: false } }),
    );

    expect(localLogLines).toHaveLength(2);
  });

  test("still returns the prepared state on every call", async () => {
    const service = new DesktopProductAnalyticsService({
      env: { COWORK_POSTHOG_KEY: "phc_test", COWORK_PRODUCT_ANALYTICS_ENABLED: "true" },
      appVersion: () => "1.2.23",
      isPackaged: () => true,
      platform: "win32",
      arch: "x64",
      generateAnonymousId: () => "anon_0123456789abcdef0123456789abcdef",
    });

    const first = await service.applyPersistedState(makeState());
    const second = await service.applyPersistedState(makeState());

    expect(first.state).toBeDefined();
    expect(second.state).toBeDefined();
    expect(second.changed).toBe(false);
  });
});
