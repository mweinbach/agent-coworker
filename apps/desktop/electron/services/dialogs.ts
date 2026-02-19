import type { MessageBoxOptions } from "electron";

import type { ConfirmActionInput } from "../../src/lib/desktopApi";

type BuiltConfirmDialog = {
  options: MessageBoxOptions;
  confirmButtonIndex: number;
};

function trimOrDefault(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

export function buildConfirmDialog(input: ConfirmActionInput, platform: NodeJS.Platform = process.platform): BuiltConfirmDialog {
  const confirmLabel = trimOrDefault(input.confirmLabel, "Confirm");
  const cancelLabel = trimOrDefault(input.cancelLabel, "Cancel");

  if (platform === "darwin") {
    const defaultId = input.defaultAction === "confirm" ? 1 : 0;
    return {
      confirmButtonIndex: 1,
      options: {
        type: input.kind ?? "warning",
        title: input.title,
        message: input.message,
        detail: input.detail,
        buttons: [cancelLabel, confirmLabel],
        defaultId,
        cancelId: 0,
        normalizeAccessKeys: true,
      },
    };
  }

  const defaultId = input.defaultAction === "confirm" ? 0 : 1;
  return {
    confirmButtonIndex: 0,
    options: {
      type: input.kind ?? "warning",
      title: input.title,
      message: input.message,
      detail: input.detail,
      buttons: [confirmLabel, cancelLabel],
      defaultId,
      cancelId: 1,
      normalizeAccessKeys: true,
      noLink: true,
    },
  };
}
