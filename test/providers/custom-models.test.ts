import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getAiCoworkerPaths } from "../../src/connect";
import {
  deleteCustomModel,
  readCustomModelStore,
  upsertCustomModel,
} from "../../src/providers/customModels";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

const tempHomes: string[] = [];

async function makeTempHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "custom-models-"));
  tempHomes.push(home);
  return home;
}

async function makeTempPaths() {
  return getAiCoworkerPaths({ homedir: await makeTempHome() });
}

afterEach(async () => {
  await Promise.all(
    tempHomes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })),
  );
});

describe("custom model store", () => {
  test("returns an empty store when the file does not exist", async () => {
    const paths = await makeTempPaths();
    const store = await readCustomModelStore(paths);
    expect(store.version).toBe(1);
    expect(store.providers).toEqual({});
  });

  test("upsert + delete round-trips entries per provider", async () => {
    const paths = await makeTempPaths();
    await upsertCustomModel(paths, "openai", "gpt-5.5-custom");
    await upsertCustomModel(paths, "together", "zai-org/GLM-5.2");

    let store = await readCustomModelStore(paths);
    expect(store.providers.openai?.map((entry) => entry.id)).toEqual(["gpt-5.5-custom"]);
    expect(store.providers.together?.map((entry) => entry.id)).toEqual(["zai-org/GLM-5.2"]);

    await deleteCustomModel(paths, "openai", "gpt-5.5-custom");
    store = await readCustomModelStore(paths);
    expect(store.providers.openai).toBeUndefined();
    expect(store.providers.together).toHaveLength(1);
  });

  test("rejects providers without custom model support", async () => {
    const paths = await makeTempPaths();
    await expect(upsertCustomModel(paths, "lmstudio", "some-model")).rejects.toThrow(
      "does not support custom model IDs",
    );
  });

  test("concurrent upserts within one process all survive", async () => {
    const paths = await makeTempPaths();
    const ids = Array.from({ length: 12 }, (_, index) => `model-${index}`);

    await Promise.all([
      ...ids.map((id) => upsertCustomModel(paths, "openai", id)),
      ...ids.map((id) => upsertCustomModel(paths, "together", `org/${id}`)),
    ]);

    const store = await readCustomModelStore(paths);
    expect(store.providers.openai?.map((entry) => entry.id).sort()).toEqual([...ids].sort());
    expect(store.providers.together?.map((entry) => entry.id).sort()).toEqual(
      ids.map((id) => `org/${id}`).sort(),
    );
  });

  test("concurrent upsert and delete do not lose unrelated entries", async () => {
    const paths = await makeTempPaths();
    await upsertCustomModel(paths, "openai", "keep-me");
    await upsertCustomModel(paths, "openai", "delete-me");

    await Promise.all([
      upsertCustomModel(paths, "openai", "added-concurrently"),
      deleteCustomModel(paths, "openai", "delete-me"),
    ]);

    const store = await readCustomModelStore(paths);
    expect(store.providers.openai?.map((entry) => entry.id).sort()).toEqual([
      "added-concurrently",
      "keep-me",
    ]);
  });

  test("concurrent upserts from two processes all survive", async () => {
    const home = await makeTempHome();
    const scriptPath = path.join(home, "upsert-worker.ts");
    await fs.writeFile(
      scriptPath,
      [
        `import { getAiCoworkerPaths } from ${JSON.stringify(path.join(REPO_ROOT, "src/connect.ts"))};`,
        `import { upsertCustomModel } from ${JSON.stringify(path.join(REPO_ROOT, "src/providers/customModels.ts"))};`,
        "const [home, prefix, countRaw] = process.argv.slice(2);",
        "if (!home || !prefix || !countRaw) throw new Error('usage: upsert-worker <home> <prefix> <count>');",
        "const paths = getAiCoworkerPaths({ homedir: home });",
        "await Promise.all(",
        "  Array.from({ length: Number(countRaw) }, (_, index) =>",
        "    upsertCustomModel(paths, 'openai', `${prefix}-${index}`),",
        "  ),",
        ");",
      ].join("\n"),
      "utf-8",
    );

    const perProcess = 6;
    const spawnWorker = (prefix: string) =>
      Bun.spawn({
        cmd: [process.execPath, "run", scriptPath, home, prefix, String(perProcess)],
        cwd: REPO_ROOT,
        stdout: "pipe",
        stderr: "pipe",
      });

    const workers = [spawnWorker("alpha"), spawnWorker("beta")];
    const exitCodes = await Promise.all(workers.map((worker) => worker.exited));
    for (const [index, worker] of workers.entries()) {
      if (exitCodes[index] !== 0) {
        const stderr = await new Response(worker.stderr).text();
        throw new Error(`worker ${index} failed (exit ${exitCodes[index]}): ${stderr}`);
      }
    }

    const paths = getAiCoworkerPaths({ homedir: home });
    const store = await readCustomModelStore(paths);
    const surviving = (store.providers.openai ?? []).map((entry) => entry.id).sort();
    const expected = ["alpha", "beta"]
      .flatMap((prefix) => Array.from({ length: perProcess }, (_, index) => `${prefix}-${index}`))
      .sort();
    expect(surviving).toEqual(expected);
  }, 30_000);
});
