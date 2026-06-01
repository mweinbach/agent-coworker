import { describe, expect, test } from "bun:test";

import {
  applyPublicTelemetryEnv,
  PUBLIC_TELEMETRY_ENV_KEYS,
  pickPublicTelemetryEnv,
} from "../electron/services/publicTelemetryEnv";

describe("public telemetry env", () => {
  test("picks only public Sentry, PostHog, and Langfuse build values", () => {
    const picked = pickPublicTelemetryEnv({
      COWORK_SENTRY_DSN: " https://public@sentry.example/1 ",
      COWORK_POSTHOG_KEY: " phc_public ",
      COWORK_POSTHOG_HOST: " https://us.posthog.com ",
      LANGFUSE_BASE_URL: " https://us.cloud.langfuse.com ",
      LANGFUSE_PUBLIC_KEY: " pk-lf-public ",
      COWORK_DISABLE_NETWORK_TELEMETRY: "1",
      LANGFUSE_SECRET_KEY: "sk-lf-secret",
      COWORK_DIAGNOSTICS_UPLOAD_URL: "https://diagnostics.example/upload",
      COWORK_CLOUD_SYNC_ENDPOINT: "https://sync.example/v1",
    });

    expect(Object.keys(picked).sort()).toEqual([...PUBLIC_TELEMETRY_ENV_KEYS].sort());
    expect(picked.COWORK_SENTRY_DSN).toBe("https://public@sentry.example/1");
    expect(picked.COWORK_POSTHOG_KEY).toBe("phc_public");
    expect(picked.COWORK_POSTHOG_HOST).toBe("https://us.posthog.com");
    expect(picked.LANGFUSE_BASE_URL).toBe("https://us.cloud.langfuse.com");
    expect(picked.LANGFUSE_PUBLIC_KEY).toBe("pk-lf-public");
    expect(picked.COWORK_DISABLE_NETWORK_TELEMETRY).toBe("1");
    expect("LANGFUSE_SECRET_KEY" in picked).toBe(false);
    expect("COWORK_DIAGNOSTICS_UPLOAD_URL" in picked).toBe(false);
    expect("COWORK_CLOUD_SYNC_ENDPOINT" in picked).toBe(false);
  });

  test("applies build values without overriding runtime environment", () => {
    const target: NodeJS.ProcessEnv = {
      COWORK_POSTHOG_KEY: "runtime-posthog-key",
    };

    applyPublicTelemetryEnv(target, {
      COWORK_SENTRY_DSN: "https://public@sentry.example/1",
      COWORK_POSTHOG_KEY: "build-posthog-key",
      LANGFUSE_PUBLIC_KEY: "pk-lf-public",
    });

    expect(target.COWORK_SENTRY_DSN).toBe("https://public@sentry.example/1");
    expect(target.COWORK_POSTHOG_KEY).toBe("runtime-posthog-key");
    expect(target.LANGFUSE_PUBLIC_KEY).toBe("pk-lf-public");
  });
});
