import { beforeEach, describe, expect, mock, test } from "bun:test";

const { createResearchActions } = await import("../src/app/store.actions/research");

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
  researchById: Record<string, { id: string; title: string }>;
  researchExportPendingIds: string[];
};

function createHarness(overrides: Partial<TestState> = {}) {
  const state: TestState = {
    notifications: [],
    desktopFeatureFlags: { workspaceLifecycle: true },
    selectedWorkspaceId: "ws-1",
    researchTransportWorkspaceId: null,
    workspaces: [{ id: "ws-1", path: "/tmp/ws-1" }],
    researchById: {
      "research-1": {
        id: "research-1",
        title: "Quarterly: Findings / 2026",
      },
    },
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
});
