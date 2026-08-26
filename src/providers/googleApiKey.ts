export const GOOGLE_API_KEY_ENV_VARS = [
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
] as const;

export function resolveGoogleApiKey(
  opts: { savedKey?: string; env?: NodeJS.ProcessEnv } = {},
): string | undefined {
  const savedKey = opts.savedKey?.trim();
  if (savedKey) return savedKey;

  const env = opts.env ?? process.env;
  for (const candidate of GOOGLE_API_KEY_ENV_VARS) {
    const value = env[candidate]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function googleApiKeyEnvVarList(): string {
  return GOOGLE_API_KEY_ENV_VARS.join(", ");
}
