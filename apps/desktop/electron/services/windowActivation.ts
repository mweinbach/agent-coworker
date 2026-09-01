import type { BrowserWindow, app as electronApp } from "electron";

type ActivatableApp = Pick<typeof electronApp, "focus"> &
  Partial<Pick<typeof electronApp, "isHidden" | "show">>;

type ActivatableWindow = Pick<BrowserWindow, "focus" | "isMinimized" | "restore" | "show">;

/** Share native-window creation, including the async work before allocation. */
export function createSingleWindowOpener<Window extends Pick<BrowserWindow, "isDestroyed">>(
  currentWindow: () => Window | null,
  createWindow: () => Promise<Window>,
): () => Promise<Window> {
  let pending: Promise<Window> | null = null;
  return async () => {
    if (pending) return await pending;
    const existing = currentWindow();
    if (existing && !existing.isDestroyed()) return existing;

    const creation = Promise.resolve().then(createWindow);
    pending = creation;
    try {
      return await creation;
    } finally {
      if (pending === creation) pending = null;
    }
  };
}

/** Initial-load failures must not leave an unreachable native window alive. */
export async function loadCreatedWindow<
  Window extends Pick<BrowserWindow, "isDestroyed" | "destroy">,
>(window: Window, load: () => Promise<void>): Promise<Window> {
  try {
    await load();
    return window;
  } catch (error) {
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
}

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
