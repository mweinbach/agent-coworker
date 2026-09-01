import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { symlink } from "../src/platform/fs";
import { canonicalizeSync } from "../src/platform/paths";
import { scratchRoots } from "../src/platform/sandbox";
import {
  fileChangeVersionFromStat,
  openAuthorizedFile,
  readCappedFilePreview,
} from "../src/utils/filePreviewRead";

async function withPreviewFiles(
  run: (files: { filePath: string; outsidePath: string }) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(scratchRoots()[0] ?? "/tmp", "cowork-preview-open-"));
  try {
    const filePath = path.join(dir, "inside.txt");
    const outsidePath = path.join(dir, "outside.txt");
    await fs.writeFile(filePath, "inside", "utf8");
    await fs.writeFile(outsidePath, "outside", "utf8");
    await run({ filePath, outsidePath });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("authorized file opening", () => {
  test("returns a regular descriptor owned by the caller", async () => {
    await withPreviewFiles(async ({ filePath }) => {
      const { handle, stat } = await openAuthorizedFile(filePath, {
        expectedCanonicalPath: canonicalizeSync(filePath),
      });
      try {
        expect(stat.isFile()).toBe(true);
        expect(await handle.readFile("utf8")).toBe("inside");
      } finally {
        await handle.close();
      }
    });
  });

  test("rejects and closes a descriptor that does not match the authorized pathname", async () => {
    await withPreviewFiles(async ({ filePath, outsidePath }) => {
      const redirectedHandle = await fs.open(outsidePath, "r");
      const openSpy = spyOn(fs, "open").mockResolvedValueOnce(redirectedHandle);
      try {
        await expect(
          openAuthorizedFile(filePath, { expectedCanonicalPath: canonicalizeSync(filePath) }),
        ).rejects.toThrow("changed");
        await expect(redirectedHandle.stat()).rejects.toThrow();
      } finally {
        openSpy.mockRestore();
        await redirectedHandle.close().catch(() => {});
      }
    });
  });

  test("rejects and closes an opened non-regular file", async () => {
    await withPreviewFiles(async ({ filePath }) => {
      const handle = await fs.open(filePath, "r");
      const stat = await handle.stat();
      const statSpy = spyOn(handle, "stat").mockResolvedValueOnce(
        Object.assign(stat, { isFile: () => false }),
      );
      const openSpy = spyOn(fs, "open").mockResolvedValueOnce(handle);
      try {
        await expect(
          openAuthorizedFile(filePath, { expectedCanonicalPath: canonicalizeSync(filePath) }),
        ).rejects.toThrow("not a file");
        await expect(handle.stat()).rejects.toThrow();
      } finally {
        openSpy.mockRestore();
        statSpy.mockRestore();
        await handle.close().catch(() => {});
      }
    });
  });
});

describe("file preview reads", () => {
  test.each(["mtimeMs", "ctimeMs"] as const)(
    "distinguishes same-size revisions with sub-millisecond %s changes",
    (timestamp) => {
      const stat = { mtimeMs: 1_000.1, ctimeMs: 2_000.1, size: 3, dev: 1, ino: 2 };
      const before = fileChangeVersionFromStat(stat);
      const after = fileChangeVersionFromStat({ ...stat, [timestamp]: stat[timestamp] + 0.1 });

      expect(after.fingerprint).not.toBe(before.fingerprint);
    },
  );

  test.each(["before-open", "before-verification"] as const)(
    "rejects an authorized ancestor replacement %s",
    async (replacementPhase) => {
      const dir = await fs.mkdtemp(
        path.join(scratchRoots()[0] ?? "/tmp", "cowork-preview-ancestor-"),
      );
      const workspace = path.join(dir, "workspace");
      const subdir = path.join(workspace, "subdir");
      const outside = path.join(dir, "outside");
      await fs.mkdir(subdir, { recursive: true });
      await fs.mkdir(outside);
      const filePath = path.join(subdir, "preview.txt");
      await fs.writeFile(filePath, "inside", "utf8");
      await fs.writeFile(path.join(outside, "preview.txt"), "outside marker", "utf8");
      const expectedCanonicalPath = canonicalizeSync(filePath);
      let replaced = false;
      const replaceAncestor = async () => {
        if (replaced) return;
        replaced = true;
        await fs.rename(subdir, path.join(workspace, "original-subdir"));
        await symlink(outside, subdir, { type: "dir" });
      };

      try {
        if (replacementPhase === "before-open") await replaceAncestor();
        await expect(
          readCappedFilePreview(filePath, 1_024, {
            expectedCanonicalPath,
            beforePathVerification:
              replacementPhase === "before-verification" ? replaceAncestor : undefined,
          }),
        ).rejects.toThrow("authorized");
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );

  test("retries when the path is atomically replaced after its descriptor is read", async () => {
    const dir = await fs.mkdtemp(
      path.join(scratchRoots()[0] ?? "/tmp", "cowork-preview-replacement-"),
    );
    const filePath = path.join(dir, "preview.txt");
    const replacementPath = path.join(dir, "replacement.txt");
    await fs.writeFile(filePath, "old", "utf8");
    await fs.writeFile(replacementPath, "replacement", "utf8");
    let replaced = false;

    try {
      const preview = await readCappedFilePreview(filePath, 1_024, {
        expectedCanonicalPath: canonicalizeSync(filePath),
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
