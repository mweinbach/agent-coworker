import { beforeEach, describe, expect, mock, test } from "bun:test";

import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";

const startWorkspaceServerMock = mock(async () => ({ url: "ws://mock" }));

mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
    startWorkspaceServer: startWorkspaceServerMock,
  }),
);

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
    startWorkspaceServerMock.mockClear();
  });

  test("starts the workspace server before requesting workbook data", async () => {
    const requestMock = mock(async (method: string, params?: Record<string, unknown>) => {
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
    expect(startWorkspaceServerMock).toHaveBeenCalledTimes(1);
    expect(startWorkspaceServerMock.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: "ws-popup",
      workspacePath: "/Users/mweinbach/Projects/preview-workspace",
    });
    expect(requestMock).toHaveBeenCalledTimes(1);
  });
});
