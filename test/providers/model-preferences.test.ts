import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getAiCoworkerPaths } from "../../src/connect";
import {
  readModelPreferencesStore,
  resetModelPreferences,
  setModelPreferences,
  writeModelPreferencesStore,
} from "../../src/providers/modelPreferences";

const tempHomes: string[] = [];

async function makeTempPaths() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "model-preferences-"));
  tempHomes.push(home);
  return getAiCoworkerPaths({ homedir: home });
}

afterEach(async () => {
  await Promise.all(
    tempHomes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })),
  );
});

describe("model preferences store", () => {
  test("returns an empty store when the file does not exist", async () => {
    const paths = await makeTempPaths();
    const store = await readModelPreferencesStore(paths);
    expect(store.version).toBe(1);
    expect(store.providers).toEqual({});
  });

  test("set + read round-trips overrides per provider", async () => {
    const paths = await makeTempPaths();
    await setModelPreferences(paths, "together", [
      { id: "zai-org/GLM-5.2", enabled: false },
      { id: "moonshotai/Kimi-K2.6", enabled: true },
    ]);

    const store = await readModelPreferencesStore(paths);
    expect(store.providers.together).toEqual([
      expect.objectContaining({ id: "moonshotai/Kimi-K2.6", enabled: true }),
      expect.objectContaining({ id: "zai-org/GLM-5.2", enabled: false }),
    ]);
  });

  test("set upserts existing overrides and trims model ids", async () => {
    const paths = await makeTempPaths();
    await setModelPreferences(paths, "openai", [{ id: "gpt-5.5", enabled: false }]);
    await setModelPreferences(paths, "openai", [{ id: "  gpt-5.5  ", enabled: true }]);

    const store = await readModelPreferencesStore(paths);
    expect(store.providers.openai).toHaveLength(1);
    expect(store.providers.openai?.[0]).toMatchObject({ id: "gpt-5.5", enabled: true });
  });

  test("rejects providers without model preference support", async () => {
    const paths = await makeTempPaths();
    await expect(setModelPreferences(paths, "lmstudio", [{ id: "x", enabled: false }])).rejects.toThrow(
      "does not support model preferences",
    );
    await expect(resetModelPreferences(paths, "lmstudio")).rejects.toThrow(
      "does not support model preferences",
    );
  });

  test("reset removes only the targeted provider", async () => {
    const paths = await makeTempPaths();
    await setModelPreferences(paths, "together", [{ id: "a/b", enabled: false }]);
    await setModelPreferences(paths, "openai", [{ id: "gpt-5.5", enabled: false }]);

    await resetModelPreferences(paths, "together");

    const store = await readModelPreferencesStore(paths);
    expect(store.providers.together).toBeUndefined();
    expect(store.providers.openai).toHaveLength(1);
  });

  test("invalid JSON falls back to an empty store", async () => {
    const paths = await makeTempPaths();
    await writeModelPreferencesStore(paths, {
      version: 1,
      updatedAt: new Date().toISOString(),
      providers: {},
    });
    await fs.writeFile(path.join(paths.configDir, "model-preferences.json"), "{nope", "utf-8");

    const store = await readModelPreferencesStore(paths);
    expect(store.providers).toEqual({});
  });

  test("unknown providers and malformed entries are dropped on read", async () => {
    const paths = await makeTempPaths();
    const filePath = path.join(paths.configDir, "model-preferences.json");
    await writeModelPreferencesStore(paths, {
      version: 1,
      updatedAt: new Date().toISOString(),
      providers: {},
    });
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        providers: {
          lmstudio: [{ id: "local-model", enabled: false, updatedAt: new Date().toISOString() }],
          together: [
            { id: "ok/model", enabled: false, updatedAt: new Date().toISOString() },
            { id: "bad\u0000id", enabled: false, updatedAt: new Date().toISOString() },
          ],
        },
      }),
      "utf-8",
    );

    const store = await readModelPreferencesStore(paths);
    expect(Object.keys(store.providers)).toEqual(["together"]);
    expect(store.providers.together?.map((entry) => entry.id)).toEqual(["ok/model"]);
  });
});
