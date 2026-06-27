import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { extractRuntimeArchive, normalizeZipEntryName } from "../src/coworkRuntime";
import { S_IFLNK, S_IFREG, writeZip } from "./fixtures/zipBuilder";

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-runtime-zip-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("Cowork runtime ZIP extraction", () => {
  test("accepts normalized paths and rejects traversal or absolute paths", () => {
    expect(normalizeZipEntryName("dependencies/node/bin/node")).toBe("dependencies/node/bin/node");
    for (const unsafe of ["../escape.txt", "a/../../escape.txt", "/etc/passwd", "C:/Windows/x"]) {
      expect(() => normalizeZipEntryName(unsafe)).toThrow();
    }
  });

  test("streams stored and deflated files into a nested tree", async () => {
    await withTmpDir(async (dir) => {
      const archivePath = await writeZip(dir, [
        { name: "runtime.json", data: '{"ok":true}' },
        { name: "dependencies/", unixMode: 0o040755 },
        {
          name: "dependencies/node/bin/node",
          data: "binary",
          unixMode: S_IFREG | 0o755,
        },
        { name: "dependencies/readme.txt", data: "x".repeat(2048), deflate: true },
      ]);
      const destinationDir = path.join(dir, "out");
      await extractRuntimeArchive({ archivePath, destinationDir });
      expect(await fs.readFile(path.join(destinationDir, "runtime.json"), "utf8")).toBe(
        '{"ok":true}',
      );
      expect(
        await fs.readFile(path.join(destinationDir, "dependencies", "node", "bin", "node"), "utf8"),
      ).toBe("binary");
      expect(
        await fs.readFile(path.join(destinationDir, "dependencies", "readme.txt"), "utf8"),
      ).toBe("x".repeat(2048));
    });
  });

  test("rejects traversal without writing outside the destination", async () => {
    await withTmpDir(async (dir) => {
      const archivePath = await writeZip(dir, [{ name: "../escape.txt", data: "pwned" }]);
      await expect(
        extractRuntimeArchive({ archivePath, destinationDir: path.join(dir, "out") }),
      ).rejects.toThrow(/relative path|ZIP entry/);
      await expect(fs.stat(path.join(dir, "escape.txt"))).rejects.toThrow();
    });
  });

  test("rejects an escaping symlink target", async () => {
    await withTmpDir(async (dir) => {
      const archivePath = await writeZip(dir, [
        { name: "ok.txt", data: "fine" },
        { name: "evil-link", data: "/etc/passwd", unixMode: S_IFLNK | 0o777 },
      ]);
      await expect(
        extractRuntimeArchive({ archivePath, destinationDir: path.join(dir, "out") }),
      ).rejects.toThrow(/symlink/i);
    });
  });

  test("rejects invalid ZIP containers", async () => {
    await withTmpDir(async (dir) => {
      const archivePath = path.join(dir, "broken.zip");
      await fs.writeFile(archivePath, "not a zip");
      await expect(
        extractRuntimeArchive({ archivePath, destinationDir: path.join(dir, "out") }),
      ).rejects.toThrow();
    });
  });
});
