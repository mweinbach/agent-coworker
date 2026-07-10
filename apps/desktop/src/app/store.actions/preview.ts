import type { PresentationPreviewResult } from "../../../../../src/server/presentationPreview";
import type {
  CanvasDocumentCloseResult,
  CanvasDocumentOpenResult,
  CanvasDocumentRevisionResult,
  CanvasDocumentSaveResult,
} from "../../../../../src/shared/canvasDocument";
import type {
  SpreadsheetBatchPatchOperation,
  SpreadsheetBatchPatchResult,
  SpreadsheetFileVersion,
  SpreadsheetFileVersionResult,
  SpreadsheetWorkbookSnapshotResult,
} from "../../../../../src/shared/spreadsheetPreview";
import type { AppStoreActions, StoreGet, StoreSet } from "../store.helpers";
import { ensureServerRunning } from "../store.helpers";
import {
  closeJsonRpcWorkspaceDocument,
  openJsonRpcWorkspaceDocument,
  patchJsonRpcWorkspaceSpreadsheet,
  previewJsonRpcWorkspacePresentation,
  previewJsonRpcWorkspaceSpreadsheetWorkbook,
  revisionJsonRpcWorkspaceDocument,
  saveAsJsonRpcWorkspaceDocument,
  saveJsonRpcWorkspaceDocument,
  versionJsonRpcWorkspaceSpreadsheet,
} from "../store.helpers/jsonRpcSocket";

export function createPreviewActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  AppStoreActions,
  | "openCanvasDocument"
  | "readCanvasDocumentRevision"
  | "saveCanvasDocument"
  | "saveCanvasDocumentAs"
  | "closeCanvasDocument"
  | "loadSpreadsheetWorkbook"
  | "loadSpreadsheetFileVersion"
  | "patchSpreadsheetWorkbook"
  | "loadPresentationPreview"
> {
  return {
    openCanvasDocument: async (
      workspaceId: string,
      input: {
        path: string;
        documentId: string;
        generation: number;
        maxBytes?: number;
      },
    ): Promise<CanvasDocumentOpenResult> => {
      await ensureServerRunning(get, set, workspaceId);
      return openJsonRpcWorkspaceDocument(get, set, workspaceId, input);
    },

    readCanvasDocumentRevision: async (
      workspaceId: string,
      input: { documentId: string; generation: number },
    ): Promise<CanvasDocumentRevisionResult> => {
      await ensureServerRunning(get, set, workspaceId);
      return revisionJsonRpcWorkspaceDocument(get, set, workspaceId, input);
    },

    saveCanvasDocument: async (
      workspaceId: string,
      input: {
        documentId: string;
        generation: number;
        editRevision: number;
        content: string;
      },
    ): Promise<CanvasDocumentSaveResult> => {
      await ensureServerRunning(get, set, workspaceId);
      return saveJsonRpcWorkspaceDocument(get, set, workspaceId, input);
    },

    saveCanvasDocumentAs: async (
      workspaceId: string,
      input: {
        documentId: string;
        generation: number;
        editRevision: number;
        content: string;
        path: string;
      },
    ): Promise<CanvasDocumentSaveResult> => {
      await ensureServerRunning(get, set, workspaceId);
      return saveAsJsonRpcWorkspaceDocument(get, set, workspaceId, input);
    },

    closeCanvasDocument: async (
      workspaceId: string,
      input: { documentId: string; generation: number },
    ): Promise<CanvasDocumentCloseResult> => {
      await ensureServerRunning(get, set, workspaceId);
      return closeJsonRpcWorkspaceDocument(get, set, workspaceId, input);
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

    patchSpreadsheetWorkbook: async (
      path: string,
      operations: SpreadsheetBatchPatchOperation[],
      expectedFileVersion?: SpreadsheetFileVersion,
    ): Promise<SpreadsheetBatchPatchResult> => {
      const workspaceId = get().selectedWorkspaceId;
      if (!workspaceId) {
        throw new Error("No active workspace is available for spreadsheet patching.");
      }
      await ensureServerRunning(get, set, workspaceId);
      return patchJsonRpcWorkspaceSpreadsheet(
        get,
        set,
        workspaceId,
        path,
        operations,
        expectedFileVersion,
      );
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
