export const CANVAS_DOCUMENT_DEFAULT_MAX_BYTES = 256 * 1024;
export const CANVAS_DOCUMENT_MAX_BYTES = 5 * 1024 * 1024;

export type CanvasDocumentRevision = {
  modifiedAtMs: number;
  changeTimeMs: number;
  size: number;
  fingerprint: string;
};

export type CanvasDocumentSessionRef = {
  documentId: string;
  generation: number;
};

export type CanvasDocumentOpenRequest = CanvasDocumentSessionRef & {
  cwd: string;
  path: string;
  maxBytes?: number;
};

export type CanvasDocumentSnapshot = CanvasDocumentSessionRef & {
  path: string;
  content: string;
  truncated: boolean;
  revision: CanvasDocumentRevision;
};

export type CanvasDocumentOpenResult =
  | {
      ok: true;
      document: CanvasDocumentSnapshot;
    }
  | {
      ok: false;
      documentId: string;
      generation: number;
      path: string;
      error: {
        kind: "not_found" | "outside_workspace" | "read_error";
        message: string;
      };
    };

export type CanvasDocumentRevisionRequest = CanvasDocumentSessionRef & {
  cwd: string;
};

export type CanvasDocumentRevisionResult =
  | {
      ok: true;
      documentId: string;
      generation: number;
      path: string;
      revision: CanvasDocumentRevision;
    }
  | {
      ok: false;
      documentId: string;
      generation: number;
      error: {
        kind: "session_not_found" | "outside_workspace" | "read_error";
        message: string;
      };
    };

export type CanvasDocumentSaveRequest = CanvasDocumentSessionRef & {
  cwd: string;
  editRevision: number;
  content: string;
};

export type CanvasDocumentSaveSuccess = {
  ok: true;
  documentId: string;
  generation: number;
  editRevision: number;
  path: string;
  revision: CanvasDocumentRevision;
  status: "saved" | "superseded";
};

export type CanvasDocumentSaveFailure = {
  ok: false;
  documentId: string;
  generation: number;
  editRevision: number;
  path?: string;
  currentRevision?: CanvasDocumentRevision;
  error: {
    kind: "session_not_found" | "conflict" | "write_error";
    message: string;
  };
};

export type CanvasDocumentSaveResult = CanvasDocumentSaveSuccess | CanvasDocumentSaveFailure;

export type CanvasDocumentSaveAsRequest = CanvasDocumentSaveRequest & {
  path: string;
};

export type CanvasDocumentCloseRequest = CanvasDocumentSessionRef & {
  cwd: string;
};

export type CanvasDocumentCloseResult = {
  ok: true;
  documentId: string;
  generation: number;
};
