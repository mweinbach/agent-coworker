import { useAppStore } from "../app/store";
import { pushNotification } from "../app/store.helpers";

function basename(filePath: string): string {
  return filePath.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? filePath;
}

export function reportSpreadsheetBackgroundSaveFailure(filePath: string, message: string): void {
  const fileName = basename(filePath);
  useAppStore.setState((state) => ({
    notifications: pushNotification(state.notifications, {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      kind: "error",
      title: "Spreadsheet save failed",
      detail: `${fileName} could not save before closing. ${message}`,
      audience: "background",
    }),
  }));
}
