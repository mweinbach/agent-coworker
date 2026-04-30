import type { app as electronApp, BrowserWindow } from "electron";

type ActivatableApp = Pick<typeof electronApp, "focus"> &
  Partial<Pick<typeof electronApp, "isHidden" | "show">>;

type ActivatableWindow = Pick<BrowserWindow, "focus" | "isMinimized" | "restore" | "show">;

export function revealAndActivateWindow(
  app: ActivatableApp,
  win: ActivatableWindow,
  platform: NodeJS.Platform = process.platform,
): void {
  if (win.isMinimized()) {
    win.restore();
  }

  if (platform === "darwin") {
    if (typeof app.isHidden === "function" && app.isHidden()) {
      app.show?.();
    }
    app.focus({ steal: true });
  } else {
    app.focus();
  }

  win.show();
  win.focus();
}
