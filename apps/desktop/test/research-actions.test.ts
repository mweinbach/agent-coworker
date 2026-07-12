import { beforeEach, describe, expect, mock, test } from "bun:test";

import { MAX_RESEARCH_UPLOAD_BYTES } from "../../../src/server/research/types";
import { type ComposerDraft, createEmptyComposerDraft } from "../src/app/composerDrafts";
import type { CreationDraftError } from "../src/app/creationDrafts";
import {
  __internalOperationIntent,
  invalidateNavigationIntent,
} from "../src/app/store.helpers/operationIntent";

const { createResearchActions, __internalResearchActionBindings } = await import(
  "../src/app/store.actions/research"
);

type TestState = {
  notifications: Array<{
    id: string;
    ts: string;
    kind: "info" | "error";
    title: string;
    detail: string;
  }>;
  desktopFeatureFlags: { workspaceLifecycle: boolean };
  providerStatusByName: Record<string, unknown>;
  selectedWorkspaceId: string | null;
  researchTransportWorkspaceId: string | null;
  workspaces: Array<{ id: string; path: string }>;
  view: "chat" | "skills" | "research" | "settings";
  researchById: Record<
    string,
    {
      id: string;
      title: string;
      parentResearchId?: string | null;
      status?: "pending" | "running" | "completed" | "cancelled" | "failed";
      outputsMarkdown?: string;
      lastEventId?: string | null;
      updatedAt?: string;
    }
  >;
  researchOrder: string[];
  selectedResearchId: string | null;
  researchListLoading: boolean;
  researchListError: string | null;
  researchSubscribedIds: string[];
  researchExportPendingIds: string[];
  researchCreationDraft: ComposerDraft;
  researchCreationError: CreationDraftError | null;
};

function researchUploadFile(fileId: string) {
  return {
    fileId,
    filename: `${fileId}.txt`,
    mimeType: "text/plain",
    path: `/tmp/${fileId}.txt`,
    uploadedAt: "2026-04-21T00:00:00.000Z",
  };
}

function completedResearch(id: string, title: string) {
  return {
    id,
    title,
    status: "completed" as const,
    outputsMarkdown: "Done",
    lastEventId: null,
    updatedAt: "2026-04-21T00:00:00.000Z",
    parentResearchId: null,
    prompt: title,
    interactionId: `interaction-${id}`,
    inputs: { files: [] },
    settings: { planApproval: false },
    thoughtSummaries: [],
    sources: [],
    createdAt: "2026-04-21T00:00:00.000Z",
    error: null,
  };
}

function createHarness(overrides: Partial<TestState> = {}) {
  const state: TestState = {
    notifications: [],
    desktopFeatureFlags: { workspaceLifecycle: true },
    providerStatusByName: {
      google: {
        provider: "google",
        authorized: true,
        verified: false,
        mode: "api_key",
        account: null,
        message: "API key saved.",
        checkedAt: "2026-05-15T00:00:00.000Z",
        savedApiKeyMasks: { api_key: "goog...1234" },
      },
    },
    selectedWorkspaceId: "ws-1",
    researchTransportWorkspaceId: null,
    workspaces: [{ id: "ws-1", path: "/tmp/ws-1" }],
    view: "chat",
    researchById: {
      "research-1": {
        id: "research-1",
        title: "Quarterly: Findings / 2026",
        status: "completed",
        outputsMarkdown: "",
        lastEventId: null,
        updatedAt: "2026-04-21T00:00:00.000Z",
      },
    },
    researchOrder: ["research-1"],
    selectedResearchId: "research-1",
    researchListLoading: false,
    researchListError: null,
    researchSubscribedIds: [],
    researchExportPendingIds: [],
    researchCreationDraft: createEmptyComposerDraft("2026-04-21T00:00:00.000Z"),
    researchCreationError: null,
    ...overrides,
  };

  return {
    state,
    get: () => state,
    set: (updater: Record<string, unknown> | ((state: TestState) => Record<string, unknown>)) => {
      const patch = typeof updater === "function" ? updater(state) : updater;
      Object.assign(state, patch);
    },
  };
}

