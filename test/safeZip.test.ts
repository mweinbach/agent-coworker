import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { defaultExtractArchive } from "../src/artifactRuntime/archive";
import { defaultExtractZipArchive } from "../src/codexPrimaryRuntime/archive";
import {
  ArchiveExtractionError,
  classifyArchiveEntryPath,
  extractZipArchive,
} from "../src/utils/safeZip";
import { S_IFLNK, S_IFREG, writeZip } from "./fixtures/zipBuilder";

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-safezip-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("classifyArchiveEntryPath", () => {
  test("accepts plain nested paths", () => {
    expect(classifyArchiveEntryPath("node/bin/node")).toEqual({
      safe: true,
      segments: ["node", "bin", "node"],
    });
  });

  test("rejects POSIX absolute paths", () => {
    expect(classifyArchiveEntryPath("/etc/passwd").safe).toBe(false);
  });

  test("rejects Windows drive-absolute paths", () => {
    expect(classifyArchiveEntryPath("C:\\Windows\\system32").safe).toBe(false);
  });

  test("rejects UNC paths", () => {
    expect(classifyArchiveEntryPath("\\\\server\\share\\x").safe).toBe(false);
  });

  test("rejects parent traversal with either separator", () => {
    expect(classifyArchiveEntryPath("../escape.txt").safe).toBe(false);
    expect(classifyArchiveEntryPath("a/../../escape.txt").safe).toBe(false);
    expect(classifyArchiveEntryPath("..\\..\\escape.txt").safe).toBe(false);
  });

  test("rejects empty names", () => {
    expect(classifyArchiveEntryPath("").safe).toBe(false);
    expect(classifyArchiveEntryPath("./").safe).toBe(false);
  });
});

describe("extractZipArchive", () => {
  test("extracts stored and deflated files into a nested tree", async () => {
    await withTmpDir(async (dir) => {
      const archive = await writeZip(dir, [
        { name: "runtime.json", data: '{"ok":true}' },
        { name: "node/", unixMode: 0o040755 },
        { name: "node/bin/node", data: "binary", unixMode: S_IFREG | 0o755 },
        { name: "node/readme.txt", data: "x".repeat(2048), deflate: true },
      ]);
      const dest = path.join(dir, "out");
      await extractZipArchive(archive, dest);

      expect(await fs.readFile(path.join(dest, "runtime.json"), "utf8")).toBe('{"ok":true}');
      expect(await fs.readFile(path.join(dest, "node", "bin", "node"), "utf8")).toBe("binary");
      expect(await fs.readFile(path.join(dest, "node", "readme.txt"), "utf8")).toBe(
        "x".repeat(2048),
      );

      if (process.platform !== "win32") {
        const mode = (await fs.stat(path.join(dest, "node", "bin", "node"))).mode & 0o777;
        expect(mode & 0o111).not.toBe(0);
      }
    });
  });

  test("rejects an entry that uses parent traversal", async () => {
    await withTmpDir(async (dir) => {
      const archive = await writeZip(dir, [{ name: "../escape.txt", data: "pwned" }]);
      await expect(extractZipArchive(archive, path.join(dir, "out"))).rejects.toBeInstanceOf(
        ArchiveExtractionError,
      );
      await expect(fs.stat(path.join(dir, "escape.txt"))).rejects.toThrow();
    });
  });

  test("rejects an absolute-path entry", async () => {
    await withTmpDir(async (dir) => {
      const archive = await writeZip(dir, [{ name: "/tmp/cowork-escape.txt", data: "pwned" }]);
      await expect(extractZipArchive(archive, path.join(dir, "out"))).rejects.toBeInstanceOf(
        ArchiveExtractionError,
      );
    });
  });

  test("rejects a symlink entry and never materializes the link", async () => {
    await withTmpDir(async (dir) => {
      const archive = await writeZip(dir, [
        { name: "runtime.json", data: "{}" },
        { name: "evil-link", data: "/etc/passwd", unixMode: S_IFLNK | 0o777 },
      ]);
      const dest = path.join(dir, "out");
      await expect(extractZipArchive(archive, dest)).rejects.toThrow(/symlink/i);
      await expect(fs.lstat(path.join(dest, "evil-link"))).rejects.toThrow();
    });
  });

  test("rejects archives that are not valid ZIP containers", async () => {
    await withTmpDir(async (dir) => {
      const archive = path.join(dir, "broken.zip");
      await fs.writeFile(archive, Buffer.from("not a zip file at all"));
      await expect(extractZipArchive(archive, path.join(dir, "out"))).rejects.toBeInstanceOf(
        ArchiveExtractionError,
      );
    });
  });
});

describe("runtime bootstrap extractors delegate to the safe extractor", () => {
  test("artifact runtime defaultExtractArchive rejects traversal", async () => {
    await withTmpDir(async (dir) => {
      const archive = await writeZip(dir, [{ name: "../escape.txt", data: "pwned" }]);
      await expect(defaultExtractArchive(archive, path.join(dir, "out"))).rejects.toBeInstanceOf(
        ArchiveExtractionError,
      );
    });
  });

  test("codex primary runtime defaultExtractZipArchive rejects symlink entries", async () => {
    await withTmpDir(async (dir) => {
      const archive = await writeZip(dir, [
        { name: "ok.txt", data: "fine" },
        { name: "evil-link", data: "/etc/passwd", unixMode: S_IFLNK | 0o777 },
      ]);
      await expect(defaultExtractZipArchive(archive, path.join(dir, "out"))).rejects.toThrow(
        /symlink/i,
      );
    });
  });
});
