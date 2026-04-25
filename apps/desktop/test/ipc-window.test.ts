import { beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

import { DESKTOP_IPC_CHANNELS } from "../src/lib/desktopApi";
import { createElectronMock, setElectronMockOverrides } from "./helpers/mockElectron";

type FakeWindow = {
  destroyed: boolean;
  maximized: boolean;
  fullScreen: boolean;
  bounds: { x: number; y: number };
  setPositionCalls: Array<{ x: number; y: number }>;
  closeCalls: number;
  hideCalls: number;
  isDestroyed(): boolean;
  isMaximized(): boolean;
  isFullScreen(): boolean;
  getBounds(): { x: number; y: number };
  setPosition(x: number, y: number): void;
  close(): void;
  hide(): void;
};

const windowsBySenderId = new Map<number, FakeWindow>();

const electronMockOverrides = {
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
};

setElectronMockOverrides(electronMockOverrides);

mock.module("electron", () => createElectronMock());

const { registerWindowIpc } = await import("../electron/ipc/window");

class FakeWebContents extends EventEmitter {
  constructor(readonly id: number, private readonly url = "file:///renderer/index.html") {
    super();
  }

  getURL() {
    return this.url;
  }
}

function createFakeWindow(x = 40, y = 50): FakeWindow {
  return {
    destroyed: false,
    maximized: false,
    fullScreen: false,
    bounds: { x, y },
    setPositionCalls: [],
    closeCalls: 0,
    hideCalls: 0,
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
    close() {
      this.closeCalls += 1;
    },
    hide() {
      this.hideCalls += 1;
    },
  };
}

function createHandlers() {
  const handlers = new Map<string, (event: { sender: FakeWebContents }, args?: unknown) => unknown>();
  const showMainWindow = mock(async () => {});
  const consumePendingMenuCommands = mock(() => ["openSettings"] as const);
  const showQuickChatWindow = mock(async () => {});
  registerWindowIpc({
    deps: {
      showMainWindow,
      consumePendingMenuCommands,
      showQuickChatWindow,
    } as never,
    workspaceRoots: {} as never,
    handleDesktopInvoke(channel, handler) {
      handlers.set(channel, handler as never);
    },
    parseWithSchema(_schema, value) {
      return value as never;
    },
  });
  return { handlers, consumePendingMenuCommands, showMainWindow, showQuickChatWindow };
}

describe("window IPC", () => {
  beforeEach(() => {
    setElectronMockOverrides(electronMockOverrides);
  });

  test("cleans up drag state when the renderer is destroyed", () => {
    windowsBySenderId.clear();
    const { handlers } = createHandlers();
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

    const { handlers: firstRegistrationHandlers } = createHandlers();
    firstRegistrationHandlers.get(DESKTOP_IPC_CHANNELS.windowDragStart)?.(
      { sender },
      { screenX: 100, screenY: 100 },
    );

    const { handlers: secondRegistrationHandlers } = createHandlers();
    secondRegistrationHandlers.get(DESKTOP_IPC_CHANNELS.windowDragMove)?.(
      { sender },
      { screenX: 140, screenY: 150 },
    );

    expect(win.setPositionCalls).toEqual([]);
  });

  test("exposes show window IPC actions", async () => {
    const { handlers, consumePendingMenuCommands, showMainWindow, showQuickChatWindow } = createHandlers();
    const sender = new FakeWebContents(21);

    await handlers.get(DESKTOP_IPC_CHANNELS.showMainWindow)?.({ sender });
    expect(await handlers.get(DESKTOP_IPC_CHANNELS.consumePendingMenuCommands)?.({ sender })).toEqual(["openSettings"]);
    await handlers.get(DESKTOP_IPC_CHANNELS.showQuickChatWindow)?.({ sender }, { threadId: "thread-21" });

    expect(showMainWindow).toHaveBeenCalledTimes(1);
    expect(consumePendingMenuCommands).toHaveBeenCalledTimes(1);
    expect(showQuickChatWindow).toHaveBeenCalledTimes(1);
    expect(showQuickChatWindow).toHaveBeenCalledWith({ threadId: "thread-21" });
  });

  test("hides popup windows instead of closing them", () => {
    windowsBySenderId.clear();
    const { handlers } = createHandlers();
    const sender = new FakeWebContents(31, "file:///renderer/index.html?window=utility");
    const win = createFakeWindow();
    windowsBySenderId.set(sender.id, win);

    handlers.get(DESKTOP_IPC_CHANNELS.windowClose)?.({ sender });

    expect(win.hideCalls).toBe(1);
    expect(win.closeCalls).toBe(0);
  });

  test("keeps normal close behavior for the main window", () => {
    windowsBySenderId.clear();
    const { handlers } = createHandlers();
    const sender = new FakeWebContents(32, "file:///renderer/index.html");
    const win = createFakeWindow();
    windowsBySenderId.set(sender.id, win);

    handlers.get(DESKTOP_IPC_CHANNELS.windowClose)?.({ sender });

    expect(win.closeCalls).toBe(1);
    expect(win.hideCalls).toBe(0);
  });
});
