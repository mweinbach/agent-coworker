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

function inlineAttachment(filename: string, contentBase64 = "YQ=="): FileAttachment {
  return { filename, mimeType: "text/plain", contentBase64 };
}

describe("getTurnAttachmentValidationMessage", () => {
  test("rejects traversal and empty attachment filenames before size checks", () => {
    expect(getTurnAttachmentValidationMessage([inlineAttachment("..")])).toBe(
      "Invalid attachment filename: ..",
    );
    expect(getTurnAttachmentValidationMessage([inlineAttachment(".")])).toBe(
      "Invalid attachment filename: .",
    );
    expect(getTurnAttachmentValidationMessage([inlineAttachment("nested/..")])).toBe(
      "Invalid attachment filename: nested/..",
    );
    expect(getTurnAttachmentValidationMessage([inlineAttachment("")])).toBe(
      "Invalid attachment filename: ",
    );
  });

  test("rejects over-count attachments and accepts an empty list", () => {
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
  test("rollback deletes tracked files and directories it still owns", async () => {
    const root = await makeTempDir();
    const nested = path.join(root, "uploads", "nested");
    await fs.mkdir(nested, { recursive: true });
    const filePath = path.join(nested, "note.txt");
    await fs.writeFile(filePath, "hello");

    const tx = createUserContentMaterializationTransaction();
    tx.trackCreatedDirectory(
      path.join(root, "uploads"),
      await fs.lstat(path.join(root, "uploads")),
    );
    tx.trackCreatedDirectory(nested, await fs.lstat(nested));
    tx.trackCreatedFile(filePath, await fs.lstat(filePath));

    await tx.rollback();

    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(nested)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(root, "uploads"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rollback leaves a renamed replacement and a symlink swap intact", async () => {
    const root = await makeTempDir();
    const filePath = path.join(root, "owned.txt");
    await fs.writeFile(filePath, "original");
    const originalStat = await fs.lstat(filePath);

    const tx = createUserContentMaterializationTransaction();
    tx.trackCreatedFile(filePath, originalStat);

    const renamed = path.join(root, "moved.txt");
    await fs.rename(filePath, renamed);
    await fs.writeFile(filePath, "replacement");

    await tx.rollback();

    expect(await fs.readFile(filePath, "utf8")).toBe("replacement");
    expect(await fs.readFile(renamed, "utf8")).toBe("original");

    const outside = await makeTempDir();
    const target = path.join(outside, "secret.txt");
    await fs.writeFile(target, "keep me");
    const linkPath = path.join(root, "linked.txt");
    await fs.writeFile(linkPath, "owned-link");
    const linkStat = await fs.lstat(linkPath);

    const swapTx = createUserContentMaterializationTransaction();
    swapTx.trackCreatedFile(linkPath, linkStat);
    await fs.rm(linkPath);
    await fs.symlink(target, linkPath);

    await swapTx.rollback();

    expect(await fs.readFile(target, "utf8")).toBe("keep me");
    expect(await fs.readlink(linkPath)).toBe(target);
  });

  test("commit makes later rollback a no-op", async () => {
    const root = await makeTempDir();
    const filePath = path.join(root, "kept.txt");
    await fs.writeFile(filePath, "keep");
    const tx = createUserContentMaterializationTransaction();
    tx.trackCreatedFile(filePath, await fs.lstat(filePath));
    tx.commit();
    tx.trackCreatedFile(path.join(root, "ignored.txt"), { dev: 1, ino: 1 });

    await tx.rollback();

    expect(await fs.readFile(filePath, "utf8")).toBe("keep");
  });
});
