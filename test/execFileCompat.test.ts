import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The nested `bun test` boots a full runner plus ~10 real child spawns with
// deliberate 100-400ms waits; the 5s default is too tight on slow Windows.
const NESTED_BUN_TEST_TIMEOUT_MS = 60_000;

test(
  "execFileCompat preserves child process capture and cancellation semantics",
  async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-exec-file-compat-"));
    const childTestPath = path.join(tempDir, "execFileCompat.child.test.ts");
    const fixtureUrl = pathToFileURL(
      path.join(import.meta.dir, "fixtures", "execFileCompatChild.ts"),
    ).href;

    await fs.writeFile(childTestPath, `import ${JSON.stringify(fixtureUrl)};\n`);

    try {
      const proc = Bun.spawn([process.execPath, "test", childTestPath], {
        cwd: os.tmpdir(),
        env: process.env,
        stdout: "inherit",
        stderr: "inherit",
        // Reap the nested `bun test` even if this outer test is torn down
        // abnormally (Bun's orphan reaper does not run on Windows).
        timeout: 55_000,
      });
      try {
        expect(await proc.exited).toBe(0);
      } finally {
        proc.kill();
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  },
  NESTED_BUN_TEST_TIMEOUT_MS,
);
