export const PUBLIC_TELEMETRY_ENV_KEYS = [
  "COWORK_SENTRY_DSN",
  "COWORK_POSTHOG_KEY",
  "COWORK_POSTHOG_HOST",
  "LANGFUSE_BASE_URL",
  "LANGFUSE_PUBLIC_KEY",
  "COWORK_DISABLE_NETWORK_TELEMETRY",
] as const;

export type PublicTelemetryEnvKey = (typeof PUBLIC_TELEMETRY_ENV_KEYS)[number];
export type PublicTelemetryEnv = Partial<Record<PublicTelemetryEnvKey, string>>;

declare global {
  // Defined by electron-vite for safe public build-time telemetry values only.
  var __COWORK_PUBLIC_TELEMETRY_ENV__: PublicTelemetryEnv | undefined;
}

export function pickPublicTelemetryEnv(env: NodeJS.ProcessEnv): PublicTelemetryEnv {
  const picked: PublicTelemetryEnv = {};

  for (const key of PUBLIC_TELEMETRY_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) {
      picked[key] = value;
    }
  }

  return picked;
}

export function applyPublicTelemetryEnv(
  target: NodeJS.ProcessEnv,
  source: PublicTelemetryEnv | undefined = globalThis.__COWORK_PUBLIC_TELEMETRY_ENV__,
): void {
  if (!source) {
    return;
  }

  for (const key of PUBLIC_TELEMETRY_ENV_KEYS) {
    if (target[key]) {
      continue;
    }

    const value = source[key]?.trim();
    if (value) {
      target[key] = value;
    }
  }
}
