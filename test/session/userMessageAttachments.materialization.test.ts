import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import type { FileAttachment } from "../../src/server/jsonrpc/routes/shared";
import {
  createUserContentMaterializationTransaction,
  getTurnAttachmentValidationMessage,
} from "../../src/server/session/turnExecution/userMessageAttachments";
import { MAX_TURN_ATTACHMENT_COUNT } from "../../src/shared/attachments";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(import.meta.dir, "tmp-materialization-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const inlineAttachment = (filename: string, contentBase64 = "YQ=="): FileAttachment => ({
  filename,
  mimeType: "text/plain",
  contentBase64,
});

describe("getTurnAttachmentValidationMessage", () => {
  test("validates traversal, empty names, empty lists, and over-count attachments", () => {
    for (const bad of ["..", ".", "nested/..", ""]) {
      expect(getTurnAttachmentValidationMessage([inlineAttachment(bad)])).toBe(
        `Invalid attachment filename: ${bad}`,
      );
    }
    expect(getTurnAttachmentValidationMessage()).toBeNull();
    expect(getTurnAttachmentValidationMessage([])).toBeNull();
    const tooMany = Array.from({ length: MAX_TURN_ATTACHMENT_COUNT + 1 }, (_, index) =>
      inlineAttachment(`file-${index}.txt`),
    );
    expect(getTurnAttachmentValidationMessage(tooMany)).toBe(
      `Too many file attachments (max ${MAX_TURN_ATTACHMENT_COUNT})`,
    );
  });
});

describe("createUserContentMaterializationTransaction", () => {
  test("rollback deletes owned files/directories, leaves replacements/symlinks intact, and no-ops after commit", async () => {
    const root = await makeTempDir();
    const uploads = path.join(root, "uploads");
    const nested = path.join(uploads, "nested");
    await fs.mkdir(nested, { recursive: true });
    const filePath = path.join(nested, "note.txt");
    await fs.writeFile(filePath, "hello");

    const tx = createUserContentMaterializationTransaction();
    tx.trackCreatedDirectory(uploads, await fs.lstat(uploads));
    tx.trackCreatedDirectory(nested, await fs.lstat(nested));
    tx.trackCreatedFile(filePath, await fs.lstat(filePath));
    await tx.rollback();

    for (const removed of [filePath, nested, uploads]) {
      await expect(fs.stat(removed)).rejects.toMatchObject({ code: "ENOENT" });
    }

    const ownedPath = path.join(root, "owned.txt");
    await fs.writeFile(ownedPath, "original");
    const renameTx = createUserContentMaterializationTransaction();
    renameTx.trackCreatedFile(ownedPath, await fs.lstat(ownedPath));
    const renamed = path.join(root, "moved.txt");
    await fs.rename(ownedPath, renamed);
    await fs.writeFile(ownedPath, "replacement");
    await renameTx.rollback();

    expect(await fs.readFile(ownedPath, "utf8")).toBe("replacement");
    expect(await fs.readFile(renamed, "utf8")).toBe("original");

    const outside = await makeTempDir();
    const target = path.join(outside, "secret.txt");
    await fs.writeFile(target, "keep me");
    const linkPath = path.join(root, "linked.txt");
    await fs.writeFile(linkPath, "owned-link");
    const swapTx = createUserContentMaterializationTransaction();
    swapTx.trackCreatedFile(linkPath, await fs.lstat(linkPath));
    await fs.rm(linkPath);
    await fs.symlink(target, linkPath);
    await swapTx.rollback();

    expect(await fs.readFile(target, "utf8")).toBe("keep me");
    expect(await fs.readlink(linkPath)).toBe(target);

    const keptPath = path.join(root, "kept.txt");
    await fs.writeFile(keptPath, "keep");
    const committedTx = createUserContentMaterializationTransaction();
    committedTx.trackCreatedFile(keptPath, await fs.lstat(keptPath));
    committedTx.commit();
    committedTx.trackCreatedFile(path.join(root, "ignored.txt"), { dev: 1, ino: 1 });
    await committedTx.rollback();
    expect(await fs.readFile(keptPath, "utf8")).toBe("keep");
  });
});
