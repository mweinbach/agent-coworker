import { describe, expect, test } from "bun:test";
import { fs, loadConfig, makeTmpDirs, path, writeJson } from "./config.harness";

describe("optional tool-calling configuration", () => {
  test("defaults off and merges independent user/project opt-ins", async () => {
    const { tmp, cwd, home } = await makeTmpDirs();
    try {
      expect((await loadConfig({ cwd, homedir: home })).toolCalling).toEqual({
        codeMode: false,
        deferredToolSearch: false,
      });
      await writeJson(path.join(home, ".cowork", "config", "config.json"), {
        toolCalling: { codeMode: true },
      });
      await writeJson(path.join(cwd, ".cowork", "config.json"), {
        toolCalling: { deferredToolSearch: true },
      });
      expect((await loadConfig({ cwd, homedir: home })).toolCalling).toEqual({
        codeMode: true,
        deferredToolSearch: true,
      });
      await writeJson(path.join(cwd, ".cowork", "config.json"), {
        toolCalling: { codeMode: false, deferredToolSearch: "true" },
      });
      expect((await loadConfig({ cwd, homedir: home })).toolCalling).toEqual({
        codeMode: false,
        deferredToolSearch: false,
      });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
