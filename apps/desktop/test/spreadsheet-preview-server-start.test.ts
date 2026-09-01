import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { DESKTOP_API_OVERRIDE_KEY } from "../src/lib/desktopApiOverride";
import {
  createDesktopApiMock,
  createDesktopCommandsBridgeMock,
} from "./helpers/mockDesktopCommands";

const startWorkspaceServerMock = mock(async () => ({ url: "ws://mock-popup" }));
const desktopApiMock = createDesktopApiMock({
  startWorkspaceServer: startWorkspaceServerMock,
});
(globalThis as Record<string, unknown>)[DESKTOP_API_OVERRIDE_KEY] = desktopApiMock;
mock.module("../src/lib/desktopCommands", () => createDesktopCommandsBridgeMock());

const { useAppStore } = await import("../src/app/store");
const { reactivateWorkspaceJsonRpcSocketState } = await import(
  "../src/app/store.helpers/jsonRpcSocket"
);
const { RUNTIME } = await import("../src/app/store.helpers/runtimeState");

type AppStoreState = ReturnType<typeof useAppStore.getState>;
type RequestMock = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

const PATH = "/Users/mweinbach/Projects/preview-workspace/popup.xlsx";

function resetPopupWorkspace(requestMock: RequestMock) {
  const state = useAppStore.getState();
  reactivateWorkspaceJsonRpcSocketState("ws-popup");
  RUNTIME.jsonRpcSockets.clear();
  RUNTIME.jsonRpcSockets.set("ws-popup", {
    readyPromise: Promise.resolve(),
    connect: () => {},
    close: () => {},
    respond: () => true,
    request: requestMock,
  } as never);
  useAppStore.setState({
    ...state,
    workspaces: [
      {
        id: "ws-popup",
        name: "Popup workspace",
        path: "/Users/mweinbach/Projects/preview-workspace",
        createdAt: "2026-05-16T00:00:00.000Z",
        lastOpenedAt: "2026-05-16T00:00:00.000Z",
        defaultEnableMcp: true,
        defaultBackupsEnabled: true,
        yolo: false,
      },
    ],
    selectedWorkspaceId: "ws-popup",
    selectedThreadId: "thread-popup",
    workspaceRuntimeById: {},
  } as Partial<AppStoreState>);
}

describe("spreadsheet workbook workspace startup", () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>)[DESKTOP_API_OVERRIDE_KEY] = desktopApiMock;
    startWorkspaceServerMock.mockClear();
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[DESKTOP_API_OVERRIDE_KEY];
  });

  test("starts the workspace server before requesting workbook data", async () => {
    let serverUrlAtRequest: string | null | undefined;
    const requestMock = mock(async (method: string, params?: Record<string, unknown>) => {
      serverUrlAtRequest = useAppStore.getState().workspaceRuntimeById["ws-popup"]?.serverUrl;
      expect(method).toBe("cowork/workspace/spreadsheet/workbook");
      expect(params?.cwd).toBe("/Users/mweinbach/Projects/preview-workspace");
      return {
        ok: true,
        workbook: {
          kind: "xlsx",
          path: PATH,
          filename: "popup.xlsx",
          fileVersion: { modifiedAtMs: 1, changeTimeMs: 1, size: 1, fingerprint: "1:1:1" },
          activeSheetName: "Sheet1",
          sheets: [
            {
              id: "sheet-1",
              name: "Sheet1",
              rowCount: 1,
              colCount: 1,
              cells: [{ row: 0, col: 0, address: "A1", value: "Ready" }],
              mergedCells: [],
              columnWidths: [],
              tables: [],
              charts: [],
            },
          ],
          warnings: [],
        },
      };
    });
    resetPopupWorkspace(requestMock);

    const result = await useAppStore.getState().loadSpreadsheetWorkbook(PATH);

    expect(result.ok).toBe(true);
    expect(serverUrlAtRequest).toBeTruthy();
    expect(startWorkspaceServerMock).toHaveBeenCalledTimes(1);
    expect(startWorkspaceServerMock.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: "ws-popup",
      workspacePath: "/Users/mweinbach/Projects/preview-workspace",
    });
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  test.each(["workbook", "version", "patch"] as const)(
    "keeps %s requests on the document's captured workspace after selection changes",
    async (operation) => {
      const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
      const requestMock = mock(async (method: string, params?: Record<string, unknown>) => {
        requests.push({ method, params });
        return { ok: true };
      });
      resetPopupWorkspace(requestMock);
      reactivateWorkspaceJsonRpcSocketState("ws-selected");
      RUNTIME.jsonRpcSockets.set("ws-selected", {
        readyPromise: Promise.resolve(),
        connect: () => {},
        close: () => {},
        respond: () => true,
        request: requestMock,
      } as never);
      useAppStore.setState((state) => ({
        workspaces: [
          ...state.workspaces,
          { ...state.workspaces[0]!, id: "ws-selected", path: "/tmp/new-selection" },
        ],
        selectedWorkspaceId: "ws-selected",
      }));

      const actions = useAppStore.getState();
      if (operation === "workbook") {
        await actions.loadSpreadsheetWorkbook(PATH, {
          workspaceId: "ws-popup",
          sheetName: "Sheet1",
        });
      } else if (operation === "version") {
        await actions.loadSpreadsheetFileVersion(PATH, "ws-popup");
      } else {
        await actions.patchSpreadsheetWorkbook(PATH, [], undefined, "ws-popup");
      }

      expect(requests).toHaveLength(1);
      expect(requests[0]?.params).toMatchObject({
        cwd: "/Users/mweinbach/Projects/preview-workspace",
        path: PATH,
      });
      expect(requests[0]?.params).not.toHaveProperty("workspaceId");
      expect(startWorkspaceServerMock.mock.calls[0]?.[0]).toMatchObject({
        workspaceId: "ws-popup",
      });
      expect(useAppStore.getState().selectedWorkspaceId).toBe("ws-selected");
    },
  );

  test.each(["workbook", "version", "patch"] as const)(
    "does not redirect a removed document workspace's %s request to the selected workspace",
    async (operation) => {
      const requestMock = mock(async () => ({ ok: true }));
      resetPopupWorkspace(requestMock);
      const actions = useAppStore.getState();
      const request =
        operation === "workbook"
          ? actions.loadSpreadsheetWorkbook(PATH, { workspaceId: "removed-workspace" })
          : operation === "version"
            ? actions.loadSpreadsheetFileVersion(PATH, "removed-workspace")
            : actions.patchSpreadsheetWorkbook(PATH, [], undefined, "removed-workspace");

      await expect(request).rejects.toThrow();
      expect(startWorkspaceServerMock).not.toHaveBeenCalled();
      expect(requestMock).not.toHaveBeenCalled();
    },
  );
});
