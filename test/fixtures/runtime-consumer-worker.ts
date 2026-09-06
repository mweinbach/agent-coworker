import fs from "node:fs/promises";
import path from "node:path";

import { withCoworkRuntimeBootstrapLock } from "../../src/coworkRuntime/bootstrapLock";
import {
  consumerLeaseTesting,
  retainRuntimeForProcess,
} from "../../src/coworkRuntime/consumerLease";

const [home, version, mode, keys] = process.argv.slice(2);
if (!home || !version || !mode) throw new Error("Expected home, version and mode.");

if (mode === "initialize") {
  await withCoworkRuntimeBootstrapLock({ home, version }, async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const root = path.join(home, ".cowork", "locks", "runtime-consumers");
    await fs.mkdir(root, { recursive: true });
    const database = new DatabaseSync(path.join(root, `${version}.sqlite`));
    try {
      // Interrupt the first initialization with its transaction/journal still
      // open. SQLite may defer writing the database pages until COMMIT.
      database.exec(`
        PRAGMA cache_size = 1;
        BEGIN IMMEDIATE;
        PRAGMA application_id = 1129796172;
        CREATE TABLE incomplete (data BLOB);
        INSERT INTO incomplete VALUES (zeroblob(65536));
      `);
      console.log("ready");
      await new Response(Bun.stdin.stream()).text();
    } finally {
      database.close();
    }
  });
} else if (mode === "prune") {
  const { pruneInstalledRuntimes } = await import("../../src/coworkRuntime/install");
  console.log(JSON.stringify(await pruneInstalledRuntimes(home)));
} else {
  let runtimeDir = path.join(home, ".cowork", "runtime", version);
  let node: string | undefined;
  if (mode === "lease") {
    await withCoworkRuntimeBootstrapLock({ home, version }, async (lock) => {
      await retainRuntimeForProcess(runtimeDir, lock);
    });
  } else {
    const trustedKeys = JSON.parse(keys ?? "{}");
    if (mode === "prepare") {
      // The turn environment path deliberately does not accept arbitrary trust
      // keys. Substitute a fixture signing root only in this isolated worker.
      const { mock } = await import("bun:test");
      mock.module("../../src/coworkRuntime/trustedKeys", () => ({
        TRUSTED_COWORK_RUNTIME_KEYS: trustedKeys,
      }));
    }
    const { ensureCoworkRuntimeReady, prepareCoworkRuntimeToolEnv } = await import(
      "../../src/coworkRuntime/ensureReady"
    );
    const env =
      mode === "prepare"
        ? await prepareCoworkRuntimeToolEnv({ homedir: home, env: {} })
        : (
            await ensureCoworkRuntimeReady({
              homedir: home,
              version,
              env: {},
              execute: false,
              allowNetwork: false,
              trustedKeys,
            })
          )?.runtimeEnv;
    if (!env?.COWORK_RUNTIME_DIR) throw new Error("Worker did not receive a runtime environment.");
    runtimeDir = env.COWORK_RUNTIME_DIR;
    node = env.COWORK_RUNTIME_NODE;
  }
  console.log("ready");
  await new Response(Bun.stdin.stream()).text();
  // Exercise a cached environment after the parent has installed newer
  // releases, rather than merely observing that lease metadata exists.
  console.log(node ? await fs.readFile(node, "utf8") : await fs.readdir(runtimeDir));
  consumerLeaseTesting.releaseAll();
}
