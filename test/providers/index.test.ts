import { describe, expect, spyOn, test } from "bun:test";
import {
  defaultModelForProvider,
  getModelForProvider,
  getProviderKeyCandidates,
  PROVIDERS,
} from "../../src/providers";
import { makeConfig } from "./helpers";

describe("src/providers/index.ts", () => {
  describe("getModelForProvider", () => {
    test("calls createModel on the correct provider with correct arguments", () => {
      const config = makeConfig({ provider: "google" });
      const modelId = "gemini-pro";
      const savedKey = "test-key";

      // Spy on the provider's createModel method
      const createModelSpy = spyOn(PROVIDERS.google, "createModel");

      // Call the function
      getModelForProvider(config, modelId, savedKey);

      // Verify the spy was called with correct arguments
      expect(createModelSpy).toHaveBeenCalledTimes(1);
      expect(createModelSpy).toHaveBeenCalledWith({
        config,
        modelId,
        savedKey,
      });

      // Restore the spy
      createModelSpy.mockRestore();
    });

    test("works with different provider", () => {
      const config = makeConfig({ provider: "openai" });
      const modelId = "gpt-4";

      const createModelSpy = spyOn(PROVIDERS.openai, "createModel");

      getModelForProvider(config, modelId);

      expect(createModelSpy).toHaveBeenCalledTimes(1);
      expect(createModelSpy).toHaveBeenCalledWith({
        config,
        modelId,
        savedKey: undefined,
      });

      createModelSpy.mockRestore();
    });
  });

  describe("defaultModelForProvider", () => {
    test("returns correct default model for google", () => {
      expect(defaultModelForProvider("google")).toBe(PROVIDERS.google.defaultModel);
    });

    test("returns correct default model for openai", () => {
      expect(defaultModelForProvider("openai")).toBe(PROVIDERS.openai.defaultModel);
    });
  });

  describe("getProviderKeyCandidates", () => {
    test("returns correct key candidates for google", () => {
      expect(getProviderKeyCandidates("google")).toBe(PROVIDERS.google.keyCandidates);
    });

    test("returns correct key candidates for openai", () => {
      expect(getProviderKeyCandidates("openai")).toBe(PROVIDERS.openai.keyCandidates);
    });
  });
});
