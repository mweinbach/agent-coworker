import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config";
import { defaultModelForProvider, getModelForProvider } from "../../src/providers";
import { makeConfig, makeTmpDirs, withEnv } from "./helpers";

describe("Fire Pass provider", () => {
  test("defaults to Kimi K2.6 Turbo", () => {
    expect(defaultModelForProvider("firepass")).toBe("accounts/fireworks/routers/kimi-k2p6-turbo");
  });

  test("getModelForProvider creates Fire Pass model with saved key", async () => {
    const config = makeConfig({
      provider: "firepass",
      model: "accounts/fireworks/routers/kimi-k2p6-turbo",
      preferredChildModel: "accounts/fireworks/routers/kimi-k2p6-turbo",
    });
    const model = getModelForProvider(
      config,
      "accounts/fireworks/routers/kimi-k2p6-turbo",
      "firepass-key",
    ) as any;
    const headers = await model.config.headers();
    expect(model.modelId).toBe("accounts/fireworks/routers/kimi-k2p6-turbo");
    expect(model.provider).toBe("firepass.completions");
    expect(model.config.baseUrl).toBe("https://api.fireworks.ai/inference/v1");
    expect(headers.authorization).toBe("Bearer firepass-key");
  });

  test("loadConfig with firepass provider returns the default model", async () => {
    const { cwd, home } = await makeTmpDirs();
    await withEnv("AGENT_PROVIDER", "firepass", async () => {
      const cfg = await loadConfig({
        cwd,
        home,
      });
      expect(cfg.provider).toBe("firepass");
      expect(cfg.model).toBe("accounts/fireworks/routers/kimi-k2p6-turbo");
    });
  });
});
