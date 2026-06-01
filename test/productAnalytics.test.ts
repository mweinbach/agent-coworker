import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  __internal,
  captureProductEvent,
  initProductAnalytics,
  type ProductAnalyticsClient,
  type ProductAnalyticsSdkModule,
} from "../src/telemetry/productAnalytics";

type CapturedEvent = Parameters<ProductAnalyticsClient["capture"]>[0];

function createFakePostHogModule(captures: CapturedEvent[]): ProductAnalyticsSdkModule {
  class FakePostHog implements ProductAnalyticsClient {
    readonly capture = mock((event: CapturedEvent) => {
      captures.push(event);
    });
    readonly shutdown = mock(async () => {});
  }

  return { PostHog: FakePostHog };
}

describe("product analytics wrapper", () => {
  afterEach(async () => {
    await __internal.resetProductAnalyticsForTests();
  });

  test("disabled mode does not load the PostHog SDK", async () => {
    let loaderCalls = 0;
    const status = await initProductAnalytics({
      enabled: false,
      apiKey: "phc_test",
      anonymousId: "anon_1234567890123456",
      loadSdk: async () => {
        loaderCalls += 1;
        return createFakePostHogModule([]);
      },
    });

    expect(status.initialized).toBe(false);
    expect(status.reason).toBe("disabled");
    expect(loaderCalls).toBe(0);
  });

  test("missing key leaves analytics as a no-op without loading the SDK", async () => {
    let loaderCalls = 0;
    const status = await initProductAnalytics({
      enabled: true,
      anonymousId: "anon_1234567890123456",
      env: {},
      loadSdk: async () => {
        loaderCalls += 1;
        return createFakePostHogModule([]);
      },
    });

    expect(status.initialized).toBe(false);
    expect(status.reason).toBe("not_configured");
    expect(loaderCalls).toBe(0);
  });

  test("captures anonymous events with no person profile and no feature flags", async () => {
    const captures: CapturedEvent[] = [];
    const status = await initProductAnalytics({
      enabled: true,
      apiKey: "phc_test",
      anonymousId: "anon_1234567890123456",
      appVersion: "1.2.3",
      environment: "production",
      eventSource: "server",
      platform: "darwin",
      arch: "arm64",
      packaged: true,
      loadSdk: async () => createFakePostHogModule(captures),
    });

    expect(status.initialized).toBe(true);
    captureProductEvent("app_started", {
      workspaceCount: 2,
      productAnalyticsEnabled: true,
    });
    await __internal.flushProductAnalyticsQueueForTests();

    expect(captures).toHaveLength(1);
    expect(captures[0]).toEqual({
      distinctId: "anon_1234567890123456",
      event: "app_started",
      properties: {
        appVersion: "1.2.3",
        platform: "darwin",
        arch: "arm64",
        packaged: true,
        environment: "production",
        eventSource: "server",
        workspaceCount: 2,
        productAnalyticsEnabled: true,
        $process_person_profile: false,
      },
      disableGeoip: true,
      sendFeatureFlags: false,
    });
  });

  test("sanitizer rejects disallowed property names", () => {
    const disallowedProperties = [
      { prompt: "hello" },
      { response: "hi" },
      { transcript: "words" },
      { fileName: "secret.txt" },
      { path: "/Users/alice/project" },
      { repoName: "private-repo" },
      { command: "rm -rf" },
      { stdout: "output" },
      { stderr: "error" },
      { apiKey: "sk-test" },
      { email: "alice@example.com" },
      { username: "alice" },
      { providerKey: "secret" },
    ];

    for (const properties of disallowedProperties) {
      expect(__internal.sanitizeProductEvent("app_started", properties).ok).toBe(false);
    }
  });

  test("sanitizer caps values and limits strings", () => {
    const result = __internal.sanitizeProductEvent("turn_completed", {
      durationMs: Number.MAX_SAFE_INTEGER,
      toolCount: 10_000_000,
      status: `completed_${"a".repeat(500)}`,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.properties.durationMs).toBe(604_800_000);
    expect(result.event.properties.toolCount).toBe(1_000_000);
    expect(String(result.event.properties.status).length).toBeLessThanOrEqual(64);
  });

  test("sanitizer blocks path-looking values", () => {
    const pathValues = [
      "/Users/alice/Projects/app",
      "/tmp/cowork.log",
      "C:\\Users\\alice\\repo\\file.ts",
      "file:///Users/alice/file.txt",
      "~/Projects/app",
      "../relative/file.txt",
      "src/server/index.ts",
    ];

    for (const value of pathValues) {
      const result = __internal.sanitizeProductEvent("turn_failed", {
        status: "failed",
        errorCategory: value,
      });
      expect(result.ok).toBe(false);
    }
  });

  test("sanitizer rejects emails and secret-looking values", () => {
    expect(
      __internal.sanitizeProductEvent("provider_auth_failed", {
        provider: "openai",
        errorCategory: "alice@example.com",
      }).ok,
    ).toBe(false);
    expect(
      __internal.sanitizeProductEvent("provider_auth_failed", {
        provider: "openai",
        errorCategory: "sk-1234567890abcdef1234567890abcdef",
      }).ok,
    ).toBe(false);
  });

  test("model ids allow visible hosted ids and reject local paths", () => {
    expect(
      __internal.sanitizeProductEvent("turn_started", {
        provider: "anthropic",
        model: "anthropic/claude-sonnet-4.5",
      }).ok,
    ).toBe(true);
    expect(
      __internal.sanitizeProductEvent("turn_started", {
        provider: "lmstudio",
        model: "/Users/alice/models/local.gguf",
      }).ok,
    ).toBe(false);
  });

  test("bounded queue drops excess events without throwing", async () => {
    const captures: CapturedEvent[] = [];
    await initProductAnalytics({
      enabled: true,
      apiKey: "phc_test",
      anonymousId: "anon_1234567890123456",
      loadSdk: async () => createFakePostHogModule(captures),
    });

    for (let index = 0; index < 125; index += 1) {
      captureProductEvent("update_checked", {
        status: "ok",
        durationMs: index,
      });
    }
    await __internal.flushProductAnalyticsQueueForTests();

    expect(captures).toHaveLength(100);
    expect(captures[0]?.properties?.durationMs).toBe(25);
    expect(captures.at(-1)?.properties?.durationMs).toBe(124);
  });
});
