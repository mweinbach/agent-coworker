import { describe, expect, mock, test } from "bun:test";

import type {
  CanvasDocumentOpenResult,
  CanvasDocumentRevision,
  CanvasDocumentSaveResult,
} from "../../../../src/shared/canvasDocument";
import {
  type CanvasDocumentClient,
  CanvasDocumentController,
} from "../src/lib/canvasDocumentController";

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

function revision(fingerprint: string): CanvasDocumentRevision {
  return {
    modifiedAtMs: 1,
    changeTimeMs: 1,
    size: fingerprint.length,
    fingerprint,
  };
}

function opened(
  path: string,
  generation: number,
  content: string,
  fingerprint = `sha256:${content}`,
): CanvasDocumentOpenResult {
  return {
    ok: true,
    document: {
      documentId: "canvas-test",
      generation,
      path,
      content,
      truncated: false,
      revision: revision(fingerprint),
    },
  };
}

function saved(
  path: string,
  generation: number,
  editRevision: number,
  fingerprint: string,
): CanvasDocumentSaveResult {
  return {
    ok: true,
    documentId: "canvas-test",
    generation,
    editRevision,
    path,
    revision: revision(fingerprint),
    status: "saved",
  };
}

function makeClient(overrides: Partial<CanvasDocumentClient> = {}) {
  const client: CanvasDocumentClient = {
    open: mock(async (_workspaceId, input) => opened(input.path, input.generation, "")),
    revision: mock(async (_workspaceId, input) => ({
      ok: true,
      documentId: input.documentId,
      generation: input.generation,
      path: "/workspace/notes.md",
      revision: revision("sha256:current"),
    })),
    save: mock(async (_workspaceId, input) =>
      saved("/workspace/notes.md", input.generation, input.editRevision, "sha256:saved"),
    ),
    saveAs: mock(async (_workspaceId, input) =>
      saved(input.path, input.generation, input.editRevision, "sha256:copy"),
    ),
    close: mock(async (_workspaceId, input) => ({ ok: true, ...input })),
    ...overrides,
  };
  return client;
}

function makeController(client: CanvasDocumentClient) {
  return new CanvasDocumentController(client, {
    maxBytes: 256 * 1024,
    saveDelayMs: 60_000,
    createDocumentId: () => "canvas-test",
  });
}