describe("research actions", () => {
  const requestJsonRpcMock = mock(async () => ({ path: "/tmp/report.pdf", sizeBytes: 123 }));
  const saveExportedFileMock = mock(async () => "/Users/test/Downloads/report.pdf");

  const deps = {
    saveExportedFile: (...args: Parameters<typeof saveExportedFileMock>) =>
      saveExportedFileMock(...args),
    requestJsonRpc: (...args: Parameters<typeof requestJsonRpcMock>) => requestJsonRpcMock(...args),
    registerWorkspaceJsonRpcLifecycle: () => () => {},
    registerWorkspaceJsonRpcRouter: () => () => {},
    ensureControlSocket() {},
    ensureServerRunning: async () => {},
    ensureWorkspaceRuntime() {},
    syncDesktopStateCache() {},
    waitForControlSession: async () => true,
    persist() {},
  };

  beforeEach(() => {
    __internalResearchActionBindings.reset();
    __internalOperationIntent.reset();
    requestJsonRpcMock.mockReset();
    requestJsonRpcMock.mockImplementation(async () => ({
      path: "/tmp/report.pdf",
      sizeBytes: 123,
    }));
    saveExportedFileMock.mockReset();
    saveExportedFileMock.mockImplementation(async () => "/Users/test/Downloads/report.pdf");
  });

  test("a delayed research result is recorded without stealing newer navigation", async () => {
    const harness = createHarness();
    const actions = createResearchActions(harness.set as never, harness.get as never, deps);
    const startGate = Promise.withResolvers<ReturnType<typeof completedResearch>>();
    requestJsonRpcMock.mockImplementation(async (_get, _set, _workspaceId, method) => {
      if (method === "research/start") {
        return { research: await startGate.promise };
      }
      return {};
    });

    const pending = actions.startResearch({ input: "Investigate intent ownership." });
    invalidateNavigationIntent();
    harness.state.view = "settings";
    harness.state.selectedResearchId = "research-1";
    startGate.resolve(completedResearch("research-2", "Background result"));

    await expect(pending).resolves.toMatchObject({ ok: true, value: { id: "research-2" } });
    expect(harness.state.view).toBe("settings");
    expect(harness.state.selectedResearchId).toBe("research-1");
    expect(harness.state.researchById["research-2"]?.title).toBe("Background result");
  });

  test("a delayed research subscription refresh preserves newer navigation", async () => {
    const harness = createHarness();
    const actions = createResearchActions(harness.set as never, harness.get as never, deps);
    const subscriptionStarted = Promise.withResolvers<void>();
    const subscriptionGate = Promise.withResolvers<ReturnType<typeof completedResearch>>();
    const runningResearch = {
      ...completedResearch("research-2", "Background result"),
      status: "running" as const,
      outputsMarkdown: "",
    };
    requestJsonRpcMock.mockImplementation(async (_get, _set, _workspaceId, method) => {
      if (method === "research/start") {
        return { research: runningResearch };
      }
      if (method === "research/subscribe") {
        subscriptionStarted.resolve();
        return { research: await subscriptionGate.promise };
      }
      return {};
    });

    const pending = actions.startResearch({ input: "Investigate subscription ownership." });
    await subscriptionStarted.promise;
    invalidateNavigationIntent();
    harness.state.view = "settings";
    harness.state.selectedResearchId = "research-1";
    subscriptionGate.resolve(completedResearch("research-2", "Refreshed background result"));

    await expect(pending).resolves.toMatchObject({ ok: true, value: { id: "research-2" } });
    expect(harness.state.view).toBe("settings");
    expect(harness.state.selectedResearchId).toBe("research-1");
    expect(harness.state.researchById["research-2"]?.title).toBe("Refreshed background result");
  });

  test("overlapping research creation lets only the newest operation select its result", async () => {
    const harness = createHarness();
    const actions = createResearchActions(harness.set as never, harness.get as never, deps);
    const firstGate = Promise.withResolvers<ReturnType<typeof completedResearch>>();
    const secondGate = Promise.withResolvers<ReturnType<typeof completedResearch>>();
    requestJsonRpcMock.mockImplementation(
      async (_get, _set, _workspaceId, method, params: unknown) => {
        if (method !== "research/start") return {};
        const input =
          typeof params === "object" && params !== null && "input" in params
            ? (params as { input?: unknown }).input
            : null;
        return {
          research: await (input === "First research" ? firstGate.promise : secondGate.promise),
        };
      },
    );

    const first = actions.startResearch({ input: "First research" });
    const second = actions.startResearch({ input: "Second research" });
    secondGate.resolve(completedResearch("research-3", "Second result"));
    await expect(second).resolves.toMatchObject({ ok: true, value: { id: "research-3" } });
    firstGate.resolve(completedResearch("research-2", "First result"));
    await expect(first).resolves.toMatchObject({ ok: true, value: { id: "research-2" } });

    expect(harness.state.selectedResearchId).toBe("research-3");
    expect(harness.state.researchById["research-2"]?.title).toBe("First result");
    expect(harness.state.researchById["research-3"]?.title).toBe("Second result");
  });

  test("delayed research failure retains the submitted draft after navigation", async () => {
    const submittedDraft = {
      ...createEmptyComposerDraft("2026-04-21T00:00:00.000Z"),
      revision: 4,
      text: "Preserve this research question",
    };
    const harness = createHarness({ researchCreationDraft: submittedDraft });
    const actions = createResearchActions(harness.set as never, harness.get as never, deps);
    const startGate = Promise.withResolvers<void>();
    requestJsonRpcMock.mockImplementation(async (_get, _set, _workspaceId, method) => {
      if (method === "research/start") {
        await startGate.promise;
        throw new Error("research service unavailable");
      }
      return {};
    });

    const pending = actions.startResearch({
      input: submittedDraft.text,
      draftRevision: submittedDraft.revision,
    });
    invalidateNavigationIntent();
    harness.state.view = "settings";
    startGate.resolve();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { message: "research service unavailable" },
    });
    expect(harness.state.researchCreationDraft).toEqual(submittedDraft);
    expect(harness.state.researchCreationError).toEqual({
      revision: submittedDraft.revision,
      message: "research service unavailable",
    });
    expect(harness.state.view).toBe("settings");
  });

  test("an older research failure cannot overwrite a newer draft revision", async () => {
    const submittedDraft = {
      ...createEmptyComposerDraft("2026-04-21T00:00:00.000Z"),
      revision: 6,
      text: "Old research question",
    };
    const harness = createHarness({ researchCreationDraft: submittedDraft });
    const actions = createResearchActions(harness.set as never, harness.get as never, deps);
    const startGate = Promise.withResolvers<void>();
    requestJsonRpcMock.mockImplementation(async (_get, _set, _workspaceId, method) => {
      if (method === "research/start") {
        await startGate.promise;
        throw new Error("stale failure");
      }
      return {};
    });

    const pending = actions.startResearch({
      input: submittedDraft.text,
      draftRevision: submittedDraft.revision,
    });
    actions.setResearchCreationInput("New research question");
    startGate.resolve();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { message: "stale failure" },
    });
    expect(harness.state.researchCreationDraft.text).toBe("New research question");
    expect(harness.state.researchCreationDraft.revision).toBe(submittedDraft.revision + 1);
    expect(harness.state.researchCreationError).toBeNull();
  });

  test("cancelling attachment reads stops waiting before the file read completes", async () => {
    const harness = createHarness();
    const actions = createResearchActions(harness.set as never, harness.get as never, deps);
    const readGate = Promise.withResolvers<ArrayBuffer>();
    const readStarted = Promise.withResolvers<void>();
    const controller = new AbortController();
    const file = {
      name: "notes.txt",
      type: "text/plain",
      size: 5,
      arrayBuffer: () => {
        readStarted.resolve();
        return readGate.promise;
      },
    } as unknown as File;

    const pending = actions.startResearch({
      input: "Analyze the notes.",
      files: [file],
      signal: controller.signal,
    });
    await readStarted.promise;
    controller.abort();

    const outcome = await Promise.race([pending, Bun.sleep(100).then(() => "timed-out" as const)]);
    expect(outcome).toMatchObject({
      ok: false,
      error: { message: "Creation cancelled." },
    });
    expect(requestJsonRpcMock.mock.calls.some((call) => call[3] === "research/start")).toBeFalse();
    readGate.resolve(new ArrayBuffer(5));
  });

  test("cancelling after research/start is sent cancels the created server run", async () => {
    const submittedDraft = {
      ...createEmptyComposerDraft("2026-04-21T00:00:00.000Z"),
      revision: 7,
      text: "Cancel this safely",
    };
    const harness = createHarness({ researchCreationDraft: submittedDraft });
    const actions = createResearchActions(harness.set as never, harness.get as never, deps);
    const startReceived = Promise.withResolvers<void>();
    requestJsonRpcMock.mockImplementation(
      async (_get, _set, _workspaceId, method, _params, opts) => {
        if (method === "research/start") {
          startReceived.resolve();
          await new Promise<void>((_resolve, reject) => {
            opts?.signal?.addEventListener(
              "abort",
              () => {
                const error = new Error("Creation cancelled.");
                error.name = "AbortError";
                reject(error);
              },
              { once: true },
            );
          });
        }
        if (method === "research/cancel") {
          return { research: null };
        }
        return {};
      },
    );
    const controller = new AbortController();
    const clientResearchId = "1781a5a2-b171-40a7-827e-587f122d56d9";

    const pending = actions.startResearch({
      input: submittedDraft.text,
      draftRevision: submittedDraft.revision,
      clientResearchId,
      signal: controller.signal,
    });
    await startReceived.promise;
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { message: "Creation cancelled." },
    });
    expect(requestJsonRpcMock.mock.calls.some((call) => call[3] === "research/cancel")).toBeTrue();
    expect(
      requestJsonRpcMock.mock.calls.find((call) => call[3] === "research/cancel")?.[4],
    ).toEqual({
      researchId: clientResearchId,
    });
    expect(harness.state.researchCreationDraft).toEqual(submittedDraft);
  });

  test("exportResearch saves with a sanitized title-derived filename and clears pending state", async () => {
    const harness = createHarness();
    const actions = createResearchActions(harness.set as never, harness.get as never, deps);

    const result = await actions.exportResearch("research-1", "pdf");

    expect(requestJsonRpcMock).toHaveBeenCalledWith(
      harness.get,
      harness.set,
      "ws-1",
      "research/export",
      { researchId: "research-1", format: "pdf" },
    );
    expect(saveExportedFileMock).toHaveBeenCalledWith({
      sourcePath: "/tmp/report.pdf",
      defaultFileName: "Quarterly Findings 2026.pdf",
    });
    expect(result).toEqual({ ok: true, value: "/Users/test/Downloads/report.pdf" });
    expect(harness.state.researchExportPendingIds).toEqual([]);
    expect(harness.state.notifications).toHaveLength(1);
    expect(harness.state.notifications[0]?.kind).toBe("info");
    expect(harness.state.notifications[0]?.title).toBe("Research exported");
    expect(harness.state.notifications[0]?.detail).toBe("/Users/test/Downloads/report.pdf");
  });

  test("exportResearch treats save dialog cancel as a silent no-op", async () => {
    const harness = createHarness();
    const actions = createResearchActions(harness.set as never, harness.get as never, deps);
    saveExportedFileMock.mockImplementationOnce(async () => null);

    const result = await actions.exportResearch("research-1", "docx");

    expect(result).toEqual({ ok: true, value: null });
    expect(saveExportedFileMock).toHaveBeenCalledWith({
      sourcePath: "/tmp/report.pdf",
      defaultFileName: "Quarterly Findings 2026.docx",
    });
    expect(harness.state.notifications).toEqual([]);
    expect(harness.state.researchExportPendingIds).toEqual([]);
  });

  test("exportResearch reports save failures and still clears pending state", async () => {
    const harness = createHarness();
    const actions = createResearchActions(harness.set as never, harness.get as never, deps);
    saveExportedFileMock.mockImplementationOnce(async () => {
      throw new Error("disk full");
    });

    const result = await actions.exportResearch("research-1", "markdown");

    expect(result).toMatchObject({ ok: false, error: { message: "disk full" } });
    expect(harness.state.researchExportPendingIds).toEqual([]);
    expect(harness.state.notifications).toHaveLength(1);
    expect(harness.state.notifications[0]?.kind).toBe("error");
    expect(harness.state.notifications[0]?.title).toBe("Research not exported");
    expect(harness.state.notifications[0]?.detail).toContain("disk full");
  });

  test("exportResearch reports an invalid export response and clears pending state", async () => {
    const harness = createHarness();
    const actions = createResearchActions(harness.set as never, harness.get as never, deps);
    requestJsonRpcMock.mockImplementationOnce(async () => ({}));

    const result = await actions.exportResearch("research-1", "pdf");

    expect(result).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("Invalid research/export response") },
    });
    expect(saveExportedFileMock).not.toHaveBeenCalled();
    expect(harness.state.researchExportPendingIds).toEqual([]);
    expect(harness.state.notifications).toHaveLength(1);
    expect(harness.state.notifications[0]?.kind).toBe("error");
    expect(harness.state.notifications[0]?.title).toBe("Research not exported");
    expect(harness.state.notifications[0]?.detail).toContain("Invalid research/export response");
  });

  test("deleteResearch immediately reparents follow-ups while deletion settles", async () => {
    const deletionGate = Promise.withResolvers<void>();
    const parent = {
      id: "research-parent",
      title: "Parent",
      parentResearchId: null,
      status: "completed" as const,
      outputsMarkdown: "",
      lastEventId: null,
      updatedAt: "2026-04-21T00:00:00.000Z",
    };
    const child = {
      ...parent,
      id: "research-child",
      title: "Child",
      parentResearchId: parent.id,
      updatedAt: "2026-04-21T00:01:00.000Z",
    };
    const grandchild = {
      ...parent,
      id: "research-grandchild",
      title: "Grandchild",
      parentResearchId: child.id,
      updatedAt: "2026-04-21T00:02:00.000Z",
    };
    const harness = createHarness({
      researchById: {
        [parent.id]: parent,
        [child.id]: child,
        [grandchild.id]: grandchild,
      },
      researchOrder: [grandchild.id, child.id, parent.id],
      selectedResearchId: parent.id,
    });
    requestJsonRpcMock.mockImplementationOnce(async () => {
      await deletionGate.promise;
      return { researchId: parent.id, deleted: true };
    });
    const actions = createResearchActions(harness.set as never, harness.get as never, deps);

    const deletion = actions.deleteResearch(parent.id);
    expect(harness.state.researchById[parent.id]).toBeUndefined();
    expect(harness.state.researchById[child.id]?.parentResearchId).toBeNull();
    expect(harness.state.researchById[grandchild.id]?.parentResearchId).toBe(child.id);
    expect(harness.state.researchOrder).toContain(child.id);
    expect(harness.state.selectedResearchId).toBeNull();

    deletionGate.resolve();
    await expect(deletion).resolves.toMatchObject({ ok: true });
  });

  test("deleteResearch restores parent links when the server rejects deletion", async () => {
    const parent = {
      id: "research-parent",
      title: "Parent",
      parentResearchId: null,
      status: "completed" as const,
      outputsMarkdown: "",
      lastEventId: null,
      updatedAt: "2026-04-21T00:00:00.000Z",
    };
    const child = {
      ...parent,
      id: "research-child",
      title: "Child",
      parentResearchId: parent.id,
      updatedAt: "2026-04-21T00:01:00.000Z",
    };
    const harness = createHarness({
      researchById: {
        [parent.id]: parent,
        [child.id]: child,
      },
      researchOrder: [child.id, parent.id],
    });
    requestJsonRpcMock.mockImplementationOnce(async () => ({
      researchId: parent.id,
      deleted: false,
    }));
    const actions = createResearchActions(harness.set as never, harness.get as never, deps);

    await expect(actions.deleteResearch(parent.id)).resolves.toMatchObject({
      ok: false,
      error: { message: "The server did not delete this research." },
    });
    expect(harness.state.researchById[parent.id]).toEqual(parent);
    expect(harness.state.researchById[child.id]?.parentResearchId).toBe(parent.id);
  });

  test("startResearch rejects oversized files before reading attachment bytes", async () => {
    const harness = createHarness();
    const arrayBufferMock = mock(async () => new ArrayBuffer(0));
    const oversizedFile = {
      name: "huge.pdf",
      type: "application/pdf",
      size: MAX_RESEARCH_UPLOAD_BYTES + 1,
      arrayBuffer: arrayBufferMock,
    } as unknown as File;
    const actions = createResearchActions(harness.set as never, harness.get as never, deps);

    const result = await actions.startResearch({
      input: "Analyze this large file.",
      files: [oversizedFile],
    });

    expect(result).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining(String(MAX_RESEARCH_UPLOAD_BYTES)) },
    });
    expect(arrayBufferMock).not.toHaveBeenCalled();
    expect(requestJsonRpcMock).not.toHaveBeenCalled();
    expect(harness.state.notifications).toHaveLength(1);
    expect(harness.state.notifications[0]?.title).toBe("Research not started");
    expect(harness.state.notifications[0]?.detail).toContain(String(MAX_RESEARCH_UPLOAD_BYTES));
  });

  test("startResearch discards already-uploaded blobs when a later attachment upload fails", async () => {
    const harness = createHarness();
    const actions = createResearchActions(harness.set as never, harness.get as never, deps);
    const files = [
      {
        name: "first.txt",
        type: "text/plain",
        size: 5,
        arrayBuffer: async () => Buffer.from("first").buffer,
      },
      {
        name: "second.txt",
        type: "text/plain",
        size: 6,
        arrayBuffer: async () => Buffer.from("second").buffer,
      },
    ] as unknown as File[];

    requestJsonRpcMock.mockImplementation(async (_get, _set, _workspaceId, method) => {
      if (method === "research/uploadFile") {
        const callCount = requestJsonRpcMock.mock.calls.filter((call) => call[3] === method).length;
        if (callCount === 1) {
          return { file: researchUploadFile("file-1") };
        }
        throw new Error("upload failed");
      }
      if (method === "research/discardUploads") {
        return { status: "discarded" };
      }
      return {};
    });

    const result = await actions.startResearch({
      input: "Analyze these files.",
      files,
    });

    expect(result).toMatchObject({ ok: false, error: { message: "upload failed" } });
    expect(requestJsonRpcMock).toHaveBeenCalledWith(
      harness.get,
      harness.set,
      "ws-1",
      "research/discardUploads",
      { fileIds: ["file-1"] },
    );
    expect(harness.state.notifications.at(-1)?.title).toBe("Research not started");
  });

  test("sendResearchFollowUp does not discard uploaded blobs when follow-up start fails after upload success", async () => {
    const harness = createHarness();
    const actions = createResearchActions(harness.set as never, harness.get as never, deps);
    const file = {
      name: "followup.txt",
      type: "text/plain",
      size: 8,
      arrayBuffer: async () => Buffer.from("followup").buffer,
    } as unknown as File;

    requestJsonRpcMock.mockImplementation(async (_get, _set, _workspaceId, method) => {
      if (method === "research/uploadFile") {
        return { file: researchUploadFile("file-2") };
      }
      if (method === "research/followup") {
        throw new Error("follow-up failed");
      }
      return {};
    });

    const result = await actions.sendResearchFollowUp({
      parentResearchId: "research-1",
      input: "Continue the run.",
      files: [file],
    });

    expect(result).toMatchObject({ ok: false, error: { message: "follow-up failed" } });
    expect(
      requestJsonRpcMock.mock.calls.some((call) => call[3] === "research/discardUploads"),
    ).toBeFalse();
    expect(harness.state.notifications.at(-1)?.title).toBe("Research follow-up not sent");
  });

  test("sendResearchFollowUp discards uploaded blobs when the server definitively rejects the request", async () => {
    const harness = createHarness();
    const actions = createResearchActions(harness.set as never, harness.get as never, deps);
    const file = {
      name: "followup.txt",
      type: "text/plain",
      size: 8,
      arrayBuffer: async () => Buffer.from("followup").buffer,
    } as unknown as File;

    requestJsonRpcMock.mockImplementation(async (_get, _set, _workspaceId, method) => {
      if (method === "research/uploadFile") {
        return { file: researchUploadFile("file-4") };
      }
      if (method === "research/followup") {
        const error = new Error("parent research is not completed") as Error & {
          jsonRpcCode?: number;
        };
        error.jsonRpcCode = -32602;
        throw error;
      }
      if (method === "research/discardUploads") {
        return { status: "discarded" };
      }
      return {};
    });

    const result = await actions.sendResearchFollowUp({
      parentResearchId: "research-1",
      input: "Continue the run.",
      files: [file],
    });

    expect(result).toMatchObject({
      ok: false,
      error: { message: "parent research is not completed" },
    });
    expect(requestJsonRpcMock).toHaveBeenCalledWith(
      harness.get,
      harness.set,
      "ws-1",
      "research/discardUploads",
      { fileIds: ["file-4"] },
    );
    expect(harness.state.notifications.at(-1)?.title).toBe("Research follow-up not sent");
  });

  test("sendResearchFollowUp omits settings when no explicit overrides are provided", async () => {
    const harness = createHarness();
    const actions = createResearchActions(harness.set as never, harness.get as never, deps);
    requestJsonRpcMock.mockImplementation(async (_get, _set, _workspaceId, method, params) => {
      if (method === "research/followup") {
        return {
          research: {
            id: "research-2",
            title: "Follow-up",
            status: "running",
            outputsMarkdown: "",
            lastEventId: null,
            updatedAt: "2026-04-21T00:00:00.000Z",
            parentResearchId: "research-1",
            prompt: "Continue the run.",
            interactionId: "interaction-2",
            inputs: { files: [] },
            settings: { planApproval: true },
            thoughtSummaries: [],
            sources: [],
            createdAt: "2026-04-21T00:00:00.000Z",
            error: null,
          },
        };
      }
      return params ?? {};
    });

    await actions.sendResearchFollowUp({
      parentResearchId: "research-1",
      input: "Continue the run.",
    });

    expect(requestJsonRpcMock).toHaveBeenCalledWith(
      harness.get,
      harness.set,
      "ws-1",
      "research/followup",
      {
        parentResearchId: "research-1",
        input: "Continue the run.",
      },
    );
  });

  test("sendResearchFollowUp forwards explicit settings overrides when provided", async () => {
    const harness = createHarness();
    const actions = createResearchActions(harness.set as never, harness.get as never, deps);
    requestJsonRpcMock.mockImplementation(async (_get, _set, _workspaceId, method, params) => {
      if (method === "research/followup") {
        return {
          research: {
            id: "research-2",
            title: "Follow-up",
            status: "running",
            outputsMarkdown: "",
            lastEventId: null,
            updatedAt: "2026-04-21T00:00:00.000Z",
            parentResearchId: "research-1",
            prompt: "Continue the run.",
            interactionId: "interaction-2",
            inputs: { files: [] },
            settings: { planApproval: true },
            thoughtSummaries: [],
            sources: [],
            createdAt: "2026-04-21T00:00:00.000Z",
            error: null,
          },
        };
      }
      return params ?? {};
    });

    await actions.sendResearchFollowUp({
      parentResearchId: "research-1",
      input: "Continue the run.",
      settings: { planApproval: true },
    });

    expect(requestJsonRpcMock).toHaveBeenCalledWith(
      harness.get,
      harness.set,
      "ws-1",
      "research/followup",
      {
        parentResearchId: "research-1",
        input: "Continue the run.",
        settings: { planApproval: true },
      },
    );
  });

  test("startResearch does not discard uploaded blobs when start fails after upload success", async () => {
    const harness = createHarness();
    const actions = createResearchActions(harness.set as never, harness.get as never, deps);
    const file = {
      name: "start.txt",
      type: "text/plain",
      size: 5,
      arrayBuffer: async () => Buffer.from("start").buffer,
    } as unknown as File;

    requestJsonRpcMock.mockImplementation(async (_get, _set, _workspaceId, method) => {
      if (method === "research/uploadFile") {
        return { file: researchUploadFile("file-3") };
      }
      if (method === "research/start") {
        throw new Error("socket closed");
      }
      return {};
    });

    const result = await actions.startResearch({
      input: "Analyze this file.",
      files: [file],
    });

    expect(result).toMatchObject({ ok: false, error: { message: "socket closed" } });
    expect(
      requestJsonRpcMock.mock.calls.some((call) => call[3] === "research/discardUploads"),
    ).toBeFalse();
    expect(harness.state.notifications.at(-1)?.title).toBe("Research not started");
  });

  test("startResearch discards uploaded blobs when the server definitively rejects the request", async () => {
    const harness = createHarness();
    const actions = createResearchActions(harness.set as never, harness.get as never, deps);
    const file = {
      name: "start.txt",
      type: "text/plain",
      size: 5,
      arrayBuffer: async () => Buffer.from("start").buffer,
    } as unknown as File;

    requestJsonRpcMock.mockImplementation(async (_get, _set, _workspaceId, method) => {
      if (method === "research/uploadFile") {
        return { file: researchUploadFile("file-5") };
      }
      if (method === "research/start") {
        const error = new Error("research input is required") as Error & {
          jsonRpcCode?: number;
        };
        error.jsonRpcCode = -32602;
        throw error;
      }
      if (method === "research/discardUploads") {
        return { status: "discarded" };
      }
      return {};
    });

    const result = await actions.startResearch({
      input: "Analyze this file.",
      files: [file],
    });

    expect(result).toMatchObject({
      ok: false,
      error: { message: "research input is required" },
    });
    expect(requestJsonRpcMock).toHaveBeenCalledWith(
      harness.get,
      harness.set,
      "ws-1",
      "research/discardUploads",
      { fileIds: ["file-5"] },
    );
    expect(harness.state.notifications.at(-1)?.title).toBe("Research not started");
  });

  test("research text deltas advance the local event cursor", async () => {
    const harness = createHarness({
      researchById: {
        "research-1": {
          id: "research-1",
          title: "Live run",
          status: "running",
          outputsMarkdown: "Hello",
          lastEventId: "evt-1",
          updatedAt: "2026-04-21T00:00:00.000Z",
        },
      },
      researchOrder: ["research-1"],
    });
    let routeHandler:
      | ((message: {
          kind: "notification";
          method: string;
          params?: Record<string, unknown>;
        }) => void)
      | null = null;
    const actions = createResearchActions(
      harness.set as never,
      harness.get as never,
      {
        ...deps,
        registerWorkspaceJsonRpcRouter: (
          _workspaceId: string,
          handler: NonNullable<typeof routeHandler>,
        ) => {
          routeHandler = handler;
          return () => {};
        },
        requestJsonRpc: async () => ({ path: "/tmp/report.pdf", sizeBytes: 123 }),
      } as never,
    );

    await actions.exportResearch("research-1", "pdf");
    routeHandler?.({
      kind: "notification",
      method: "research/textDelta",
      params: {
        researchId: "research-1",
        delta: " world",
        eventId: "evt-2",
      },
    });

    expect(harness.state.researchById["research-1"]?.outputsMarkdown).toBe("Hello world");
    expect(harness.state.researchById["research-1"]?.lastEventId).toBe("evt-2");
  });

  test("research source events merge by stable url identity", async () => {
    const harness = createHarness({
      researchById: {
        "research-1": {
          id: "research-1",
          title: "Live run",
          status: "running",
          outputsMarkdown: "",
          lastEventId: "evt-1",
          thoughtSummaries: [],
          sources: [
            {
              sourceType: "url",
              url: "https://example.com/report",
              title: "url_context_result",
              host: "example.com",
            },
          ],
          updatedAt: "2026-04-21T00:00:00.000Z",
        },
      },
      researchOrder: ["research-1"],
    });
    let routeHandler:
      | ((message: {
          kind: "notification";
          method: string;
          params?: Record<string, unknown>;
        }) => void)
      | null = null;
    const actions = createResearchActions(
      harness.set as never,
      harness.get as never,
      {
        ...deps,
        registerWorkspaceJsonRpcRouter: (
          _workspaceId: string,
          handler: NonNullable<typeof routeHandler>,
        ) => {
          routeHandler = handler;
          return () => {};
        },
        requestJsonRpc: async () => ({ path: "/tmp/report.pdf", sizeBytes: 123 }),
      } as never,
    );

    await actions.exportResearch("research-1", "pdf");
    routeHandler?.({
      kind: "notification",
      method: "research/sourceFound",
      params: {
        researchId: "research-1",
        source: {
          sourceType: "url",
          url: "https://example.com/report",
          title: "Final report title",
          host: "example.com",
        },
      },
    });

    expect(harness.state.researchById["research-1"]?.sources).toEqual([
      {
        sourceType: "url",
        url: "https://example.com/report",
        title: "Final report title",
        host: "example.com",
      },
    ]);
  });

  test("research subscriptions apply the returned catch-up snapshot", async () => {
    const harness = createHarness({
      researchById: {},
      researchOrder: [],
      selectedResearchId: null,
    });
    const runningResearch = {
      id: "research-running",
      title: "Running",
      status: "running",
      outputsMarkdown: "old",
      lastEventId: "evt-1",
      updatedAt: "2026-04-21T00:00:00.000Z",
      parentResearchId: null,
      prompt: "Run",
      interactionId: "interaction-running",
      inputs: { files: [] },
      settings: { planApproval: false },
      thoughtSummaries: [],
      sources: [],
      createdAt: "2026-04-21T00:00:00.000Z",
      error: null,
    };
    const snapshot = {
      ...runningResearch,
      outputsMarkdown: "fresh",
      lastEventId: "evt-4",
      updatedAt: "2026-04-21T00:01:00.000Z",
    };
    const actions = createResearchActions(
      harness.set as never,
      harness.get as never,
      {
        ...deps,
        requestJsonRpc: async (
          _get: unknown,
          _set: unknown,
          _workspaceId: string,
          method: string,
        ) => {
          if (method === "research/list") {
            return { research: [runningResearch] };
          }
          if (method === "research/subscribe") {
            return { research: snapshot };
          }
          return {};
        },
      } as never,
    );

    await actions.refreshResearchList();

    expect(harness.state.researchById["research-running"]?.outputsMarkdown).toBe("fresh");
    expect(harness.state.researchById["research-running"]?.lastEventId).toBe("evt-4");
    expect(harness.state.researchSubscribedIds).toEqual(["research-running"]);
  });
});
