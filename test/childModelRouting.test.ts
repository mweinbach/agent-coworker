import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { normalizeChildRoutingConfig, parseChildModelRef } from "../src/models/childModelRouting";
import { upsertCustomModel } from "../src/providers/customModels";
import { getAiCoworkerPaths } from "../src/store/connections";

// Registered in the Baseten/Together static registries, so it is foreign to
// nvidia unless configured as a custom model in the session's auth home.
const CROSS_PROVIDER_ID = "zai-org/GLM-5";

describe("normalizeChildRoutingConfig", () => {
  test("cross-provider routing treats preferredChildModelRef as canonical", () => {
    const normalized = normalizeChildRoutingConfig({
      provider: "openai",
      model: "gpt-5.2",
      childModelRoutingMode: "cross-provider-allowlist",
      preferredChildModel: "gemini-3.1-pro-preview",
      preferredChildModelRef: "google:gemini-3.1-pro-preview",
      allowedChildModelRefs: ["google:gemini-3.1-pro-preview"],
      source: "test",
    });

    expect(normalized.preferredChildModel).toBe("gpt-5.2");
    expect(normalized.preferredChildModelRef).toBe("google:gemini-3.1-pro-preview");
    expect(normalized.allowedChildModelRefs).toEqual(["google:gemini-3.1-pro-preview"]);
  });

  test("same-provider routing still rejects foreign legacy preferred child model ids", () => {
    expect(() =>
      normalizeChildRoutingConfig({
        provider: "openai",
        model: "gpt-5.2",
        childModelRoutingMode: "same-provider",
        preferredChildModel: "gemini-3.1-pro-preview",
        source: "test",
      }),
    ).toThrow(
      'Unsupported test preferred child target "gemini-3.1-pro-preview" for provider openai',
    );
  });

  test("cross-provider routing falls back deterministically when the canonical ref is invalid", () => {
    const allowlisted = normalizeChildRoutingConfig({
      provider: "openai",
      model: "gpt-5.2",
      childModelRoutingMode: "cross-provider-allowlist",
      preferredChildModelRef: "not-a-valid-ref",
      allowedChildModelRefs: ["opencode-zen:glm-5", "google:gemini-3.1-pro-preview"],
      source: "test",
    });
    expect(allowlisted.preferredChildModelRef).toBe("opencode-zen:glm-5");

    const fallback = normalizeChildRoutingConfig({
      provider: "openai",
      model: "gpt-5.2",
      childModelRoutingMode: "cross-provider-allowlist",
      preferredChildModelRef: "not-a-valid-ref",
      source: "test",
    });
    expect(fallback.preferredChildModelRef).toBe("openai:gpt-5.2");
    expect(fallback.preferredChildModel).toBe("gpt-5.2");
  });

  test("same-provider parsing accepts model ids that contain colons", () => {
    const parsed = parseChildModelRef("amazon.nova-lite-v1:0", "bedrock", "test child model");
    expect(parsed.provider).toBe("bedrock");
    expect(parsed.modelId).toBe("amazon.nova-lite-v1:0");
    expect(parsed.ref).toBe("bedrock:amazon.nova-lite-v1:0");
    expect(parsed.explicitProvider).toBe(false);
  });
});

describe("normalizeChildRoutingConfig with a non-default auth home", () => {
  let homeWithStore: string;

  beforeAll(async () => {
    homeWithStore = await fs.mkdtemp(path.join(os.tmpdir(), "child-routing-custom-"));
    await upsertCustomModel(
      getAiCoworkerPaths({ homedir: homeWithStore }),
      "nvidia",
      CROSS_PROVIDER_ID,
    );
  });

  afterAll(async () => {
    await fs.rm(homeWithStore, { recursive: true, force: true });
  });

  test("accepts a configured custom cross-registry id when the session home is threaded", () => {
    const normalized = normalizeChildRoutingConfig({
      provider: "nvidia",
      model: CROSS_PROVIDER_ID,
      childModelRoutingMode: "same-provider",
      source: "test",
      home: homeWithStore,
    });
    expect(normalized.preferredChildModel).toBe(CROSS_PROVIDER_ID);
    expect(normalized.preferredChildModelRef).toBe(`nvidia:${CROSS_PROVIDER_ID}`);
  });

  test("rejects the same custom cross-registry id when the home is omitted (process home)", () => {
    expect(() =>
      normalizeChildRoutingConfig({
        provider: "nvidia",
        model: CROSS_PROVIDER_ID,
        childModelRoutingMode: "same-provider",
        source: "test",
      }),
    ).toThrow(/Unsupported model/);
  });
});