describe("Canvas persistence controller", () => {
  test("ignores file A when its deferred read resolves after file B", async () => {
    const readA = deferred<CanvasDocumentOpenResult>();
    const readB = deferred<CanvasDocumentOpenResult>();
    const client = makeClient({
      open: mock(async (_workspaceId, input) => {
        return await (input.path.endsWith("a.md") ? readA.promise : readB.promise);
      }),
    });
    const controller = makeController(client);

    const openingA = controller.open("workspace-1", "/workspace/a.md");
    await Promise.resolve();
    const openingB = controller.open("workspace-1", "/workspace/b.md");
    readB.resolve(opened("/workspace/b.md", 2, "content B"));
    await openingB;
    readA.resolve(opened("/workspace/a.md", 1, "content A"));
    await openingA;

    expect(controller.getState().document?.path).toBe("/workspace/b.md");
    expect(controller.getState().content).toBe("content B");
    expect(client.close).toHaveBeenCalledWith("workspace-1", {
      documentId: "canvas-test",
      generation: 1,
    });
  });

  test("closes a deferred load that resolves after the Canvas is disposed", async () => {
    const pendingOpen = deferred<CanvasDocumentOpenResult>();
    const client = makeClient({
      open: mock(async () => await pendingOpen.promise),
    });
    const controller = makeController(client);

    const opening = controller.open("workspace-1", "/workspace/notes.md");
    await Promise.resolve();
    controller.dispose();
    pendingOpen.resolve(opened("/workspace/notes.md", 1, "stale"));

    expect(await opening).toBe(false);
    expect(controller.getState().document).toBeNull();
    expect(client.close).toHaveBeenCalledWith("workspace-1", {
      documentId: "canvas-test",
      generation: 1,
    });
  });

  test("flushes A before opening B and never sends a mutable save destination", async () => {
    const calls: string[] = [];
    const client = makeClient({
      open: mock(async (_workspaceId, input) => {
        calls.push(`open:${input.path}`);
        return opened(input.path, input.generation, input.path.endsWith("a.md") ? "A" : "B");
      }),
      save: mock(async (_workspaceId, input) => {
        calls.push(`save:${input.content}`);
        expect(input).not.toHaveProperty("path");
        return saved("/workspace/a.md", input.generation, input.editRevision, "sha256:edited-a");
      }),
      close: mock(async (_workspaceId, input) => {
        calls.push(`close:${input.generation}`);
        return { ok: true, ...input };
      }),
    });
    const controller = makeController(client);
    await controller.open("workspace-1", "/workspace/a.md");
    controller.edit("edited A");

    const switched = await controller.open("workspace-1", "/workspace/b.md");

    expect(switched).toBe(true);
    expect(calls).toEqual([
      "open:/workspace/a.md",
      "save:edited A",
      "close:1",
      "open:/workspace/b.md",
    ]);
    expect(controller.getState().content).toBe("B");
  });

  test("keeps A active when its final save fails, then retries and completes the switch", async () => {
    const client = makeClient({
      open: mock(async (_workspaceId, input) =>
        opened(input.path, input.generation, input.path.endsWith("a.md") ? "A" : "B"),
      ),
      save: mock()
        .mockImplementationOnce(async (_workspaceId, input) => ({
          ok: false,
          documentId: input.documentId,
          generation: input.generation,
          editRevision: input.editRevision,
          path: "/workspace/a.md",
          error: { kind: "write_error", message: "disk full" },
        }))
        .mockImplementationOnce(async (_workspaceId, input) =>
          saved("/workspace/a.md", input.generation, input.editRevision, "sha256:retry"),
        ),
    });
    const controller = makeController(client);
    await controller.open("workspace-1", "/workspace/a.md");
    controller.edit("edited A");

    expect(await controller.open("workspace-1", "/workspace/b.md")).toBe(false);
    expect(controller.getState().document?.path).toBe("/workspace/a.md");
    expect(controller.getState().content).toBe("edited A");
    expect(controller.getState().saveStatus).toBe("error");
    expect(client.close).not.toHaveBeenCalled();

    expect(await controller.retry()).toBe(true);
    expect(controller.getState().document?.path).toBe("/workspace/b.md");
    expect(controller.getState().content).toBe("B");
    expect(client.close).toHaveBeenCalledWith("workspace-1", {
      documentId: "canvas-test",
      generation: 1,
    });
  });

  test("serializes latest edits when save completions are held in reverse order", async () => {
    const firstSave = deferred<CanvasDocumentSaveResult>();
    const secondSave = deferred<CanvasDocumentSaveResult>();
    const client = makeClient({
      open: mock(async (_workspaceId, input) =>
        opened("/workspace/notes.md", input.generation, "original"),
      ),
      save: mock(async (_workspaceId, input) => {
        return await (input.editRevision === 1 ? firstSave.promise : secondSave.promise);
      }),
    });
    const controller = makeController(client);
    await controller.open("workspace-1", "/workspace/notes.md");
    controller.edit("edit one");
    const firstFlush = controller.flush();
    await Promise.resolve();
    controller.edit("edit two");
    const latestFlush = controller.flush();
    await Promise.resolve();
    expect(client.save).toHaveBeenCalledTimes(1);

    firstSave.resolve(saved("/workspace/notes.md", 1, 1, "sha256:one"));
    for (let attempt = 0; attempt < 10 && mock(client.save).mock.calls.length < 2; attempt += 1) {
      await Promise.resolve();
    }
    expect(client.save).toHaveBeenCalledTimes(2);
    secondSave.resolve(saved("/workspace/notes.md", 1, 2, "sha256:two"));
    expect(await firstFlush).toBe(true);
    expect(await latestFlush).toBe(true);
    expect(controller.getState().content).toBe("edit two");
    expect(controller.getState().saveStatus).toBe("saved");
  });

  test("serializes an edit made during Save As onto the returned path", async () => {
    const pendingSaveAs = deferred<CanvasDocumentSaveResult>();
    const client = makeClient({
      open: mock(async (_workspaceId, input) =>
        opened("/workspace/notes.md", input.generation, "original"),
      ),
      saveAs: mock(async () => await pendingSaveAs.promise),
      save: mock(async (_workspaceId, input) =>
        saved("/workspace/notes copy.md", input.generation, input.editRevision, "sha256:latest"),
      ),
    });
    const controller = makeController(client);
    await controller.open("workspace-1", "/workspace/notes.md");
    controller.edit("copy content");

    const saveAsCopy = controller.saveAs("/workspace/notes copy.md");
    await Promise.resolve();
    controller.edit("newer edit");
    const latestFlush = controller.flush();
    expect(client.save).not.toHaveBeenCalled();

    pendingSaveAs.resolve(saved("/workspace/notes copy.md", 1, 1, "sha256:copy"));
    expect(await saveAsCopy).toBe("/workspace/notes copy.md");
    expect(await latestFlush).toBe(true);
    expect(client.save).toHaveBeenCalledWith("workspace-1", {
      documentId: "canvas-test",
      generation: 1,
      editRevision: 2,
      content: "newer edit",
    });
    expect(controller.getState().document?.path).toBe("/workspace/notes copy.md");
    expect(controller.getState().content).toBe("newer edit");
    expect(controller.getState().saveStatus).toBe("saved");
  });

  test("preserves focused local edits when the external revision changes", async () => {
    const client = makeClient({
      open: mock(async (_workspaceId, input) =>
        opened("/workspace/notes.md", input.generation, "original", "sha256:original"),
      ),
      revision: mock(async (_workspaceId, input) => ({
        ok: true,
        documentId: input.documentId,
        generation: input.generation,
        path: "/workspace/notes.md",
        revision: revision("sha256:external"),
      })),
    });
    const controller = makeController(client);
    await controller.open("workspace-1", "/workspace/notes.md");
    controller.edit("local edit");

    await controller.poll();

    expect(controller.getState().content).toBe("local edit");
    expect(controller.getState().saveStatus).toBe("conflict");
    expect(controller.getState().problem?.message).toContain("unsaved changes are preserved");
    expect(client.save).not.toHaveBeenCalled();
  });

  test("coalesces overlapping polls into one revision read", async () => {
    const pendingRevision = deferred<Awaited<ReturnType<CanvasDocumentClient["revision"]>>>();
    const client = makeClient({
      open: mock(async (_workspaceId, input) =>
        opened("/workspace/notes.md", input.generation, "original", "sha256:original"),
      ),
      revision: mock(async () => await pendingRevision.promise),
    });
    const controller = makeController(client);
    await controller.open("workspace-1", "/workspace/notes.md");

    const firstPoll = controller.poll();
    const secondPoll = controller.poll();
    expect(client.revision).toHaveBeenCalledTimes(1);
    pendingRevision.resolve({
      ok: true,
      documentId: "canvas-test",
      generation: 1,
      path: "/workspace/notes.md",
      revision: revision("sha256:original"),
    });

    await Promise.all([firstPoll, secondPoll]);
    expect(controller.getState().problem).toBeNull();
  });

  test("close waits for the pending save and only closes after it succeeds", async () => {
    const pendingSave = deferred<CanvasDocumentSaveResult>();
    const client = makeClient({
      open: mock(async (_workspaceId, input) =>
        opened("/workspace/notes.md", input.generation, "original"),
      ),
      save: mock(async () => await pendingSave.promise),
    });
    const controller = makeController(client);
    await controller.open("workspace-1", "/workspace/notes.md");
    controller.edit("final edit");

    let closeSettled = false;
    const close = controller.prepareForTransition(null).then((result) => {
      closeSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    expect(client.close).not.toHaveBeenCalled();

    pendingSave.resolve(saved("/workspace/notes.md", 1, 1, "sha256:final"));
    expect(await close).toBe(true);
    expect(client.close).toHaveBeenCalledWith("workspace-1", {
      documentId: "canvas-test",
      generation: 1,
    });
    expect(controller.getState().phase).toBe("idle");
  });

  test("preserves unsaved content and retries after a save failure", async () => {
    const client = makeClient({
      open: mock(async (_workspaceId, input) =>
        opened("/workspace/notes.md", input.generation, "original"),
      ),
      save: mock()
        .mockImplementationOnce(async (_workspaceId, input) => ({
          ok: false,
          documentId: input.documentId,
          generation: input.generation,
          editRevision: input.editRevision,
          path: "/workspace/notes.md",
          error: { kind: "write_error", message: "disk full" },
        }))
        .mockImplementationOnce(async (_workspaceId, input) =>
          saved("/workspace/notes.md", input.generation, input.editRevision, "sha256:retry"),
        ),
    });
    const controller = makeController(client);
    await controller.open("workspace-1", "/workspace/notes.md");
    controller.edit("unsaved edit");

    expect(await controller.flush()).toBe(false);
    expect(controller.getState().content).toBe("unsaved edit");
    expect(controller.getState().saveStatus).toBe("error");
    expect(controller.getState().problem?.message).toBe("disk full");

    expect(await controller.retry()).toBe(true);
    expect(controller.getState().content).toBe("unsaved edit");
    expect(controller.getState().saveStatus).toBe("saved");
  });

  test("surfaces poll failures and clears them after an explicit retry", async () => {
    const client = makeClient({
      open: mock(async (_workspaceId, input) =>
        opened("/workspace/notes.md", input.generation, "original", "sha256:original"),
      ),
      revision: mock()
        .mockImplementationOnce(async () => {
          throw new Error("permission denied");
        })
        .mockImplementationOnce(async (_workspaceId, input) => ({
          ok: true,
          documentId: input.documentId,
          generation: input.generation,
          path: "/workspace/notes.md",
          revision: revision("sha256:original"),
        })),
    });
    const controller = makeController(client);
    await controller.open("workspace-1", "/workspace/notes.md");

    await controller.poll();
    expect(controller.getState().problem).toEqual({
      source: "poll",
      message: "permission denied",
    });

    expect(await controller.retry()).toBe(true);
    expect(controller.getState().problem).toBeNull();
  });

  test("surfaces load failures and retries the pending path", async () => {
    const client = makeClient({
      open: mock()
        .mockImplementationOnce(async (_workspaceId, input) => ({
          ok: false,
          documentId: input.documentId,
          generation: input.generation,
          path: input.path,
          error: { kind: "read_error", message: "temporary read failure" },
        }))
        .mockImplementationOnce(async (_workspaceId, input) =>
          opened(input.path, input.generation, "recovered"),
        ),
    });
    const controller = makeController(client);

    expect(await controller.open("workspace-1", "/workspace/notes.md")).toBe(false);
    expect(controller.getState().phase).toBe("error");
    expect(controller.getState().problem).toEqual({
      source: "load",
      message: "temporary read failure",
    });

    expect(await controller.retry()).toBe(true);
    expect(controller.getState().phase).toBe("ready");
    expect(controller.getState().content).toBe("recovered");
  });

  test("Save As preserves the edit under the returned path", async () => {
    const client = makeClient({
      open: mock(async (_workspaceId, input) =>
        opened("/workspace/notes.md", input.generation, "original"),
      ),
    });
    const controller = makeController(client);
    await controller.open("workspace-1", "/workspace/notes.md");
    controller.edit("recovered edit");

    const savedPath = await controller.saveAs("/workspace/notes copy.md");

    expect(savedPath).toBe("/workspace/notes copy.md");
    expect(controller.getState().document?.path).toBe("/workspace/notes copy.md");
    expect(controller.getState().content).toBe("recovered edit");
    expect(controller.getState().saveStatus).toBe("saved");
  });
});
