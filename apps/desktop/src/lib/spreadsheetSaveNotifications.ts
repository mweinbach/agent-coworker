import { useAppStore } from "../app/store";
import type { Notification } from "../app/types";

const MAX_NOTIFICATIONS = 50;

function basename(filePath: string): string {
  return filePath.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? filePath;
}

function pushNotification(notifications: Notification[], entry: Notification): Notification[] {
  const next = [...notifications, entry];
  if (next.length > MAX_NOTIFICATIONS) {
    return next.slice(next.length - MAX_NOTIFICATIONS);
  }
  return next;
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
    }),
  }));
}
