import path from "node:path";
import { EventEmitter } from "node:events";

import { describe, expect, mock, test } from "bun:test";

import { resolveTrayIconPath } from "../electron/services/trayIcon";
import { createTrayMaskBitmap } from "../electron/services/trayImage";

const createdTrays: FakeTray[] = [];

class FakeTray extends EventEmitter {
  tooltip: string | null = null;
  contextMenu: unknown = null;
  destroyed = false;

  constructor(readonly _icon: unknown) {
    super();
    createdTrays.push(this);
  }

  setToolTip(value: string) {
    this.tooltip = value;
  }

  setContextMenu(menu: unknown) {
    this.contextMenu = menu;
  }

  getBounds() {
    return { x: 20, y: 20, width: 20, height: 20 };
  }

  popUpContextMenu(menu: unknown) {
    this.contextMenu = menu;
  }

  destroy() {
    this.destroyed = true;
  }
}

mock.module("electron", () => ({
  app: {
    quit: () => {},
  },
  globalShortcut: {
    register: () => true,
    unregister: () => {},
  },
  Menu: {
    buildFromTemplate(template: unknown) {
      return template;
    },
  },
  Tray: FakeTray,
  nativeImage: {
    createFromPath() {
      return {
        isEmpty: () => false,
        resize: () => ({
          isEmpty: () => false,
          getSize: () => ({ width: 18, height: 18 }),
          toBitmap: () => Buffer.alloc(18 * 18 * 4),
        }),
      };
    },
    createEmpty() {
      return {
        isEmpty: () => true,
        resize: () => ({
          isEmpty: () => true,
        }),
      };
    },
    createFromBitmap() {
      return {
        setTemplateImage: () => {},
      };
    },
  },
  screen: {
    getDisplayMatching() {
      return { workArea: { x: 0, y: 0, width: 1440, height: 900 } };
    },
    getDisplayNearestPoint() {
      return { workArea: { x: 0, y: 0, width: 1440, height: 900 } };
    },
    getCursorScreenPoint() {
      return { x: 0, y: 0 };
    },
  },
}));

const { QuickChatController } = await import("../electron/services/quickChatController");

class FakeWindow extends EventEmitter {
  destroyed = false;
  visible = false;
  focused = false;
  bounds = { x: 0, y: 0, width: 420, height: 520 };

  isDestroyed() {
    return this.destroyed;
  }

  isVisible() {
    return this.visible;
  }

  isFocused() {
    return this.focused;
  }

  isMinimized() {
    return false;
  }

  restore() {}

  show() {
    this.visible = true;
  }

  focus() {
    this.focused = true;
  }

  hide() {
    this.visible = false;
    this.focused = false;
  }

  destroy() {
    this.destroyed = true;
    this.emit("closed");
  }

  getBounds() {
    return this.bounds;
  }

  setBounds(bounds: typeof this.bounds) {
    this.bounds = bounds;
  }
}

describe("resolveTrayIconPath", () => {
  test("uses the packaged resources tray asset on macOS", () => {
    const resolvedPath = resolveTrayIconPath("/tmp/app.asar/out/main", {
      isPackaged: true,
      platform: "darwin",
      resourcesPath: "/Applications/Cowork.app/Contents/Resources",
    });

    expect(resolvedPath).toBe("/Applications/Cowork.app/Contents/Resources/tray/icon.png");
  });

  test("uses the packaged resources tray asset on Windows", () => {
    const resolvedPath = resolveTrayIconPath("C:\\Program Files\\Cowork\\resources\\app.asar\\out\\main", {
      isPackaged: true,
      platform: "win32",
      resourcesPath: "C:\\Program Files\\Cowork\\resources",
    });

    expect(resolvedPath).toBe(path.join("C:\\Program Files\\Cowork\\resources", "tray", "icon.ico"));
  });

  test("prefers the desktop build directory when running from out/main", () => {
    const rootDir = "/Users/jasoncantor/Downloads/agent-coworker/apps/desktop/out/main";
    const resolvedPath = resolveTrayIconPath(rootDir, {
      isPackaged: false,
      platform: "darwin",
      pathExists: (candidatePath) => candidatePath === "/Users/jasoncantor/Downloads/agent-coworker/apps/desktop/build/icon.png",
    });

    expect(resolvedPath).toBe("/Users/jasoncantor/Downloads/agent-coworker/apps/desktop/build/icon.png");
  });

  test("falls back to the primary dev candidate when probing cannot find the asset", () => {
    const rootDir = "/Users/jasoncantor/Downloads/agent-coworker/apps/desktop/out/main";
    const resolvedPath = resolveTrayIconPath(rootDir, {
      isPackaged: false,
      platform: "darwin",
      pathExists: () => false,
    });

    expect(resolvedPath).toBe("/Users/jasoncantor/Downloads/agent-coworker/apps/desktop/build/icon.png");
  });

  test("builds a black alpha mask for macOS tray icons", () => {
    const bitmap = Buffer.from([
      255, 255, 255, 255,
      0, 0, 0, 255,
    ]);

    const masked = createTrayMaskBitmap(bitmap);

    expect([...masked]).toEqual([
      0, 0, 0, 0,
      0, 0, 0, 255,
    ]);
  });

  test("opens the utility window when the tray icon is clicked", async () => {
    createdTrays.length = 0;
    const createUtilityWindow = mock(async () => new FakeWindow() as never);
    const createQuickChatWindow = mock(async () => new FakeWindow() as never);
    const controller = new QuickChatController({
      appName: "Cowork",
      platform: "darwin",
      trayIconPath: "/tmp/icon.png",
      getMainWindow: () => null,
      createMainWindow: async () => new FakeWindow() as never,
      createQuickChatWindow,
      createUtilityWindow,
    });

    controller.initialize();

    const tray = createdTrays[0];
    if (!tray) {
      throw new Error("expected tray to be created");
    }

    tray.emit("click");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(createUtilityWindow).toHaveBeenCalledTimes(1);
    expect(createQuickChatWindow).toHaveBeenCalledTimes(0);
  });
});
