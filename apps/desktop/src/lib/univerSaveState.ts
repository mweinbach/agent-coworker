export type UniverSaveState = "idle" | "dirty" | "saving" | "saved" | "error";

export function shouldDeferExternalWorkbookReload(saveState: UniverSaveState): boolean {
  return saveState === "dirty" || saveState === "saving" || saveState === "error";
}
