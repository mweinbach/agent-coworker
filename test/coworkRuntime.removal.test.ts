import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { pruneInstalledRuntimes } from "../src/coworkRuntime/install";
import { hostPlatform } from "../src/platform/host";
import { scratchRoots } from "../src/platform/sandbox/policy";

const homes: string[] = [];

async function restoreWriteBits(dir: string): Promise<void> {
  const stat = await fs.lstat(dir).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return;
  await fs.chmod(dir, (stat.mode & 0o777) | 0o700).catch(() => undefined);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory()) await restoreWriteBits(path.join(dir, entry.name));
  }
}

afterEach(async () => {
  await Promise.all(
    homes.splice(0).map(async (home) => {
      await restoreWriteBits(home);
      await fs.rm(home, { recursive: true, force: true });
    }),
  );
});

describe("Cowork runtime tree removal", () => {
  test.skipIf(hostPlatform() === "win32")(
    "prunes sealed runtime directories without following an escape symlink",
    async () => {
      const home = await fs.mkdtemp(path.join(scratchRoots()[0]!, "cowork-runtime-removal-"));
      homes.push(home);
      const runtimeRoot = path.join(home, ".cowork", "runtime");
      const expired = path.join(runtimeRoot, "2026-01-01");
      const sealed = path.join(expired, "sealed");
      const deeper = path.join(sealed, "deeper");
      const outside = path.join(home, "outside");
      await fs.mkdir(deeper, { recursive: true });
      await fs.mkdir(path.join(runtimeRoot, "2026-01-02"), { recursive: true });
      await fs.mkdir(path.join(runtimeRoot, "2026-01-03"), { recursive: true });
      await fs.writeFile(path.join(deeper, "note.txt"), "signed payload");
      await fs.writeFile(path.join(expired, "readme.txt"), "keep");
      await fs.chmod(path.join(expired, "readme.txt"), 0o444);
      await fs.chmod(deeper, 0o000);
      await fs.chmod(sealed, 0o555);
      await fs.mkdir(outside, { recursive: true });
      await fs.writeFile(path.join(outside, "sentinel.txt"), "do not touch");
      await fs.chmod(outside, 0o500);
      const outsideMode = (await fs.lstat(outside)).mode & 0o777;
      await fs.symlink(outside, path.join(expired, "escape"));
      await fs.writeFile(
        path.join(runtimeRoot, "current.json"),
        `${JSON.stringify({ schemaVersion: 1, version: "2026-01-03" })}\n`,
      );

      expect((await pruneInstalledRuntimes(home)).map((entry) => entry.version)).toEqual([
        "2026-01-01",
      ]);

      await expect(fs.lstat(expired)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(path.join(outside, "sentinel.txt"), "utf8")).toBe("do not touch");
      expect((await fs.lstat(outside)).mode & 0o777).toBe(outsideMode);
      expect(await fs.readdir(path.join(runtimeRoot, "2026-01-02"))).toEqual([]);
      expect(await fs.readdir(path.join(runtimeRoot, "2026-01-03"))).toEqual([]);
    },
  );
});
