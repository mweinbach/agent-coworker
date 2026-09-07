import fs from "node:fs/promises";
import path from "node:path";

import type * as Electron from "electron";
import { writeFileAtomic } from "../../../../src/platform/fs";
import { MAIN_WINDOW_MIN_HEIGHT, MAIN_WINDOW_MIN_WIDTH } from "../../src/lib/adaptiveLayout";

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
const activeWindowFlushes = new Set<() => Promise<void>>();
let pendingWindowWrite: Promise<void> = Promise.resolve();

function getWindowStateFilePath(app: Electron.App): string {
  return path.join(app.getPath("userData"), WINDOW_STATE_FILENAME);
}

async function readWindowState(app: Electron.App): Promise<WindowBounds | null> {
  try {
    const raw = await fs.readFile(getWindowStateFilePath(app), "utf8");
    const parsed = JSON.parse(raw) as Partial<WindowBounds>;
    if (
      typeof parsed.width === "number" &&
      Number.isFinite(parsed.width) &&
      parsed.width > 0 &&
      typeof parsed.height === "number" &&
      Number.isFinite(parsed.height) &&
      parsed.height > 0 &&
      typeof parsed.x === "number" &&
      Number.isFinite(parsed.x) &&
      typeof parsed.y === "number" &&
      Number.isFinite(parsed.y)
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
  } catch {
    // Missing or corrupt file on first run / after hand-editing — not an error.
    return null;
  }
}

function writeWindowState(app: Electron.App, payload: string): Promise<void> {
  const write = pendingWindowWrite.then(() =>
    writeFileAtomic(getWindowStateFilePath(app), payload, { mode: 0o600 }),
  );
  pendingWindowWrite = write.catch(() => {
    // Preserve the write chain after a failed resize write; the triggering flush still receives it.
  });
  return write;
}

/** Capture live windows and drain closed-window writes before quitting Electron. */
export async function flushMainWindowBounds(): Promise<void> {
  await Promise.all([...activeWindowFlushes].map((flush) => flush()));
  await pendingWindowWrite;
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
  // Clamp size to the work area unless that display is narrower than the
  // supported minimum. In that edge case, keep restored geometry aligned with
  // BrowserWindow.minWidth instead of handing Electron contradictory bounds.
  const width = Math.max(MAIN_WINDOW_MIN_WIDTH, Math.min(saved.width, workArea.width));
  const height = Math.max(MAIN_WINDOW_MIN_HEIGHT, Math.min(saved.height, workArea.height));
  const minVisibleWidth = Math.min(200, width);
  const minVisibleHeight = Math.min(120, height);

  const x = Math.min(
    Math.max(saved.x, workArea.x - width + minVisibleWidth),
    workArea.x + workArea.width - minVisibleWidth,
  );
  const y = Math.min(
    Math.max(saved.y, workArea.y - height + minVisibleHeight),
    workArea.y + workArea.height - minVisibleHeight,
  );

  return {
    ...saved,
    x,
    y,
    width,
    height,
  };
}

/**
 * Captures the main window's bounds on resize/move/close and persists them.
 * Returns a cleanup function that flushes cached bounds even after destruction.
 * App shutdown also awaits flushMainWindowBounds before allowing process exit.
 */
export function trackMainWindowBounds(
  app: Electron.App,
  win: Electron.BrowserWindow,
): () => Promise<void> {
  let saveHandle: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let bounds: WindowBounds = { ...win.getNormalBounds(), isMaximized: win.isMaximized() };
  let lastPayload: string | undefined;
  let lastWrite = Promise.resolve();

  const captureBounds = () => {
    if (!win.isDestroyed()) {
      bounds = { ...win.getNormalBounds(), isMaximized: win.isMaximized() };
    }
  };

  const save = () => {
    if (saveHandle) {
      clearTimeout(saveHandle);
      saveHandle = undefined;
    }
    captureBounds();
    const payload = JSON.stringify(bounds);
    if (payload === lastPayload) return lastWrite;
    lastPayload = payload;
    lastWrite = writeWindowState(app, payload).catch((error) => {
      if (lastPayload === payload) lastPayload = undefined;
      console.warn("[windowState] failed to persist bounds:", String(error));
    });
    return lastWrite;
  };

  const scheduleSave = () => {
    if (stopped) return;
    captureBounds();
    if (saveHandle) clearTimeout(saveHandle);
    saveHandle = setTimeout(() => {
      saveHandle = undefined;
      void save();
    }, 300);
  };

  win.on("resize", scheduleSave);
  win.on("move", scheduleSave);
  win.on("maximize", scheduleSave);
  win.on("unmaximize", scheduleSave);
  win.on("close", captureBounds);
  activeWindowFlushes.add(save);

  return () => {
    if (stopped) return lastWrite;
    stopped = true;
    activeWindowFlushes.delete(save);
    win.off("resize", scheduleSave);
    win.off("move", scheduleSave);
    win.off("maximize", scheduleSave);
    win.off("unmaximize", scheduleSave);
    win.off("close", captureBounds);
    return save();
  };
}
