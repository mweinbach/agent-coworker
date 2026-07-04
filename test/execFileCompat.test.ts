import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

test("execFileCompat preserves child process capture and cancellation semantics", async () => {
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
    });
    expect(await proc.exited).toBe(0);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
