export type UniverSaveState = "idle" | "dirty" | "saving" | "saved" | "error";

export function shouldDeferExternalWorkbookReload(saveState: UniverSaveState): boolean {
  return saveState === "dirty" || saveState === "saving" || saveState === "error";
}

export function shouldBlockSpreadsheetUnload(
  saveState: UniverSaveState,
  saveInFlight: Promise<unknown> | null,
): boolean {
  return shouldDeferExternalWorkbookReload(saveState) || saveInFlight !== null;
}

export function isWorkbookSnapshotForPath(
  workbook: { path: string } | null,
  path: string,
): boolean {
  return workbook?.path === path;
}
