import { beforeEach, describe, expect, mock, test } from "bun:test";

const requestJsonRpcMock = mock(async () => ({ path: "/tmp/report.pdf" }));
const saveExportedFileMock = mock(async () => "/Users/test/Downloads/report.pdf");

mock.module("../src/lib/desktopCommands", () => ({
  saveExportedFile: (...args: unknown[]) => saveExportedFileMock(...args),
}));

mock.module("../src/app/store.helpers/jsonRpcSocket", () => ({
  requestJsonRpc: (...args: unknown[]) => requestJsonRpcMock(...args),
  registerWorkspaceJsonRpcLifecycle: () => () => {},
  registerWorkspaceJsonRpcRouter: () => () => {},
}));

mock.module("../src/app/store.helpers", () => ({
  ensureControlSocket() {},
  ensureServerRunning: async () => {},
  ensureWorkspaceRuntime() {},
  makeId: () => "note-1",
  nowIso: () => "2026-04-23T12:00:00.000Z",
  pushNotification: <T>(notifications: T[], entry: T) => [...notifications, entry],
  syncDesktopStateCache() {},
  waitForControlSession: async () => true,
}));

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
  beforeEach(() => {
    requestJsonRpcMock.mockReset();
    requestJsonRpcMock.mockImplementation(async () => ({ path: "/tmp/report.pdf" }));
    saveExportedFileMock.mockReset();
    saveExportedFileMock.mockImplementation(async () => "/Users/test/Downloads/report.pdf");
  });

  test("exportResearch saves with a sanitized title-derived filename and clears pending state", async () => {
    const harness = createHarness();
    const actions = createResearchActions(harness.set as never, harness.get as never);

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
    expect(harness.state.notifications).toEqual([
      {
        id: "note-1",
        ts: "2026-04-23T12:00:00.000Z",
        kind: "info",
        title: "Research exported",
        detail: "/Users/test/Downloads/report.pdf",
      },
    ]);
  });

  test("exportResearch treats save dialog cancel as a silent no-op", async () => {
    const harness = createHarness();
    const actions = createResearchActions(harness.set as never, harness.get as never);
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
    const actions = createResearchActions(harness.set as never, harness.get as never);
    saveExportedFileMock.mockImplementationOnce(async () => {
      throw new Error("disk full");
    });

    const result = await actions.exportResearch("research-1", "markdown");

    expect(result).toBeNull();
    expect(harness.state.researchExportPendingIds).toEqual([]);
    expect(harness.state.notifications).toEqual([
      {
        id: "note-1",
        ts: "2026-04-23T12:00:00.000Z",
        kind: "error",
        title: "Unable to export research",
        detail: "disk full",
      },
    ]);
  });

  test("exportResearch reports a missing export path and clears pending state", async () => {
    const harness = createHarness();
    const actions = createResearchActions(harness.set as never, harness.get as never);
    requestJsonRpcMock.mockImplementationOnce(async () => ({}));

    const result = await actions.exportResearch("research-1", "pdf");

    expect(result).toBeNull();
    expect(saveExportedFileMock).not.toHaveBeenCalled();
    expect(harness.state.researchExportPendingIds).toEqual([]);
    expect(harness.state.notifications).toEqual([
      {
        id: "note-1",
        ts: "2026-04-23T12:00:00.000Z",
        kind: "error",
        title: "Unable to export research",
        detail: "The export completed without a downloadable file path.",
      },
    ]);
  });
});
