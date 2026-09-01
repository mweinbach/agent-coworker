import { describe, expect, mock, test } from "bun:test";

import type {
  CanvasDocumentOpenResult,
  CanvasDocumentRevision,
  CanvasDocumentSaveResult,
} from "../../../src/shared/canvasDocument";
import {
  type CanvasDocumentClient,
  CanvasDocumentController,
} from "../src/lib/canvasDocumentController";
import {
  registerCanvasDocumentTransitionHandler,
  requestCanvasDocumentCloseApproval,
  requestCanvasDocumentTransition,
} from "../src/lib/canvasDocumentLifecycle";

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
    const close = controller.close().then((result) => {
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

  for (const restoreFails of [false, true]) {
    test(`close preserves an undo during an in-flight save when restoring ${restoreFails ? "fails" : "succeeds"}`, async () => {
      const pendingSave = deferred<CanvasDocumentSaveResult>();
      const savedContents: string[] = [];
      const client = makeClient({
        open: mock(async (_workspaceId, input) =>
          opened("/workspace/notes.md", input.generation, "original"),
        ),
        save: mock(async (_workspaceId, input) => {
          savedContents.push(input.content);
          if (input.editRevision === 1) return await pendingSave.promise;
          if (restoreFails) {
            return {
              ok: false,
              documentId: input.documentId,
              generation: input.generation,
              editRevision: input.editRevision,
              error: { kind: "write_error", message: "disk full" },
            };
          }
          return saved(
            "/workspace/notes.md",
            input.generation,
            input.editRevision,
            "sha256:original",
          );
        }),
      });
      const controller = makeController(client);
      await controller.open("workspace-1", "/workspace/notes.md");
      controller.edit("intermediate edit");
      const flushing = controller.flush();
      controller.edit("original");
      const closing = controller.close();

      try {
        await Promise.resolve();
        expect(controller.getState().saveStatus).toBe("saving");
        expect(client.close).not.toHaveBeenCalled();

        pendingSave.resolve(saved("/workspace/notes.md", 1, 1, "sha256:intermediate"));
        expect(await flushing).toBe(!restoreFails);
        expect(await closing).toBe(!restoreFails);
        expect(savedContents).toEqual(["intermediate edit", "original"]);
        if (restoreFails) {
          expect(client.close).not.toHaveBeenCalled();
          expect(controller.getState()).toMatchObject({
            phase: "ready",
            content: "original",
            saveStatus: "error",
          });
        } else {
          expect(client.close).toHaveBeenCalledTimes(1);
          expect(controller.getState().phase).toBe("idle");
        }
      } finally {
        pendingSave.resolve(saved("/workspace/notes.md", 1, 1, "sha256:intermediate"));
        await Promise.all([flushing, closing]);
        controller.dispose();
      }
    });
  }

  test("close waits for Save As even when the document has no unsaved text", async () => {
    const pendingSaveAs = deferred<CanvasDocumentSaveResult>();
    const client = makeClient({
      open: mock(async (_workspaceId, input) =>
        opened("/workspace/notes.md", input.generation, "original"),
      ),
      saveAs: mock(async () => await pendingSaveAs.promise),
    });
    const controller = makeController(client);
    await controller.open("workspace-1", "/workspace/notes.md");
    const saving = controller.saveAs("/workspace/copy.md");
    const closing = controller.close();

    try {
      await Promise.resolve();
      expect(client.close).not.toHaveBeenCalled();
      pendingSaveAs.resolve(saved("/workspace/copy.md", 1, 0, "sha256:original"));
      expect(await saving).toBe("/workspace/copy.md");
      expect(await closing).toBe(true);
      expect(client.close).toHaveBeenCalledTimes(1);
      expect(client.save).not.toHaveBeenCalled();
    } finally {
      pendingSaveAs.resolve(saved("/workspace/copy.md", 1, 0, "sha256:original"));
      await Promise.all([saving, closing]);
      controller.dispose();
    }
  });

  test("a committed close waiting for a save cannot retire a newer requested document", async () => {
    const pendingSave = deferred<CanvasDocumentSaveResult>();
    const client = makeClient({
      open: mock(async (_workspaceId, input) =>
        opened(input.path, input.generation, input.path.endsWith("a.md") ? "A" : "B"),
      ),
      save: mock(async () => await pendingSave.promise),
    });
    const controller = makeController(client);
    await controller.open("workspace-1", "/workspace/a.md");
    controller.edit("edited A");
    const closing = controller.close();
    const opening = controller.open("workspace-1", "/workspace/b.md");

    try {
      pendingSave.resolve(saved("/workspace/a.md", 1, 1, "sha256:edited-a"));
      expect(await closing).toBe(false);
      expect(await opening).toBe(true);
      expect(controller.getState()).toMatchObject({
        phase: "ready",
        content: "B",
        document: { path: "/workspace/b.md", generation: 2 },
      });
      expect(client.close).toHaveBeenCalledTimes(1);
      expect(client.close).toHaveBeenCalledWith("workspace-1", {
        documentId: "canvas-test",
        generation: 1,
      });
    } finally {
      pendingSave.resolve(saved("/workspace/a.md", 1, 1, "sha256:edited-a"));
      await Promise.all([closing, opening]);
      controller.dispose();
    }
  });

  test("a delayed committed close response cannot reset a newer open document", async () => {
    const pendingClose = deferred<Awaited<ReturnType<CanvasDocumentClient["close"]>>>();
    const closeStarted = deferred<boolean>();
    let closeCalls = 0;
    const client = makeClient({
      open: mock(async (_workspaceId, input) =>
        opened(input.path, input.generation, input.path.endsWith("a.md") ? "A" : "B"),
      ),
      close: mock(async (_workspaceId, input) => {
        closeCalls += 1;
        if (closeCalls === 1) {
          closeStarted.resolve(true);
          return await pendingClose.promise;
        }
        return { ok: true, ...input };
      }),
    });
    const controller = makeController(client);
    await controller.open("workspace-1", "/workspace/a.md");
    const closing = controller.close();
    await closeStarted.promise;

    try {
      expect(await controller.open("workspace-1", "/workspace/b.md")).toBe(true);
      const currentState = controller.getState();
      pendingClose.resolve({ ok: true, documentId: "canvas-test", generation: 1 });
      expect(await closing).toBe(false);
      expect(controller.getState()).toBe(currentState);
      expect(currentState.document?.path).toBe("/workspace/b.md");
    } finally {
      pendingClose.resolve({ ok: true, documentId: "canvas-test", generation: 1 });
      await closing;
      controller.dispose();
    }
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

describe("Canvas transition approvals", () => {
  test("repeated close approval and a later veto leave the document open and editable", async () => {
    const client = makeClient({
      open: mock(async (_workspaceId, input) => opened(input.path, input.generation, "original")),
    });
    const controller = makeController(client);
    await controller.open("workspace-1", "/workspace/notes.md");
    const unregister = registerCanvasDocumentTransitionHandler((nextPath) =>
      controller.prepareForTransition(nextPath),
    );
    let unregisterVeto = () => {};

    try {
      controller.edit("saved before approval");
      expect(await requestCanvasDocumentCloseApproval()).toBe(true);
      const approvedState = controller.getState();
      expect(approvedState).toMatchObject({
        phase: "ready",
        content: "saved before approval",
        saveStatus: "saved",
        document: { path: "/workspace/notes.md", generation: 1 },
      });
      expect(await requestCanvasDocumentCloseApproval()).toBe(true);
      expect(controller.getState()).toBe(approvedState);
      expect(client.close).not.toHaveBeenCalled();

      unregisterVeto = registerCanvasDocumentTransitionHandler(async () => false);
      expect(await requestCanvasDocumentCloseApproval()).toBe(false);
      unregisterVeto();
      expect(controller.getState()).toBe(approvedState);

      controller.edit("edit after another window cancels quit");
      expect(await requestCanvasDocumentCloseApproval()).toBe(true);
      expect(controller.getState()).toMatchObject({
        phase: "ready",
        content: "edit after another window cancels quit",
        saveStatus: "saved",
        document: { path: "/workspace/notes.md", generation: 1 },
      });
      expect(client.open).toHaveBeenCalledTimes(1);
      expect(client.close).not.toHaveBeenCalled();
    } finally {
      unregisterVeto();
      unregister();
      controller.dispose();
    }
  });

  for (const restoreFails of [false, true]) {
    test(`approval waits for an in-flight save and an undo restoration that ${restoreFails ? "fails" : "succeeds"}`, async () => {
      const pendingSave = deferred<CanvasDocumentSaveResult>();
      const savedContents: string[] = [];
      const client = makeClient({
        open: mock(async (_workspaceId, input) => opened(input.path, input.generation, "original")),
        save: mock(async (_workspaceId, input) => {
          savedContents.push(input.content);
          if (input.editRevision === 1) return await pendingSave.promise;
          if (restoreFails) {
            return {
              ok: false,
              documentId: input.documentId,
              generation: input.generation,
              editRevision: input.editRevision,
              error: { kind: "write_error", message: "disk full" },
            };
          }
          return saved(
            "/workspace/notes.md",
            input.generation,
            input.editRevision,
            "sha256:original",
          );
        }),
      });
      const controller = makeController(client);
      await controller.open("workspace-1", "/workspace/notes.md");
      const unregister = registerCanvasDocumentTransitionHandler((nextPath) =>
        controller.prepareForTransition(nextPath),
      );
      controller.edit("intermediate edit");
      const flushing = controller.flush();
      controller.edit("original");
      let approvalSettled = false;
      const approval = requestCanvasDocumentCloseApproval().then((result) => {
        approvalSettled = true;
        return result;
      });

      try {
        await Promise.resolve();
        expect(approvalSettled).toBe(false);
        expect(controller.getState().saveStatus).toBe("saving");
        expect(client.close).not.toHaveBeenCalled();
        pendingSave.resolve(saved("/workspace/notes.md", 1, 1, "sha256:intermediate"));

        expect(await flushing).toBe(!restoreFails);
        expect(await approval).toBe(!restoreFails);
        expect(savedContents).toEqual(["intermediate edit", "original"]);
        expect(controller.getState()).toMatchObject({
          phase: "ready",
          content: "original",
          saveStatus: restoreFails ? "error" : "saved",
          document: { path: "/workspace/notes.md", generation: 1 },
        });
        expect(client.close).not.toHaveBeenCalled();
      } finally {
        pendingSave.resolve(saved("/workspace/notes.md", 1, 1, "sha256:intermediate"));
        await Promise.all([flushing, approval]);
        unregister();
        controller.dispose();
      }
    });
  }

  test("approval waits for Save As without retiring the saved document", async () => {
    const pendingSaveAs = deferred<CanvasDocumentSaveResult>();
    const client = makeClient({
      open: mock(async (_workspaceId, input) => opened(input.path, input.generation, "original")),
      saveAs: mock(async () => await pendingSaveAs.promise),
    });
    const controller = makeController(client);
    await controller.open("workspace-1", "/workspace/notes.md");
    const saving = controller.saveAs("/workspace/copy.md");
    let approvalSettled = false;
    const approval = controller.prepareForTransition(null).then((result) => {
      approvalSettled = true;
      return result;
    });

    try {
      await Promise.resolve();
      expect(approvalSettled).toBe(false);
      expect(client.close).not.toHaveBeenCalled();
      pendingSaveAs.resolve(saved("/workspace/copy.md", 1, 0, "sha256:original"));
      expect(await saving).toBe("/workspace/copy.md");
      expect(await approval).toBe(true);
      expect(controller.getState()).toMatchObject({
        phase: "ready",
        content: "original",
        saveStatus: "saved",
        document: { path: "/workspace/copy.md", generation: 1 },
      });
      expect(client.close).not.toHaveBeenCalled();
    } finally {
      pendingSaveAs.resolve(saved("/workspace/copy.md", 1, 0, "sha256:original"));
      await Promise.all([saving, approval]);
      controller.dispose();
    }
  });

  test("a registered failed document save cannot be replaced by another approving participant", async () => {
    const client = makeClient({
      save: mock(async () => {
        throw new Error("disk full");
      }),
    });
    const controller = makeController(client);
    await controller.open("workspace-1", "/workspace/notes.md");
    controller.edit("unsaved text");
    const unregisterDocument = registerCanvasDocumentTransitionHandler((nextPath) =>
      controller.prepareForTransition(nextPath),
    );
    const unregisterSpreadsheet = registerCanvasDocumentTransitionHandler(async () => true);

    try {
      expect(await requestCanvasDocumentCloseApproval()).toBe(false);
      expect(controller.getState()).toMatchObject({
        phase: "ready",
        content: "unsaved text",
        saveStatus: "error",
        problem: { source: "save", message: "disk full" },
      });
      expect(client.close).not.toHaveBeenCalled();
    } finally {
      unregisterSpreadsheet();
      unregisterDocument();
      controller.dispose();
    }
  });

  test("approval preserves a conflict without retrying an unsafe overwrite", async () => {
    const client = makeClient({
      open: mock(async (_workspaceId, input) =>
        opened(input.path, input.generation, "original", "sha256:original"),
      ),
    });
    const controller = makeController(client);
    await controller.open("workspace-1", "/workspace/notes.md");
    controller.edit("unsaved local edit");
    await controller.poll();

    try {
      expect(await controller.prepareForTransition(null)).toBe(false);
      expect(controller.getState()).toMatchObject({
        phase: "ready",
        content: "unsaved local edit",
        saveStatus: "conflict",
      });
      expect(client.save).not.toHaveBeenCalled();
      expect(client.close).not.toHaveBeenCalled();
    } finally {
      controller.dispose();
    }
  });

  test("queued approval checks the currently registered document, not an unmounted handler", async () => {
    const pendingFirstApproval = deferred<boolean>();
    const started = deferred<boolean>();
    const staleHandler = mock(async () => {
      started.resolve(true);
      return await pendingFirstApproval.promise;
    });
    const unregisterStale = registerCanvasDocumentTransitionHandler(staleHandler);
    const firstApproval = requestCanvasDocumentTransition("/workspace/next.md");
    await started.promise;
    const queuedApproval = requestCanvasDocumentCloseApproval();
    unregisterStale();
    const currentHandler = mock(async () => false);
    const unregisterCurrent = registerCanvasDocumentTransitionHandler(currentHandler);

    try {
      pendingFirstApproval.resolve(true);
      await firstApproval;
      expect(await queuedApproval).toBe(false);
      expect(staleHandler).toHaveBeenCalledTimes(1);
      expect(currentHandler).toHaveBeenCalledWith(null);
    } finally {
      pendingFirstApproval.resolve(true);
      await Promise.all([firstApproval, queuedApproval]);
      unregisterCurrent();
      unregisterStale();
    }
  });

  test("a rejected handler denies approval without poisoning later requests", async () => {
    const handler = mock()
      .mockImplementationOnce(async () => {
        throw new Error("save transport disconnected");
      })
      .mockImplementationOnce(async () => true);
    const unregister = registerCanvasDocumentTransitionHandler(handler);

    try {
      expect(await requestCanvasDocumentCloseApproval()).toBe(false);
      expect(await requestCanvasDocumentTransition("/workspace/next.md")).toBe(true);
    } finally {
      unregister();
    }
  });
});
