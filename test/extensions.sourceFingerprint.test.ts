import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { computeSourceRootHash, isSourceHash } from "../src/extensions/sourceFingerprint";

describe("computeSourceRootHash", () => {
  test("ignores Cowork metadata and transient files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "source-hash-ignored-"));
    try {
      await fs.mkdir(path.join(root, ".cowork-plugin"), { recursive: true });
      await fs.mkdir(path.join(root, ".codex-plugin"), { recursive: true });
      await fs.mkdir(path.join(root, ".git", "objects"), { recursive: true });
      await fs.writeFile(path.join(root, "SKILL.md"), "# Body\n", "utf-8");

      const before = await computeSourceRootHash(root);
      expect(isSourceHash(before)).toBe(true);

      await fs.writeFile(
        path.join(root, ".cowork-plugin", "install.json"),
        '{"marketplace":{"sourceHash":"sha256:ignored"}}\n',
        "utf-8",
      );
      await fs.writeFile(path.join(root, ".codex-plugin", "install.json"), "{}\n", "utf-8");
      await fs.writeFile(path.join(root, ".cowork-skill.json"), "{}\n", "utf-8");
      await fs.writeFile(path.join(root, ".DS_Store"), "ignored", "utf-8");
      await fs.writeFile(path.join(root, ".git", "config"), "ignored", "utf-8");
      await fs.writeFile(path.join(root, ".incoming-source"), "ignored", "utf-8");
      await fs.writeFile(path.join(root, ".backup-source"), "ignored", "utf-8");

      expect(await computeSourceRootHash(root)).toBe(before);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("changes when source contents change", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "source-hash-change-"));
    try {
      await fs.writeFile(path.join(root, "SKILL.md"), "# One\n", "utf-8");
      const before = await computeSourceRootHash(root);

      await fs.writeFile(path.join(root, "SKILL.md"), "# Two\n", "utf-8");

      expect(await computeSourceRootHash(root)).not.toBe(before);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
