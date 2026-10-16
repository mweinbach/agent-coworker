import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { extractRuntimeArchive } from "../src/coworkRuntime";
import { hostPlatform } from "../src/platform/host";
import { scratchRoots } from "../src/platform/sandbox/policy";
import { S_IFREG, writeZip } from "./fixtures/zipBuilder";

const S_IFIFO = 0o010000;

async function withTmpDir<T>(fn: (dir: string, destinationDir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(scratchRoots()[0] ?? "/tmp", "cowork-runtime-zip-limit-"));
  try {
    return await fn(dir, path.join(dir, "out"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("Cowork runtime ZIP extraction limits", () => {
  test("accepts an archive that sits exactly on the entry and unpacked-byte limits", async () => {
    await withTmpDir(async (dir, destinationDir) => {
      const archivePath = await writeZip(dir, [
        { name: "a.txt", data: "abcd" },
        { name: "b.txt", data: "efgh" },
      ]);
      await extractRuntimeArchive({
        archivePath,
        destinationDir,
        maxEntries: 2,
        maxUnpackedBytes: 8,
      });
      expect(await fs.readFile(path.join(destinationDir, "a.txt"), "utf8")).toBe("abcd");
      expect(await fs.readFile(path.join(destinationDir, "b.txt"), "utf8")).toBe("efgh");
    });
  });

  test("rejects one entry past the limit and removes the partial destination", async () => {
    await withTmpDir(async (dir, destinationDir) => {
      const sentinel = path.join(dir, "keep.txt");
      await fs.writeFile(sentinel, "user data");
      const archivePath = await writeZip(dir, [
        { name: "a.txt", data: "a" },
        { name: "b.txt", data: "b" },
        { name: "c.txt", data: "c" },
      ]);
      await expect(
        extractRuntimeArchive({ archivePath, destinationDir, maxEntries: 2 }),
      ).rejects.toThrow(/ZIP archive exceeds the entry limit \(3\)/);
      await expect(fs.lstat(destinationDir)).rejects.toThrow();
      expect(await fs.readFile(sentinel, "utf8")).toBe("user data");
    });
  });

  test("rejects an archive whose declared unpacked size exceeds the byte limit", async () => {
    await withTmpDir(async (dir, destinationDir) => {
      const archivePath = await writeZip(dir, [{ name: "big.txt", data: "x".repeat(20) }]);
      await expect(
        extractRuntimeArchive({
          archivePath,
          destinationDir,
          maxUnpackedBytes: 10,
        }),
      ).rejects.toThrow(/ZIP archive exceeds the unpacked size limit \(20 bytes\)/);
      await expect(fs.lstat(destinationDir)).rejects.toThrow();
    });
  });

  test("rejects a repeated normalized name and an unsupported unix file type", async () => {
    await withTmpDir(async (dir, destinationDir) => {
      const duplicatePath = await writeZip(dir, [
        { name: "pkg/", unixMode: 0o040755 },
        { name: "pkg", data: "not-a-directory" },
      ]);
      await expect(
        extractRuntimeArchive({ archivePath: duplicatePath, destinationDir }),
      ).rejects.toThrow("Duplicate ZIP entry: pkg");
      await expect(fs.lstat(destinationDir)).rejects.toThrow();

      const fifoDir = path.join(dir, "fifo-out");
      const fifoPath = await writeZip(dir, [
        { name: "pipe", data: "x", unixMode: S_IFIFO | 0o644 },
      ]);
      await expect(
        extractRuntimeArchive({ archivePath: fifoPath, destinationDir: fifoDir }),
      ).rejects.toThrow("Unsupported ZIP entry type: pipe");
      await expect(fs.lstat(fifoDir)).rejects.toThrow();
    });
  });

  test("keeps case-distinct names on case-sensitive hosts and folds them on Windows", async () => {
    await withTmpDir(async (dir, destinationDir) => {
      const archivePath = await writeZip(dir, [
        { name: "A.txt", data: "upper", unixMode: S_IFREG | 0o644 },
        { name: "a.txt", data: "lower", unixMode: S_IFREG | 0o644 },
      ]);
      if (hostPlatform() === "win32") {
        await expect(extractRuntimeArchive({ archivePath, destinationDir })).rejects.toThrow(
          "Duplicate ZIP entry: a.txt",
        );
        await expect(fs.lstat(destinationDir)).rejects.toThrow();
        return;
      }
      await extractRuntimeArchive({ archivePath, destinationDir });
      expect(await fs.readFile(path.join(destinationDir, "A.txt"), "utf8")).toBe("upper");
      expect(await fs.readFile(path.join(destinationDir, "a.txt"), "utf8")).toBe("lower");
    });
  });
});
