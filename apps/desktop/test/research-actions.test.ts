import { beforeEach, describe, expect, mock, test } from "bun:test";

const { createResearchActions, __internalResearchActionBindings } = await import("../src/app/store.actions/research");

type TestState = {
  notifications: Array<{
    id: string;
    ts: string;
    kind: "info" | "error";
    title: string;
    detail: string;
  }>;
  desktopFeatureFlags: { workspaceLifecycle: boolean };
  selectedWorkspaceId: string | null;
  researchTransportWorkspaceId: string | null;
  workspaces: Array<{ id: string; path: string }>;
  view: "chat" | "skills" | "research" | "settings";
  researchById: Record<string, {
    id: string;
    title: string;
    status?: "pending" | "running" | "completed" | "cancelled" | "failed";
    outputsMarkdown?: string;
    lastEventId?: string | null;
    updatedAt?: string;
  }>;
  researchOrder: string[];
  selectedResearchId: string | null;
  researchListLoading: boolean;
  researchListError: string | null;
  researchSubscribedIds: string[];
  researchExportPendingIds: string[];
};

function createHarness(overrides: Partial<TestState> = {}) {
  const state: TestState = {
    notifications: [],
    desktopFeatureFlags: { workspaceLifecycle: true },
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
  const requestJsonRpcMock = mock(async () => ({ path: "/tmp/report.pdf" }));
  const saveExportedFileMock = mock(async () => "/Users/test/Downloads/report.pdf");

  const deps = {
    saveExportedFile: (...args: Parameters<typeof saveExportedFileMock>) => saveExportedFileMock(...args),
    requestJsonRpc: (...args: Parameters<typeof requestJsonRpcMock>) => requestJsonRpcMock(...args),
    registerWorkspaceJsonRpcLifecycle: () => () => {},
    registerWorkspaceJsonRpcRouter: () => () => {},
    ensureControlSocket() {},
    ensureServerRunning: async () => {},
    ensureWorkspaceRuntime() {},
    syncDesktopStateCache() {},
    waitForControlSession: async () => true,
  };

  beforeEach(() => {
    __internalResearchActionBindings.reset();
    requestJsonRpcMock.mockReset();
    requestJsonRpcMock.mockImplementation(async () => ({ path: "/tmp/report.pdf" }));
    saveExportedFileMock.mockReset();
    saveExportedFileMock.mockImplementation(async () => "/Users/test/Downloads/report.pdf");
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
    expect(result).toBe("/Users/test/Downloads/report.pdf");
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

    expect(result).toBeNull();
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

    expect(result).toBeNull();
    expect(harness.state.researchExportPendingIds).toEqual([]);
    expect(harness.state.notifications).toHaveLength(1);
    expect(harness.state.notifications[0]?.kind).toBe("error");
    expect(harness.state.notifications[0]?.title).toBe("Unable to export research");
    expect(harness.state.notifications[0]?.detail).toBe("disk full");
  });

  test("exportResearch reports a missing export path and clears pending state", async () => {
    const harness = createHarness();
    const actions = createResearchActions(harness.set as never, harness.get as never, deps);
    requestJsonRpcMock.mockImplementationOnce(async () => ({}));

    const result = await actions.exportResearch("research-1", "pdf");

    expect(result).toBeNull();
    expect(saveExportedFileMock).not.toHaveBeenCalled();
    expect(harness.state.researchExportPendingIds).toEqual([]);
    expect(harness.state.notifications).toHaveLength(1);
    expect(harness.state.notifications[0]?.kind).toBe("error");
    expect(harness.state.notifications[0]?.title).toBe("Unable to export research");
    expect(harness.state.notifications[0]?.detail).toBe("The export completed without a downloadable file path.");
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
    let routeHandler: ((message: { kind: "notification"; method: string; params?: Record<string, unknown> }) => void) | null = null;
    const actions = createResearchActions(harness.set as never, harness.get as never, {
      ...deps,
      registerWorkspaceJsonRpcRouter: (_workspaceId: string, handler: NonNullable<typeof routeHandler>) => {
        routeHandler = handler;
        return () => {};
      },
      requestJsonRpc: async () => ({ path: "/tmp/report.pdf" }),
    } as never);

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
    const actions = createResearchActions(harness.set as never, harness.get as never, {
      ...deps,
      requestJsonRpc: async (_get: unknown, _set: unknown, _workspaceId: string, method: string) => {
        if (method === "research/list") {
          return { research: [runningResearch] };
        }
        if (method === "research/subscribe") {
          return { research: snapshot };
        }
        return {};
      },
    } as never);

    await actions.refreshResearchList();

    expect(harness.state.researchById["research-running"]?.outputsMarkdown).toBe("fresh");
    expect(harness.state.researchById["research-running"]?.lastEventId).toBe("evt-4");
    expect(harness.state.researchSubscribedIds).toEqual(["research-running"]);
  });
});
