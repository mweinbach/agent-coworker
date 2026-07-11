import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { scratchRoots } from "../src/platform/sandbox";
import { CanvasDocumentPersistenceService } from "../src/server/canvasDocumentPersistence";
import { symlinkOrJunction } from "./helpers/platform";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const temporaryDirectories: string[] = [];

async function makeWorkspace(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(scratchRoots()[0] ?? "/tmp", "cowork-canvas-document-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("CanvasDocumentPersistenceService", () => {
  test("binds each generation to its opened path so A content cannot target B", async () => {
    const cwd = await makeWorkspace();
    const pathA = path.join(cwd, "a.md");
    const pathB = path.join(cwd, "b.md");
    await fs.writeFile(pathA, "A");
    await fs.writeFile(pathB, "B");
    const service = new CanvasDocumentPersistenceService();

    const openedA = await service.open(cwd, {
      path: pathA,
      documentId: "canvas-1",
      generation: 1,
    });
    const openedB = await service.open(cwd, {
      path: pathB,
      documentId: "canvas-1",
      generation: 2,
    });
    expect(openedA.ok).toBe(true);
    expect(openedB.ok).toBe(true);

    const savedA = await service.save(cwd, {
      documentId: "canvas-1",
      generation: 1,
      editRevision: 1,
      content: "edited A",
    });

    expect(savedA.ok).toBe(true);
    expect(await fs.readFile(pathA, "utf8")).toBe("edited A");
    expect(await fs.readFile(pathB, "utf8")).toBe("B");
  });

  test("serializes writes so an attempted reverse completion keeps the newest edit", async () => {
    const cwd = await makeWorkspace();
    const filePath = path.join(cwd, "notes.md");
    await fs.writeFile(filePath, "original");
    const firstCommit = deferred<void>();
    const firstCommitStarted = deferred<void>();
    let commitCount = 0;
    const service = new CanvasDocumentPersistenceService({
      beforeAtomicCommit: async () => {
        commitCount += 1;
        if (commitCount === 1) {
          firstCommitStarted.resolve();
          await firstCommit.promise;
        }
      },
    });
    await service.open(cwd, {
      path: filePath,
      documentId: "canvas-1",
      generation: 1,
    });

    const completions: string[] = [];
    const firstSave = service
      .save(cwd, {
        documentId: "canvas-1",
        generation: 1,
        editRevision: 1,
        content: "edit one",
      })
      .then((result) => {
        completions.push("one");
        return result;
      });
    await firstCommitStarted.promise;
    const secondSave = service
      .save(cwd, {
        documentId: "canvas-1",
        generation: 1,
        editRevision: 2,
        content: "edit two",
      })
      .then((result) => {
        completions.push("two");
        return result;
      });

    expect(commitCount).toBe(1);
    expect(completions).toEqual([]);
    firstCommit.resolve();
    const [first, second] = await Promise.all([firstSave, secondSave]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(completions).toEqual(["one", "two"]);
    expect(await fs.readFile(filePath, "utf8")).toBe("edit two");
  });

  test("detects an external change during atomic commit and preserves external content", async () => {
    const cwd = await makeWorkspace();
    const filePath = path.join(cwd, "notes.md");
    await fs.writeFile(filePath, "original");
    let injectExternalChange = false;
    const service = new CanvasDocumentPersistenceService({
      beforeAtomicCommit: async ({ path: targetPath }) => {
        if (injectExternalChange) {
          injectExternalChange = false;
          await fs.writeFile(targetPath, "external edit");
        }
      },
    });
    await service.open(cwd, {
      path: filePath,
      documentId: "canvas-1",
      generation: 1,
    });
    injectExternalChange = true;

    const result = await service.save(cwd, {
      documentId: "canvas-1",
      generation: 1,
      editRevision: 1,
      content: "local edit",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("conflict");
      expect(result.currentRevision?.fingerprint).toStartWith("sha256:");
    }
    expect(await fs.readFile(filePath, "utf8")).toBe("external edit");
  });

  test("serializes conditional commits across service instances", async () => {
    const cwd = await makeWorkspace();
    const filePath = path.join(cwd, "notes.md");
    await fs.writeFile(filePath, "original");
    const firstCommit = deferred<void>();
    const firstCommitStarted = deferred<void>();
    const firstService = new CanvasDocumentPersistenceService({
      beforeAtomicCommit: async () => {
        firstCommitStarted.resolve();
        await firstCommit.promise;
      },
    });
    const secondService = new CanvasDocumentPersistenceService();
    await firstService.open(cwd, {
      path: filePath,
      documentId: "canvas-1",
      generation: 1,
    });
    await secondService.open(cwd, {
      path: filePath,
      documentId: "canvas-2",
      generation: 1,
    });

    const firstSave = firstService.save(cwd, {
      documentId: "canvas-1",
      generation: 1,
      editRevision: 1,
      content: "first edit",
    });
    await firstCommitStarted.promise;
    let secondSettled = false;
    const secondSave = secondService
      .save(cwd, {
        documentId: "canvas-2",
        generation: 1,
        editRevision: 1,
        content: "second edit",
      })
      .then((result) => {
        secondSettled = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondSettled).toBe(false);

    firstCommit.resolve();
    expect((await firstSave).ok).toBe(true);
    const secondResult = await secondSave;
    expect(secondResult.ok).toBe(false);
    if (!secondResult.ok) {
      expect(secondResult.error.kind).toBe("conflict");
    }
    expect(await fs.readFile(filePath, "utf8")).toBe("first edit");
  });

  test("returns the fingerprint of the inode committed even if the path changes immediately after", async () => {
    const cwd = await makeWorkspace();
    const filePath = path.join(cwd, "notes.md");
    const localContent = "local committed edit";
    await fs.writeFile(filePath, "original");
    const service = new CanvasDocumentPersistenceService({
      afterAtomicCommit: async ({ path: targetPath }: { path: string }) => {
        await fs.writeFile(targetPath, "external edit after commit");
      },
    } as never);
    await service.open(cwd, {
      path: filePath,
      documentId: "canvas-1",
      generation: 1,
    });

    const result = await service.save(cwd, {
      documentId: "canvas-1",
      generation: 1,
      editRevision: 1,
      content: localContent,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.revision.fingerprint).toBe(
        `sha256:${createHash("sha256").update(localContent).digest("hex")}`,
      );
    }
    expect(await fs.readFile(filePath, "utf8")).toBe("external edit after commit");
  });

  test("rejects a parent symlink swap before creating the temporary file", async () => {
    const cwd = await makeWorkspace();
    const outside = await makeWorkspace();
    const documentsPath = path.join(cwd, "documents");
    const movedDocumentsPath = path.join(cwd, "documents-original");
    const filePath = path.join(documentsPath, "notes.md");
    const outsideFilePath = path.join(outside, "notes.md");
    await fs.mkdir(documentsPath);
    await fs.writeFile(filePath, "original");
    await fs.writeFile(outsideFilePath, "outside");
    let swapped = false;
    const service = new CanvasDocumentPersistenceService({
      beforeTempCreate: async () => {
        await fs.rename(documentsPath, movedDocumentsPath);
        await symlinkOrJunction(outside, documentsPath, { type: "dir" });
        swapped = true;
      },
    } as never);
    await service.open(cwd, {
      path: filePath,
      documentId: "canvas-1",
      generation: 1,
    });

    const result = await service.save(cwd, {
      documentId: "canvas-1",
      generation: 1,
      editRevision: 1,
      content: "must stay inside",
    });

    expect(swapped).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("outside_workspace");
    }
    expect(await fs.readFile(outsideFilePath, "utf8")).toBe("outside");
    expect(await fs.readFile(path.join(movedDocumentsPath, "notes.md"), "utf8")).toBe("original");
  });

  test("rejects a parent symlink swap immediately before commit", async () => {
    const cwd = await makeWorkspace();
    const outside = await makeWorkspace();
    const documentsPath = path.join(cwd, "documents");
    const movedDocumentsPath = path.join(cwd, "documents-original");
    const filePath = path.join(documentsPath, "notes.md");
    const outsideFilePath = path.join(outside, "notes.md");
    await fs.mkdir(documentsPath);
    await fs.writeFile(filePath, "original");
    await fs.writeFile(outsideFilePath, "outside");
    const service = new CanvasDocumentPersistenceService({
      beforeAtomicCommit: async () => {
        await fs.rename(documentsPath, movedDocumentsPath);
        await symlinkOrJunction(outside, documentsPath, { type: "dir" });
      },
    });
    await service.open(cwd, {
      path: filePath,
      documentId: "canvas-1",
      generation: 1,
    });

    const result = await service.save(cwd, {
      documentId: "canvas-1",
      generation: 1,
      editRevision: 1,
      content: "must stay inside",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("outside_workspace");
    }
    expect(await fs.readFile(outsideFilePath, "utf8")).toBe("outside");
    expect(await fs.readFile(path.join(movedDocumentsPath, "notes.md"), "utf8")).toBe("original");
  });

  test("close waits for an in-flight final save and then retires the session", async () => {
    const cwd = await makeWorkspace();
    const filePath = path.join(cwd, "notes.md");
    await fs.writeFile(filePath, "original");
    const commit = deferred<void>();
    const service = new CanvasDocumentPersistenceService({
      beforeAtomicCommit: async () => await commit.promise,
    });
    await service.open(cwd, {
      path: filePath,
      documentId: "canvas-1",
      generation: 1,
    });
    const save = service.save(cwd, {
      documentId: "canvas-1",
      generation: 1,
      editRevision: 1,
      content: "final edit",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    let closeSettled = false;
    const close = service.close(cwd, { documentId: "canvas-1", generation: 1 }).then((result) => {
      closeSettled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closeSettled).toBe(false);

    commit.resolve();
    expect((await save).ok).toBe(true);
    expect((await close).ok).toBe(true);
    expect(await fs.readFile(filePath, "utf8")).toBe("final edit");
    const afterClose = await service.save(cwd, {
      documentId: "canvas-1",
      generation: 1,
      editRevision: 2,
      content: "too late",
    });
    expect(afterClose.ok).toBe(false);
    if (!afterClose.ok) {
      expect(afterClose.error.kind).toBe("session_not_found");
    }
  });

  test("keeps the session retryable after a write failure", async () => {
    const cwd = await makeWorkspace();
    const filePath = path.join(cwd, "notes.md");
    await fs.writeFile(filePath, "original");
    let shouldFail = true;
    const service = new CanvasDocumentPersistenceService({
      beforeAtomicCommit: () => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error("disk full");
        }
      },
    });
    await service.open(cwd, {
      path: filePath,
      documentId: "canvas-1",
      generation: 1,
    });
    const request = {
      documentId: "canvas-1",
      generation: 1,
      editRevision: 1,
      content: "unsaved edit",
    };

    const failed = await service.save(cwd, request);
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error).toEqual({ kind: "write_error", message: "disk full" });
    }
    expect(await fs.readFile(filePath, "utf8")).toBe("original");

    const retried = await service.save(cwd, request);
    expect(retried.ok).toBe(true);
    expect(await fs.readFile(filePath, "utf8")).toBe("unsaved edit");
  });

  test("Save As creates a new atomic copy and never clobbers an existing destination", async () => {
    const cwd = await makeWorkspace();
    const outside = await makeWorkspace();
    const sourcePath = path.join(cwd, "notes.md");
    const copyPath = path.join(cwd, "notes copy.md");
    const existingPath = path.join(cwd, "existing.md");
    await fs.writeFile(sourcePath, "original");
    await fs.writeFile(existingPath, "keep me");
    const service = new CanvasDocumentPersistenceService();
    await service.open(cwd, {
      path: sourcePath,
      documentId: "canvas-1",
      generation: 1,
    });

    const outsideRejected = await service.saveAs(cwd, {
      documentId: "canvas-1",
      generation: 1,
      editRevision: 1,
      content: "local edit",
      path: path.join(outside, "escaped.md"),
    });
    expect(outsideRejected.ok).toBe(false);
    if (!outsideRejected.ok) {
      expect(outsideRejected.error.kind).toBe("outside_workspace");
    }

    const conflict = await service.saveAs(cwd, {
      documentId: "canvas-1",
      generation: 1,
      editRevision: 2,
      content: "local edit",
      path: existingPath,
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.error.kind).toBe("conflict");
    }
    expect(await fs.readFile(existingPath, "utf8")).toBe("keep me");

    const copied = await service.saveAs(cwd, {
      documentId: "canvas-1",
      generation: 1,
      editRevision: 3,
      content: "local edit",
      path: copyPath,
    });
    expect(copied.ok).toBe(true);
    expect(await fs.readFile(sourcePath, "utf8")).toBe("original");
    expect(await fs.readFile(copyPath, "utf8")).toBe("local edit");
  });

  test("reports revision read failures and recovers on the next explicit retry", async () => {
    const cwd = await makeWorkspace();
    const filePath = path.join(cwd, "notes.md");
    await fs.writeFile(filePath, "original");
    const service = new CanvasDocumentPersistenceService();
    await service.open(cwd, {
      path: filePath,
      documentId: "canvas-1",
      generation: 1,
    });
    await fs.rm(filePath);

    const failed = await service.revision(cwd, {
      documentId: "canvas-1",
      generation: 1,
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.kind).toBe("read_error");
    }

    await fs.writeFile(filePath, "restored");
    const recovered = await service.revision(cwd, {
      documentId: "canvas-1",
      generation: 1,
    });
    expect(recovered.ok).toBe(true);
  });
});
