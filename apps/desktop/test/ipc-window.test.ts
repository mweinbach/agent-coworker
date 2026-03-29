import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

import { DESKTOP_IPC_CHANNELS } from "../src/lib/desktopApi";

type FakeWindow = {
  destroyed: boolean;
  maximized: boolean;
  fullScreen: boolean;
  bounds: { x: number; y: number };
  setPositionCalls: Array<{ x: number; y: number }>;
  isDestroyed(): boolean;
  isMaximized(): boolean;
  isFullScreen(): boolean;
  getBounds(): { x: number; y: number };
  setPosition(x: number, y: number): void;
};

const windowsBySenderId = new Map<number, FakeWindow>();

mock.module("electron", () => ({
  app: {
    getPath: () => process.cwd(),
    getAppPath: () => process.cwd(),
    getName: () => "Cowork Test",
    isPackaged: false,
  },
  BrowserWindow: {
    fromWebContents(sender: { id: number }) {
      return windowsBySenderId.get(sender.id) ?? null;
    },
    getFocusedWindow() {
      return null;
    },
  },
  Menu: {
    buildFromTemplate() {
      return {
        popup({ callback }: { callback?: () => void }) {
          callback?.();
        },
      };
    },
  },
  dialog: {
    async showOpenDialog() {
      return { canceled: true, filePaths: [] };
    },
  },
}));

const { registerWindowIpc } = await import("../electron/ipc/window");

class FakeWebContents extends EventEmitter {
  constructor(readonly id: number) {
    super();
  }
}

function createFakeWindow(x = 40, y = 50): FakeWindow {
  return {
    destroyed: false,
    maximized: false,
    fullScreen: false,
    bounds: { x, y },
    setPositionCalls: [],
    isDestroyed() {
      return this.destroyed;
    },
    isMaximized() {
      return this.maximized;
    },
    isFullScreen() {
      return this.fullScreen;
    },
    getBounds() {
      return this.bounds;
    },
    setPosition(nextX: number, nextY: number) {
      this.setPositionCalls.push({ x: nextX, y: nextY });
    },
  };
}

function createHandlers() {
  const handlers = new Map<string, (event: { sender: FakeWebContents }, args?: unknown) => unknown>();
  registerWindowIpc({
    deps: {} as never,
    workspaceRoots: {} as never,
    handleDesktopInvoke(channel, handler) {
      handlers.set(channel, handler as never);
    },
    parseWithSchema(_schema, value) {
      return value as never;
    },
  });
  return handlers;
}

describe("window IPC", () => {
  test("cleans up drag state when the renderer is destroyed", () => {
    windowsBySenderId.clear();
    const handlers = createHandlers();
    const sender = new FakeWebContents(7);
    const win = createFakeWindow();
    windowsBySenderId.set(sender.id, win);

    handlers.get(DESKTOP_IPC_CHANNELS.windowDragStart)?.(
      { sender },
      { screenX: 100, screenY: 100 },
    );

    sender.emit("destroyed");

    handlers.get(DESKTOP_IPC_CHANNELS.windowDragMove)?.(
      { sender },
      { screenX: 140, screenY: 150 },
    );

    expect(win.setPositionCalls).toEqual([]);
  });

  test("does not reuse drag state across IPC registrations", () => {
    windowsBySenderId.clear();
    const sender = new FakeWebContents(11);
    const win = createFakeWindow();
    windowsBySenderId.set(sender.id, win);

    const firstRegistrationHandlers = createHandlers();
    firstRegistrationHandlers.get(DESKTOP_IPC_CHANNELS.windowDragStart)?.(
      { sender },
      { screenX: 100, screenY: 100 },
    );

    const secondRegistrationHandlers = createHandlers();
    secondRegistrationHandlers.get(DESKTOP_IPC_CHANNELS.windowDragMove)?.(
      { sender },
      { screenX: 140, screenY: 150 },
    );

    expect(win.setPositionCalls).toEqual([]);
  });
});
