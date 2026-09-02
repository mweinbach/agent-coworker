import { afterEach, describe, expect, test } from "bun:test";
import { resolveAntigravityApiKey } from "../../src/providers/apiKeyAuth";
import { GOOGLE_API_KEY_ENV_VARS, resolveGoogleApiKey } from "../../src/providers/googleApiKey";
import { resolveGoogleApiKey as resolveRuntimeGoogleApiKey } from "../../src/runtime/googleNative/client";

const savedGoogleEnv = Object.fromEntries(
  GOOGLE_API_KEY_ENV_VARS.map((key) => [key, process.env[key]]),
) as Partial<Record<(typeof GOOGLE_API_KEY_ENV_VARS)[number], string | undefined>>;

function restoreGoogleEnv() {
  for (const key of GOOGLE_API_KEY_ENV_VARS) {
    const saved = savedGoogleEnv[key];
    if (saved === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved;
    }
  }
}

function clearGoogleEnv() {
  for (const key of GOOGLE_API_KEY_ENV_VARS) {
    delete process.env[key];
  }
}

describe("providers/googleApiKey", () => {
  afterEach(() => {
    restoreGoogleEnv();
  });

  test("prefers saved Google keys before environment aliases", () => {
    expect(
      resolveGoogleApiKey({
        savedKey: " saved-google ",
        env: {
          GOOGLE_GENERATIVE_AI_API_KEY: "env-generative",
          GEMINI_API_KEY: "env-gemini",
          GOOGLE_API_KEY: "env-google",
        } as NodeJS.ProcessEnv,
      }),
    ).toBe("saved-google");
  });

  test("resolves Google environment aliases in canonical order", () => {
    const env = {
      GOOGLE_GENERATIVE_AI_API_KEY: " env-generative ",
      GEMINI_API_KEY: " env-gemini ",
      GOOGLE_API_KEY: " env-google ",
    } as NodeJS.ProcessEnv;
    expect(resolveGoogleApiKey({ env })).toBe("env-generative");

    delete env.GOOGLE_GENERATIVE_AI_API_KEY;
    expect(resolveGoogleApiKey({ env })).toBe("env-gemini");

    delete env.GEMINI_API_KEY;
    expect(resolveGoogleApiKey({ env })).toBe("env-google");
  });

  test("native runtime uses canonical aliases and prefers explicit keys", () => {
    clearGoogleEnv();
    process.env.GOOGLE_API_KEY = "env-google";
    process.env.GEMINI_API_KEY = "env-gemini";

    expect(resolveRuntimeGoogleApiKey(" saved-google ")).toBe("saved-google");
    expect(resolveRuntimeGoogleApiKey()).toBe("env-gemini");
    delete process.env.GEMINI_API_KEY;
    expect(resolveRuntimeGoogleApiKey()).toBe("env-google");
    delete process.env.GOOGLE_API_KEY;
    expect(() => resolveRuntimeGoogleApiKey()).toThrow("API key");
  });

  test("keeps Antigravity Gemini-first environment behavior", () => {
    clearGoogleEnv();
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "env-generative";
    process.env.GEMINI_API_KEY = "env-gemini";
    process.env.GOOGLE_API_KEY = "env-google";

    expect(resolveAntigravityApiKey()).toBe("env-gemini");
  });
});
