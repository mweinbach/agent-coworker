import type { PresentationPreviewResult } from "../../../../../src/server/presentationPreview";
import type {
  SpreadsheetCellEditResult,
  SpreadsheetPreviewResult,
  SpreadsheetPreviewViewportRequest,
} from "../../../../../src/shared/spreadsheetPreview";
import type { AppStoreActions, StoreGet, StoreSet } from "../store.helpers";
import { ensureServerRunning } from "../store.helpers";
import {
  editJsonRpcWorkspaceSpreadsheet,
  previewJsonRpcWorkspacePresentation,
  previewJsonRpcWorkspaceSpreadsheet,
} from "../store.helpers/jsonRpcSocket";

export function createPreviewActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  AppStoreActions,
  "loadSpreadsheetPreview" | "editSpreadsheetCell" | "loadPresentationPreview"
> {
  return {
    loadSpreadsheetPreview: async (
      path: string,
      opts?: {
        sheetName?: string;
        viewport?: SpreadsheetPreviewViewportRequest;
      },
    ): Promise<SpreadsheetPreviewResult> => {
      const workspaceId = get().selectedWorkspaceId;
      if (!workspaceId) {
        throw new Error("No active workspace is available for spreadsheet preview.");
      }
      await ensureServerRunning(get, set, workspaceId);
      return previewJsonRpcWorkspaceSpreadsheet(get, set, workspaceId, path, opts ?? {});
    },

    editSpreadsheetCell: async (
      path: string,
      opts: { sheetName?: string; address: string; rawInput: string },
    ): Promise<SpreadsheetCellEditResult> => {
      const workspaceId = get().selectedWorkspaceId;
      if (!workspaceId) {
        throw new Error("No active workspace is available for spreadsheet editing.");
      }
      await ensureServerRunning(get, set, workspaceId);
      return editJsonRpcWorkspaceSpreadsheet(get, set, workspaceId, path, opts);
    },

    loadPresentationPreview: async (path: string): Promise<PresentationPreviewResult> => {
      const workspaceId = get().selectedWorkspaceId;
      if (!workspaceId) {
        throw new Error("No active workspace found.");
      }
      await ensureServerRunning(get, set, workspaceId);
      return previewJsonRpcWorkspacePresentation(
        get,
        set,
        workspaceId,
        path,
      ) as Promise<PresentationPreviewResult>;
    },
  };
}
