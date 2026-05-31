import type { PresentationPreviewResult } from "../../../../../src/server/presentationPreview";
import type {
  SpreadsheetBatchPatchOperation,
  SpreadsheetBatchPatchResult,
  SpreadsheetFileVersionResult,
  SpreadsheetWorkbookSnapshotResult,
} from "../../../../../src/shared/spreadsheetPreview";
import type { AppStoreActions, StoreGet, StoreSet } from "../store.helpers";
import { ensureServerRunning } from "../store.helpers";
import {
  patchJsonRpcWorkspaceSpreadsheet,
  previewJsonRpcWorkspacePresentation,
  previewJsonRpcWorkspaceSpreadsheetWorkbook,
  versionJsonRpcWorkspaceSpreadsheet,
} from "../store.helpers/jsonRpcSocket";

export function createPreviewActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  AppStoreActions,
  | "loadSpreadsheetWorkbook"
  | "loadSpreadsheetFileVersion"
  | "patchSpreadsheetWorkbook"
  | "loadPresentationPreview"
> {
  return {
    loadSpreadsheetWorkbook: async (
      path: string,
      opts?: {
        sheetName?: string;
      },
    ): Promise<SpreadsheetWorkbookSnapshotResult> => {
      const workspaceId = get().selectedWorkspaceId;
      if (!workspaceId) {
        throw new Error("No active workspace is available for spreadsheet workbooks.");
      }
      await ensureServerRunning(get, set, workspaceId);
      return previewJsonRpcWorkspaceSpreadsheetWorkbook(get, set, workspaceId, path, opts ?? {});
    },

    loadSpreadsheetFileVersion: async (path: string): Promise<SpreadsheetFileVersionResult> => {
      const workspaceId = get().selectedWorkspaceId;
      if (!workspaceId) {
        throw new Error("No active workspace is available for spreadsheet file versions.");
      }
      await ensureServerRunning(get, set, workspaceId);
      return versionJsonRpcWorkspaceSpreadsheet(get, set, workspaceId, path);
    },

    patchSpreadsheetWorkbook: async (
      path: string,
      operations: SpreadsheetBatchPatchOperation[],
    ): Promise<SpreadsheetBatchPatchResult> => {
      const workspaceId = get().selectedWorkspaceId;
      if (!workspaceId) {
        throw new Error("No active workspace is available for spreadsheet patching.");
      }
      await ensureServerRunning(get, set, workspaceId);
      return patchJsonRpcWorkspaceSpreadsheet(get, set, workspaceId, path, operations);
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
