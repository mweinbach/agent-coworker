import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { fileChangeVersionFromStat, readCappedFilePreview } from "../src/utils/filePreviewRead";

describe("file preview reads", () => {
  test("retries when the path is atomically replaced after its descriptor is read", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-preview-replacement-"));
    const filePath = path.join(dir, "preview.txt");
    const replacementPath = path.join(dir, "replacement.txt");
    await fs.writeFile(filePath, "old", "utf8");
    await fs.writeFile(replacementPath, "replacement", "utf8");
    let replaced = false;

    try {
      const preview = await readCappedFilePreview(filePath, 1_024, {
        beforePathVerification: async () => {
          if (replaced) return;
          replaced = true;
          await fs.rename(replacementPath, filePath);
        },
      });

      expect(new TextDecoder().decode(preview.bytes)).toBe("replacement");
      expect(preview.version.fingerprint).toBe(
        fileChangeVersionFromStat(await fs.stat(filePath)).fingerprint,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
