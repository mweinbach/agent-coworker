import fs from "node:fs/promises";
import path from "node:path";

import { withCoworkRuntimeBootstrapLock } from "../../src/coworkRuntime/bootstrapLock";

const [home, workerId] = process.argv.slice(2);
if (!home || !workerId) throw new Error("Expected runtime lock worker home and id");

await withCoworkRuntimeBootstrapLock({ home, version: "2026-06-22", retryDelayMs: 5 }, async () => {
  const activePath = path.join(home, "active-worker");
  await fs.writeFile(activePath, workerId, { flag: "wx" });
  try {
    await Bun.sleep(50);
  } finally {
    await fs.rm(activePath, { force: true });
  }
});
