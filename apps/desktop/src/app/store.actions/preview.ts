import type { PresentationPreviewResult } from "../../../../../src/server/presentationPreview";
import type {
  SpreadsheetBatchPatchOperation,
  SpreadsheetBatchPatchResult,
  SpreadsheetCellEditResult,
  SpreadsheetCellStylePatch,
  SpreadsheetFileVersionResult,
  SpreadsheetPreviewResult,
  SpreadsheetPreviewViewportRequest,
  SpreadsheetRangeFormatResult,
  SpreadsheetWorkbookSnapshotResult,
} from "../../../../../src/shared/spreadsheetPreview";
import type { AppStoreActions, StoreGet, StoreSet } from "../store.helpers";
import { ensureServerRunning } from "../store.helpers";
import {
  editJsonRpcWorkspaceSpreadsheet,
  formatJsonRpcWorkspaceSpreadsheet,
  patchJsonRpcWorkspaceSpreadsheet,
  previewJsonRpcWorkspacePresentation,
  previewJsonRpcWorkspaceSpreadsheet,
  previewJsonRpcWorkspaceSpreadsheetWorkbook,
  versionJsonRpcWorkspaceSpreadsheet,
} from "../store.helpers/jsonRpcSocket";

export function createPreviewActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  AppStoreActions,
  | "loadSpreadsheetPreview"
  | "loadSpreadsheetWorkbook"
  | "loadSpreadsheetFileVersion"
  | "editSpreadsheetCell"
  | "formatSpreadsheetRange"
  | "patchSpreadsheetWorkbook"
  | "loadPresentationPreview"
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

    formatSpreadsheetRange: async (
      path: string,
      opts: { sheetName?: string; range: string; style: SpreadsheetCellStylePatch },
    ): Promise<SpreadsheetRangeFormatResult> => {
      const workspaceId = get().selectedWorkspaceId;
      if (!workspaceId) {
        throw new Error("No active workspace is available for spreadsheet formatting.");
      }
      await ensureServerRunning(get, set, workspaceId);
      return formatJsonRpcWorkspaceSpreadsheet(get, set, workspaceId, path, opts);
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
