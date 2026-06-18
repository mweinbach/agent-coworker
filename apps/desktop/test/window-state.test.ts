import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Import after the shim types are in scope.
import type * as Electron from "electron";

import { loadMainWindowBounds, trackMainWindowBounds } from "../electron/services/windowState";

type Display = { workArea: Electron.Rectangle };

function makeFakeScreen(
  displayFor: Electron.Rectangle,
): Pick<Electron.Screen, "getDisplayMatching"> {
  return {
    getDisplayMatching: (_rect: Electron.Rectangle): Display => ({ workArea: displayFor }),
  };
}

async function makeFakeApp(userDataDir: string) {
  return {
    getPath: (name: string): string => {
      if (name === "userData") return userDataDir;
      throw new Error(`unexpected getPath(${name})`);
    },
  } as unknown as Electron.App;
}

async function writeBoundsFile(userDataDir: string, bounds: Record<string, unknown>) {
  await fs.writeFile(path.join(userDataDir, "window-state.json"), JSON.stringify(bounds), "utf8");
}

describe("windowState", () => {
  let tmpDirs: string[] = [];

  beforeEach(() => {
    tmpDirs = [];
  });

  afterEach(async () => {
    await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function freshUserDataDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "window-state-"));
    tmpDirs.push(dir);
    return dir;
  }

  test("returns null when no saved state exists (first launch)", async () => {
    const app = await makeFakeApp(await freshUserDataDir());
    const screen = makeFakeScreen({ x: 0, y: 0, width: 1920, height: 1080 });
    const result = await loadMainWindowBounds(app, screen);
    expect(result).toBeNull();
  });

  test("restores valid saved bounds", async () => {
    const dir = await freshUserDataDir();
    await writeBoundsFile(dir, { x: 100, y: 200, width: 1240, height: 820 });
    const app = await makeFakeApp(dir);
    const screen = makeFakeScreen({ x: 0, y: 0, width: 1920, height: 1080 });
    const result = await loadMainWindowBounds(app, screen);
    expect(result).toEqual({ x: 100, y: 200, width: 1240, height: 820, isMaximized: false });
  });

  test("clamps a window saved off the display back on-screen", async () => {
    // Saved at x=5000 (far off a 1920-wide display); must be pulled back so
    // at least 200px remains visible on the work area.
    const dir = await freshUserDataDir();
    await writeBoundsFile(dir, { x: 5000, y: 300, width: 1240, height: 820 });
    const app = await makeFakeApp(dir);
    const screen = makeFakeScreen({ x: 0, y: 0, width: 1920, height: 1080 });
    const result = await loadMainWindowBounds(app, screen);
    expect(result).not.toBeNull();
    // Right edge of the clamped window must keep >= minVisibleWidth on-screen.
    expect(result!.x).toBeLessThanOrEqual(1920 - 200);
    expect(result!.x).toBeGreaterThan(0);
    expect(result!.y).toBe(300);
    expect(result!.width).toBe(1240);
    expect(result!.height).toBe(820);
  });

  test("clamps an oversized saved window down to the work area", async () => {
    // Saved at 2560×1600 (e.g. a 4K monitor) but reopened on a 1920×1080 work
    // area. Width/height must clamp to the work area so the window fits.
    const dir = await freshUserDataDir();
    await writeBoundsFile(dir, { x: 0, y: 0, width: 2560, height: 1600 });
    const app = await makeFakeApp(dir);
    const screen = makeFakeScreen({ x: 0, y: 0, width: 1920, height: 1080 });
    const result = await loadMainWindowBounds(app, screen);
    expect(result).not.toBeNull();
    expect(result!.width).toBe(1920);
    expect(result!.height).toBe(1080);
  });

  test("returns null for corrupt / partial saved state", async () => {
    const dir = await freshUserDataDir();
    await writeBoundsFile(dir, { x: 100, width: 1240 }); // missing y, height
    const app = await makeFakeApp(dir);
    const screen = makeFakeScreen({ x: 0, y: 0, width: 1920, height: 1080 });
    const result = await loadMainWindowBounds(app, screen);
    expect(result).toBeNull();
  });

  test("preserves isMaximized flag", async () => {
    const dir = await freshUserDataDir();
    await writeBoundsFile(dir, { x: 100, y: 200, width: 1240, height: 820, isMaximized: true });
    const app = await makeFakeApp(dir);
    const screen = makeFakeScreen({ x: 0, y: 0, width: 1920, height: 1080 });
    const result = await loadMainWindowBounds(app, screen);
    expect(result?.isMaximized).toBe(true);
  });

  test("trackMainWindowBounds persists bounds on cleanup flush", async () => {
    const dir = await freshUserDataDir();
    const app = await makeFakeApp(dir);
    let lastResizeBounds: Electron.Rectangle = { x: 50, y: 60, width: 1000, height: 700 };
    const fakeWin = {
      isDestroyed: () => false,
      getPosition: () => [lastResizeBounds.x, lastResizeBounds.y] as [number, number],
      getSize: () => [lastResizeBounds.width, lastResizeBounds.height] as [number, number],
      isMaximized: () => false,
      on: () => {},
      off: () => {},
    } as unknown as Electron.BrowserWindow;

    const cleanup = trackMainWindowBounds(app, fakeWin);
    // Simulate the final state changing before cleanup runs.
    lastResizeBounds = { x: 77, y: 88, width: 1100, height: 750 };
    cleanup();

    const raw = await fs.readFile(path.join(dir, "window-state.json"), "utf8");
    const saved = JSON.parse(raw);
    expect(saved).toEqual({ x: 77, y: 88, width: 1100, height: 750, isMaximized: false });
  });
});
