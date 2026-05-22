import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const documentsRoot = path.join(repoRoot, "skills/documents");

describe("documents skill manifest", () => {
  test("lists only existing bundled files", async () => {
    const manifestPath = path.join(documentsRoot, "manifest.txt");
    const manifest = (await fs.readFile(manifestPath, "utf8"))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    expect(manifest.length).toBeGreaterThan(20);

    for (const relativePath of manifest) {
      const absolutePath = path.join(documentsRoot, relativePath);
      const stat = await fs.stat(absolutePath);
      expect(stat.isFile()).toBe(true);
    }
  });
});
