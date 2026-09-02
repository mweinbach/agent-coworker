import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config";
import { defaultModelForProvider } from "../../src/providers";
import { makeTmpDirs, withEnv } from "./helpers";

describe("Fire Pass provider", () => {
  test("defaults to Kimi K2.6 Turbo", () => {
    expect(defaultModelForProvider("firepass")).toBe("accounts/fireworks/routers/kimi-k2p6-turbo");
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
