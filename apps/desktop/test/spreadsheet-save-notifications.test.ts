import { expect, test } from "bun:test";

import { useAppStore } from "../src/app/store";
import type { Notification } from "../src/app/types";
import { reportSpreadsheetBackgroundSaveFailure } from "../src/lib/spreadsheetSaveNotifications";

test("background spreadsheet save failures retain only the latest 50 notifications", () => {
  const previous = useAppStore.getState().notifications;
  const existing: Notification[] = Array.from({ length: 50 }, (_, index) => ({
    id: `notification-${index}`,
    ts: "2026-01-01T00:00:00.000Z",
    kind: "info",
    title: `Notification ${index}`,
  }));
  try {
    useAppStore.setState({ notifications: existing });
    reportSpreadsheetBackgroundSaveFailure("C:\\workspace\\budget.xlsx", "Read-only file.");

    const notifications = useAppStore.getState().notifications;
    expect(notifications).toHaveLength(50);
    expect(notifications.slice(0, -1)).toEqual(existing.slice(1));
    expect(notifications.at(-1)).toMatchObject({
      kind: "error",
      title: "Spreadsheet save failed",
      detail: "budget.xlsx could not save before closing. Read-only file.",
      audience: "background",
    });
    expect(existing).toHaveLength(50);
    expect(existing[0]?.id).toBe("notification-0");
  } finally {
    useAppStore.setState({ notifications: previous });
  }
});
