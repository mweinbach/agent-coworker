import {
  fs,
  loadConfig,
  makeTmpDirs,
  os,
  path,
  repoRoot,
  withEnv,
  withMockedFetch,
  writeJson,
} from "./config.harness";
import { describe, expect, mock, test } from "bun:test";
import { defaultModelForProvider, getModel } from "../../src/config";
import { PROVIDER_MODEL_CATALOG } from "../../src/providers";

describe("defaultModelForProvider", () => {
  for (const providerName of Object.keys(
    PROVIDER_MODEL_CATALOG,
  ) as (keyof typeof PROVIDER_MODEL_CATALOG)[]) {
    test(`returns correct default for ${providerName}`, () => {
      expect(defaultModelForProvider(providerName)).toBe(
        PROVIDER_MODEL_CATALOG[providerName].defaultModel,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Helper functions (tested indirectly through loadConfig behavior)
// ---------------------------------------------------------------------------
