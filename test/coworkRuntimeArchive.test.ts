import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { extractRuntimeArchive, normalizeZipEntryName } from "../src/coworkRuntime";
import { S_IFLNK, S_IFREG, writeZip, type ZipFixtureEntry } from "./fixtures/zipBuilder";

const symlink = (name: string, data: string): ZipFixtureEntry => ({
  name,
  data,
  unixMode: S_IFLNK | 0o777,
});

async function withTmpDir<T>(fn: (dir: string, outDir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-runtime-zip-"));
  try {
    return await fn(dir, path.join(dir, "out"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("Cowork runtime ZIP extraction", () => {
  test("accepts normalized paths and rejects traversal or absolute paths", () => {
    expect(normalizeZipEntryName("dependencies/node/bin/node")).toBe("dependencies/node/bin/node");
    expect(normalizeZipEntryName("dependencies/node/")).toBe("dependencies/node");
    for (const unsafe of [
      "../escape.txt",
      "a/../../escape.txt",
      "foo/bar/../baz",
      "a/./b",
      "a//b",
      "/etc/passwd",
      "C:/Windows/x",
      "C:Windows",
      "c:foo",
      "foo\\..\\..\\outside",
      "foo\0bar",
      "",
      ".",
      "..",
    ]) {
      expect(() => normalizeZipEntryName(unsafe)).toThrow();
    }
  });

  test("streams stored and deflated files into a nested tree", async () => {
    await withTmpDir(async (dir, destinationDir) => {
      const archivePath = await writeZip(dir, [
        { name: "runtime.json", data: '{"ok":true}' },
        { name: "dependencies/", unixMode: 0o040755 },
        { name: "dependencies/node/bin/node", data: "binary", unixMode: S_IFREG | 0o755 },
        { name: "dependencies/readme.txt", data: "x".repeat(2048), deflate: true },
      ]);
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
    await withTmpDir(async (dir, destinationDir) => {
      const archivePath = await writeZip(dir, [{ name: "../escape.txt", data: "pwned" }]);
      await expect(extractRuntimeArchive({ archivePath, destinationDir })).rejects.toThrow(
        /relative path|ZIP entry/,
      );
      await expect(fs.stat(path.join(dir, "escape.txt"))).rejects.toThrow();
    });
  });

  test("rejects an escaping symlink target", async () => {
    await withTmpDir(async (dir, destinationDir) => {
      const archivePath = await writeZip(dir, [
        { name: "ok.txt", data: "fine" },
        symlink("evil-link", "/etc/passwd"),
      ]);
      await expect(extractRuntimeArchive({ archivePath, destinationDir })).rejects.toThrow(
        /symlink/i,
      );
    });
  });

  test("rejects invalid ZIP containers", async () => {
    await withTmpDir(async (dir, destinationDir) => {
      const archivePath = path.join(dir, "broken.zip");
      await fs.writeFile(archivePath, "not a zip");
      await expect(extractRuntimeArchive({ archivePath, destinationDir })).rejects.toThrow();
      await expect(fs.lstat(destinationDir)).rejects.toThrow();
    });
  });

  test("rejects chained symlink parents without writing outside staging", async () => {
    await withTmpDir(async (dir, destinationDir) => {
      const sentinel = path.join(dir, "keep.txt");
      await fs.writeFile(sentinel, "user data");
      const archivePath = await writeZip(dir, [
        symlink("a", "."),
        symlink("a/b", ".."),
        { name: "a/b/escape.txt", data: "escaped" },
      ]);
      await expect(extractRuntimeArchive({ archivePath, destinationDir })).rejects.toThrow();
      await expect(fs.lstat(path.join(dir, "escape.txt"))).rejects.toThrow();
      await expect(fs.lstat(destinationDir)).rejects.toThrow();
      expect(await fs.readFile(sentinel, "utf8")).toBe("user data");
    });
  });

  test.each([
    [
      "a symlink graph whose effective target escapes staging",
      [symlink("directory/root", ".."), symlink("escape", "directory/root/..")],
      /Symlink graph escapes/,
    ],
    [
      "cyclic forward symlinks before creating host links",
      [symlink("first", "second"), symlink("second", "first")],
      /Cyclic or excessive symlink graph/,
    ],
  ] as const)("rejects %s", async (_label, entries, pattern) => {
    await withTmpDir(async (dir, destinationDir) => {
      const archivePath = await writeZip(dir, [...entries]);
      await expect(extractRuntimeArchive({ archivePath, destinationDir })).rejects.toThrow(pattern);
      await expect(fs.lstat(destinationDir)).rejects.toThrow();
    });
  });

  test("preserves contained forward symlinks and directory aliases", async () => {
    await withTmpDir(async (dir, destinationDir) => {
      const archivePath = await writeZip(dir, [
        symlink("bin/tool", "../alias/tool"),
        symlink("alias", "payload"),
        { name: "payload/tool", data: "managed executable" },
      ]);
      await extractRuntimeArchive({ archivePath, destinationDir });
      expect(await fs.readFile(path.join(destinationDir, "bin", "tool"), "utf8")).toBe(
        "managed executable",
      );
      expect(await fs.readlink(path.join(destinationDir, "alias"))).toBe("payload");
    });
  });

  test("never cleans up a pre-existing destination", async () => {
    await withTmpDir(async (dir) => {
      const destinationDir = path.join(dir, "existing");
      await fs.mkdir(destinationDir);
      await fs.writeFile(path.join(destinationDir, "keep.txt"), "user data");
      const archivePath = await writeZip(dir, [{ name: "new.txt", data: "new" }]);
      await expect(extractRuntimeArchive({ archivePath, destinationDir })).rejects.toThrow();
      expect(await fs.readFile(path.join(destinationDir, "keep.txt"), "utf8")).toBe("user data");
    });
  });
});
