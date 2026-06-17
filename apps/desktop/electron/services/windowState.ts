import fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import path from "node:path";

import type * as Electron from "electron";

/**
 * Persisted main-window bounds. Kept in a dedicated `window-state.json`
 * (separate from the IPC-backed `state.json`) so frequent resize/move events
 * never churn workspace/session state or trigger renderer syncs.
 */
export type WindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized?: boolean;
};

const WINDOW_STATE_FILENAME = "window-state.json";

function getWindowStateFilePath(app: Electron.App): string {
  return path.join(app.getPath("userData"), WINDOW_STATE_FILENAME);
}

async function readWindowState(app: Electron.App): Promise<WindowBounds | null> {
  try {
    const raw = await fs.readFile(getWindowStateFilePath(app), "utf8");
    const parsed = JSON.parse(raw) as Partial<WindowBounds>;
    if (
      typeof parsed.width === "number" &&
      typeof parsed.height === "number" &&
      typeof parsed.x === "number" &&
      typeof parsed.y === "number"
    ) {
      return {
        x: parsed.x,
        y: parsed.y,
        width: parsed.width,
        height: parsed.height,
        isMaximized: parsed.isMaximized === true,
      };
    }
    return null;
  } catch (error) {
    // Missing or corrupt file on first run / after hand-editing — not an error.
    return null;
  }
}

async function writeWindowState(app: Electron.App, bounds: WindowBounds): Promise<void> {
  try {
    const tmp = `${getWindowStateFilePath(app)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(bounds), { mode: 0o600 });
    await fs.rename(tmp, getWindowStateFilePath(app));
  } catch (error) {
    // Persistence is best-effort; never let a bounds write block the app.
    console.warn("[windowState] failed to persist bounds:", String(error));
  }
}

/**
 * Returns saved bounds clamped to a visible region of the current display, so
 * a window saved on a now-disconnected monitor still appears on-screen.
 * Returns null when no usable saved state exists (first launch / corrupt file).
 */
export async function loadMainWindowBounds(
  app: Electron.App,
  screen: Electron.Screen,
): Promise<WindowBounds | null> {
  const saved = await readWindowState(app);
  if (!saved) return null;

  const display = screen.getDisplayMatching(saved);
  const workArea = display.workArea;
  const minVisibleWidth = Math.min(200, saved.width);
  const minVisibleHeight = Math.min(120, saved.height);

  const x = Math.min(
    Math.max(saved.x, workArea.x - saved.width + minVisibleWidth),
    workArea.x + workArea.width - minVisibleWidth,
  );
  const y = Math.min(
    Math.max(saved.y, workArea.y - saved.height + minVisibleHeight),
    workArea.y + workArea.height - minVisibleHeight,
  );

  return {
    ...saved,
    x,
    y,
  };
}

/**
 * Captures the main window's bounds on resize/move/close and persists them.
 * Returns a cleanup function that flushes the final bounds (call on app quit).
 */
export function trackMainWindowBounds(
  app: Electron.App,
  win: Electron.BrowserWindow,
): () => void {
  let saveHandle: ReturnType<typeof setTimeout> | undefined;

  const scheduleSave = () => {
    if (saveHandle) clearTimeout(saveHandle);
    saveHandle = setTimeout(() => {
      saveHandle = undefined;
      if (win.isDestroyed()) return;
      const [x, y] = win.getPosition();
      const [width, height] = win.getSize();
      void writeWindowState(app, {
        x,
        y,
        width,
        height,
        isMaximized: win.isMaximized(),
      });
    }, 300);
  };

  const resizeListener = () => scheduleSave();
  const moveListener = () => scheduleSave();
  win.on("resize", resizeListener);
  win.on("move", moveListener);

  return () => {
    win.off("resize", resizeListener);
    win.off("move", moveListener);
    if (saveHandle) {
      clearTimeout(saveHandle);
      saveHandle = undefined;
    }
    if (!win.isDestroyed()) {
      const [x, y] = win.getPosition();
      const [width, height] = win.getSize();
      const bounds = { x, y, width, height, isMaximized: win.isMaximized() };
      // Synchronous flush so the write completes before the window/app tears
      // down on close or quit. Errors are swallowed (best-effort persistence).
      try {
        writeFileSync(getWindowStateFilePath(app), JSON.stringify(bounds), { mode: 0o600 });
      } catch (error) {
        console.warn("[windowState] failed to flush bounds:", String(error));
      }
    }
  };
}
