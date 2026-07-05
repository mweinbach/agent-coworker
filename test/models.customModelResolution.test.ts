import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getKnownResolvedModelMetadata,
  isConfiguredCustomModelIdSync,
  normalizeModelIdForProvider,
} from "../src/models/metadata";
import { upsertCustomModel } from "../src/providers/customModels";
import { getAiCoworkerPaths } from "../src/store/connections";

// "zai-org/GLM-5" is registered in the Baseten and Together static registries,
// so it is provably foreign to nvidia unless configured as a custom model.
const CROSS_PROVIDER_ID = "zai-org/GLM-5";
const CUSTOM_ONLY_ID = "acme/experimental-model-1";
const BEDROCK_CUSTOM_ID = "us.acme.custom-bedrock-v1:0";

let homeWithStore: string;
let emptyHome: string;

beforeAll(async () => {
  homeWithStore = await fs.mkdtemp(path.join(os.tmpdir(), "custom-model-resolution-"));
  emptyHome = await fs.mkdtemp(path.join(os.tmpdir(), "custom-model-resolution-empty-"));
  const paths = getAiCoworkerPaths({ homedir: homeWithStore });
  await upsertCustomModel(paths, "nvidia", CROSS_PROVIDER_ID);
  await upsertCustomModel(paths, "anthropic", CUSTOM_ONLY_ID);
  await upsertCustomModel(paths, "bedrock", BEDROCK_CUSTOM_ID);
});

afterAll(async () => {
  await fs.rm(homeWithStore, { recursive: true, force: true });
  await fs.rm(emptyHome, { recursive: true, force: true });
});

describe("isConfiguredCustomModelIdSync", () => {
  test("finds configured ids and rejects everything else", () => {
    expect(
      isConfiguredCustomModelIdSync("nvidia", CROSS_PROVIDER_ID, { home: homeWithStore }),
    ).toBe(true);
    expect(
      isConfiguredCustomModelIdSync("nvidia", `  ${CROSS_PROVIDER_ID}  `, { home: homeWithStore }),
    ).toBe(true);
    expect(
      isConfiguredCustomModelIdSync("baseten", CROSS_PROVIDER_ID, { home: homeWithStore }),
    ).toBe(false);
    expect(isConfiguredCustomModelIdSync("nvidia", "other-model", { home: homeWithStore })).toBe(
      false,
    );
    expect(isConfiguredCustomModelIdSync("nvidia", CROSS_PROVIDER_ID, { home: emptyHome })).toBe(
      false,
    );
  });

  test("returns false for providers without custom model id support", () => {
    expect(
      isConfiguredCustomModelIdSync("lmstudio", CROSS_PROVIDER_ID, { home: homeWithStore }),
    ).toBe(false);
    expect(
      isConfiguredCustomModelIdSync("codex-cli", CROSS_PROVIDER_ID, { home: homeWithStore }),
    ).toBe(false);
  });
});

describe("normalizeModelIdForProvider with custom model ids", () => {
  test("accepts a configured custom id that is registered under another provider", () => {
    expect(
      normalizeModelIdForProvider("nvidia", CROSS_PROVIDER_ID, "model", { home: homeWithStore }),
    ).toBe(CROSS_PROVIDER_ID);
  });

  test("still rejects foreign ids that are not configured as custom models", () => {
    expect(() =>
      normalizeModelIdForProvider("nvidia", CROSS_PROVIDER_ID, "model", { home: emptyHome }),
    ).toThrow(/Unsupported model/);
    expect(() =>
      normalizeModelIdForProvider("minimax", CROSS_PROVIDER_ID, "model", { home: homeWithStore }),
    ).toThrow(/Unsupported model/);
  });
});

describe("getKnownResolvedModelMetadata with custom model ids", () => {
  test("resolves configured custom ids instead of migrating to the default", () => {
    const resolved = getKnownResolvedModelMetadata("anthropic", CUSTOM_ONLY_ID, {
      home: homeWithStore,
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.id).toBe(CUSTOM_ONLY_ID);
    expect(resolved?.provider).toBe("anthropic");
    expect(resolved?.source).toBe("dynamic");
  });

  test("resolves custom ids that are foreign to the provider's registry", () => {
    const resolved = getKnownResolvedModelMetadata("nvidia", CROSS_PROVIDER_ID, {
      home: homeWithStore,
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.id).toBe(CROSS_PROVIDER_ID);
    expect(resolved?.provider).toBe("nvidia");
  });

  test("returns null for unknown ids that are not configured", () => {
    expect(
      getKnownResolvedModelMetadata("anthropic", CUSTOM_ONLY_ID, { home: emptyHome }),
    ).toBeNull();
    expect(
      getKnownResolvedModelMetadata("nvidia", "not-configured-model", { home: homeWithStore }),
    ).toBeNull();
  });

  test("static registry models still resolve as static", () => {
    const resolved = getKnownResolvedModelMetadata("baseten", CROSS_PROVIDER_ID, {
      home: emptyHome,
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.source).toBe("static");
  });

  test("resolves configured bedrock custom ids missing from the snapshot", () => {
    const resolved = getKnownResolvedModelMetadata("bedrock", BEDROCK_CUSTOM_ID, {
      home: homeWithStore,
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.id).toBe(BEDROCK_CUSTOM_ID);
    expect(resolved?.provider).toBe("bedrock");

    expect(
      getKnownResolvedModelMetadata("bedrock", BEDROCK_CUSTOM_ID, { home: emptyHome }),
    ).toBeNull();
  });
});
