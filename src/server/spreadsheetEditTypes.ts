import type { SpreadsheetCellEditFailureKind } from "../shared/spreadsheetPreview";

export type EditFailure = { kind: SpreadsheetCellEditFailureKind; message: string };

/**
 * Outcome of applying an ordered list of operations to one file. `index` marks
 * which operation failed so the batch entry point can attribute the error, or is
 * `null` when the failure isn't tied to a specific operation (file read/write,
 * post-batch validation, or an unsupported file type).
 */
export type OpsOutcome = { ok: true } | { ok: false; index: number | null; error: EditFailure };
