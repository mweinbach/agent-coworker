import { beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import path from "node:path";

import { resolveTrayIconPath } from "../electron/services/trayIcon";
import { createTrayMaskBitmap } from "../electron/services/trayImage";
import { createElectronMock, setElectronMockOverrides } from "./helpers/mockElectron";

const createdTrays: FakeTray[] = [];
const globalShortcutState = {
  registeredAccelerators: [] as string[],
  unregisteredAccelerators: [] as string[],
  callbacks: new Map<string, () => void>(),
  registerResult: true,
  registerError: null as Error | null,
};

function resetGlobalShortcutState() {
  globalShortcutState.registeredAccelerators.length = 0;
  globalShortcutState.unregisteredAccelerators.length = 0;
  globalShortcutState.callbacks.clear();
  globalShortcutState.registerResult = true;
  globalShortcutState.registerError = null;
}

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

const electronMockOverrides = {
  app: {
    focus: () => {},
    isHidden: () => false,
    show: () => {},
    quit: () => {},
  },
  globalShortcut: {
    register: (accelerator: string, callback: () => void) => {
      globalShortcutState.registeredAccelerators.push(accelerator);
      globalShortcutState.callbacks.set(accelerator, callback);
      if (globalShortcutState.registerError) {
        throw globalShortcutState.registerError;
      }
      return globalShortcutState.registerResult;
    },
    unregister: (accelerator: string) => {
      globalShortcutState.unregisteredAccelerators.push(accelerator);
      globalShortcutState.callbacks.delete(accelerator);
    },
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
};

setElectronMockOverrides(electronMockOverrides);

mock.module("electron", () => createElectronMock());

const { QuickChatController } = await import("../electron/services/quickChatController");

class FakeWindow extends EventEmitter {
  destroyed = false;
  visible = false;
  focused = false;
  bounds = { x: 0, y: 0, width: 420, height: 520 };
  closeCalls = 0;

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

  close() {
    this.closeCalls += 1;
    const event = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    this.emit("close", event);
    if (!event.defaultPrevented) {
      this.destroy();
    }
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

type ControllerOptions = ConstructorParameters<typeof QuickChatController>[0];

function createController(overrides: Partial<ControllerOptions> = {}) {
  return new QuickChatController({
    appName: "Cowork",
    platform: "darwin",
    trayIconPath: "/tmp/icon.png",
    getMainWindow: () => null,
    createMainWindow: async () => new FakeWindow() as never,
    createQuickChatWindow: async () => new FakeWindow() as never,
    retargetQuickChatWindow: async () => {},
    createUtilityWindow: async () => new FakeWindow() as never,
    ...overrides,
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("quick chat window ownership", () => {
  beforeEach(() => {
    setElectronMockOverrides(electronMockOverrides);
  });

  for (const surface of ["quick-chat", "utility"] as const) {
    test(`shares concurrent ${surface} creation and owns every created window`, async () => {
      const gate = deferred();
      const windows: FakeWindow[] = [];
      const createWindow = mock(async () => {
        await gate.promise;
        const window = new FakeWindow();
        windows.push(window);
        return window as never;
      });
      const controller = createController(
        surface === "quick-chat"
          ? { createQuickChatWindow: createWindow }
          : { createUtilityWindow: createWindow },
      );
      const show = () =>
        surface === "quick-chat"
          ? controller.showQuickChatWindow()
          : controller.showUtilityWindow();
      const first = show();
      const second = show();
      gate.resolve();
      await Promise.all([first, second]);
      controller.dispose();

      expect(createWindow).toHaveBeenCalledTimes(1);
      expect(windows.every((window) => window.destroyed)).toBe(true);
    });

    test(`disposes ${surface} creation that finishes after shutdown`, async () => {
      const gate = deferred();
      const window = new FakeWindow();
      const createWindow = async () => {
        await gate.promise;
        return window as never;
      };
      const controller = createController(
        surface === "quick-chat"
          ? { createQuickChatWindow: createWindow }
          : { createUtilityWindow: createWindow },
      );
      const showing =
        surface === "quick-chat"
          ? controller.showQuickChatWindow()
          : controller.showUtilityWindow();
      await Promise.resolve();
      controller.dispose();
      gate.resolve();
      await showing;

      expect(window.destroyed).toBe(true);
      expect(window.visible).toBe(false);
    });
  }

  test("does not reopen a slow quick chat over a newer main-window request", async () => {
    const gate = deferred();
    const quickChatWindow = new FakeWindow();
    const mainWindow = new FakeWindow();
    const controller = createController({
      getMainWindow: () => mainWindow as never,
      createQuickChatWindow: async () => {
        await gate.promise;
        return quickChatWindow as never;
      },
    });

    const showing = controller.showQuickChatWindow();
    await controller.showMainWindow();
    gate.resolve();
    await showing;

    expect(mainWindow.visible).toBe(true);
    expect(quickChatWindow.visible).toBe(false);
    expect(quickChatWindow.destroyed).toBe(true);
    controller.dispose();
  });

  test("retires a slow utility popup superseded by main without a tray", async () => {
    const gate = deferred();
    const utilityWindow = new FakeWindow();
    const mainWindow = new FakeWindow();
    const controller = createController({
      platform: "win32",
      getMainWindow: () => mainWindow as never,
      createUtilityWindow: async () => {
        await gate.promise;
        return utilityWindow as never;
      },
    });

    const showing = controller.showUtilityWindow();
    await controller.showMainWindow();
    gate.resolve();
    await showing;

    expect(utilityWindow.destroyed).toBe(true);
    expect(mainWindow.visible).toBe(true);
    controller.dispose();
  });

  test("shares main-window creation before the window becomes available", async () => {
    const gate = deferred();
    const window = new FakeWindow();
    const createMainWindow = mock(async () => {
      await gate.promise;
      return window as never;
    });
    const controller = createController({ createMainWindow });

    const first = controller.showMainWindow();
    const second = controller.showMainWindow();
    gate.resolve();
    await Promise.all([first, second]);

    expect(createMainWindow).toHaveBeenCalledTimes(1);
    expect(window.visible).toBe(true);
    controller.dispose();
  });

  test("serializes quick-chat retargets and remains usable after a failed request", async () => {
    const gate = deferred();
    const window = new FakeWindow();
    const retarget = mock(async (_window: unknown, opts?: { threadId?: string }) => {
      if (opts?.threadId === "first") {
        await gate.promise;
        throw new Error("renderer load failed");
      }
    });
    const controller = createController({
      createQuickChatWindow: async () => window as never,
      retargetQuickChatWindow: retarget,
    });
    await controller.showQuickChatWindow();

    const first = controller
      .showQuickChatWindow({ threadId: "first" })
      .catch((error: unknown) => error);
    const second = controller.showQuickChatWindow({ threadId: "second" });
    await Promise.resolve();
    const callsBeforeRelease = retarget.mock.calls.length;
    gate.resolve();
    expect(await first).toBeInstanceOf(Error);
    await second;

    expect(callsBeforeRelease).toBe(1);
    expect(retarget.mock.calls.map((call) => call[1]?.threadId)).toEqual(["first", "second"]);
    expect(window.visible).toBe(true);
    controller.dispose();
  });
});

describe("native quit coordination", () => {
  const enabledShortcutState = {
    version: 2 as const,
    workspaces: [],
    threads: [],
    desktopSettings: {
      quickChat: { iconEnabled: true, shortcutEnabled: true, shortcutAccelerator: "Alt+Space" },
    },
  };

  beforeEach(() => {
    createdTrays.length = 0;
    resetGlobalShortcutState();
    setElectronMockOverrides(electronMockOverrides);
  });

  for (const surface of ["quick-chat", "utility"] as const) {
    const show = (controller: InstanceType<typeof QuickChatController>) =>
      surface === "quick-chat" ? controller.showQuickChatWindow() : controller.showUtilityWindow();
    const withFactory = (factory: ControllerOptions["createUtilityWindow"]) =>
      surface === "quick-chat"
        ? { createQuickChatWindow: factory }
        : { createUtilityWindow: factory };

    test.each(["darwin", "win32"] as const)(
      `allows native ${surface} close on %s without disposing integrations`,
      async (platform) => {
        const window = new FakeWindow();
        const controller = createController({
          platform,
          ...withFactory(async () => window as never),
        });
        controller.applyPersistedState(enabledShortcutState);
        await show(controller);

        controller.setQuitPending(true);
        expect(controller.shouldKeepPopupWindowsAlive()).toBe(false);
        expect(window.destroyed).toBe(false);
        expect(controller.hasTray()).toBe(true);
        expect(globalShortcutState.unregisteredAccelerators).toEqual([]);
        window.close();
        expect(window.destroyed).toBe(true);
        expect(createdTrays[0]?.destroyed).toBe(false);

        controller.dispose();
        controller.setQuitPending(false);
        controller.initialize();
        await show(controller);
        expect(controller.hasTray()).toBe(false);
        expect(createdTrays).toHaveLength(1);
        expect(globalShortcutState.unregisteredAccelerators).toEqual(["Alt+Space"]);
      },
    );

    test.each(["darwin", "win32"] as const)(
      `restores ${surface} keepalive on %s after cancelled native quit`,
      async (platform) => {
        const window = new FakeWindow();
        const createWindow = mock(async () => window as never);
        const retarget = mock(async () => {});
        const controller = createController({
          platform,
          ...withFactory(createWindow),
          retargetQuickChatWindow: retarget,
        });
        controller.applyPersistedState(enabledShortcutState);
        await show(controller);
        controller.setQuitPending(true);
        window.once("close", (event) => event.preventDefault());
        window.close();
        expect(window.destroyed).toBe(false);
        expect(window.visible).toBe(true);
        await controller.showQuickChatWindow({ threadId: "ignored-during-quit" });
        expect(retarget).not.toHaveBeenCalled();

        controller.setQuitPending(false);
        expect(controller.shouldKeepPopupWindowsAlive()).toBe(true);
        window.close();
        expect(window.destroyed).toBe(false);
        expect(window.visible).toBe(false);
        await show(controller);
        expect(createWindow).toHaveBeenCalledTimes(1);
        expect(window.visible).toBe(true);
        expect(globalShortcutState.unregisteredAccelerators).toEqual([]);
        controller.dispose();
      },
    );

    test(`retires late ${surface} creation and skips queued work during native quit`, async () => {
      const gate = deferred();
      const entered = deferred();
      const windows: FakeWindow[] = [];
      const createWindow = mock(async () => {
        entered.resolve();
        await gate.promise;
        const window = new FakeWindow();
        windows.push(window);
        return window as never;
      });
      const controller = createController(withFactory(createWindow));
      controller.initialize();
      const first = show(controller);
      await entered.promise;
      const queued = show(controller);
      controller.setQuitPending(true);
      gate.resolve();
      await Promise.all([first, queued]);
      expect(createWindow).toHaveBeenCalledTimes(1);
      expect(windows[0]?.destroyed).toBe(true);
      expect(windows[0]?.visible).toBe(false);
      expect(controller.hasTray()).toBe(true);

      controller.setQuitPending(false);
      await show(controller);
      expect(createWindow).toHaveBeenCalledTimes(2);
      expect(windows[1]?.visible).toBe(true);
      controller.dispose();
    });

    test(`does not revive queued ${surface} creation when native quit is cancelled`, async () => {
      const createWindow = mock(async () => new FakeWindow() as never);
      const controller = createController(withFactory(createWindow));
      const queued = show(controller);
      controller.setQuitPending(true);
      controller.setQuitPending(false);
      await queued;
      expect(createWindow).not.toHaveBeenCalled();
      await show(controller);
      expect(createWindow).toHaveBeenCalledTimes(1);
      controller.dispose();
    });
  }

  test("suppresses window requests and tray/shortcut callbacks while native quit is pending", async () => {
    const createWindow = mock(async () => new FakeWindow() as never);
    const controller = createController({
      createMainWindow: createWindow,
      createQuickChatWindow: createWindow,
      createUtilityWindow: createWindow,
    });
    controller.applyPersistedState(enabledShortcutState);
    controller.setQuitPending(true);
    await Promise.all([
      controller.showMainWindow(),
      controller.showQuickChatWindow(),
      controller.toggleQuickChatWindow(),
      controller.showUtilityWindow(),
      controller.toggleUtilityWindow(),
    ]);
    globalShortcutState.callbacks.get("Alt+Space")?.();
    createdTrays[0]?.emit("click");
    createdTrays[0]?.emit("double-click");
    createdTrays[0]?.emit("right-click");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(createWindow).not.toHaveBeenCalled();
    expect(createdTrays[0]?.contextMenu).toBe(null);
    expect(globalShortcutState.callbacks.has("Alt+Space")).toBe(true);
    controller.dispose();
  });

  test("does not resume queued retargets after a cancelled quit", async () => {
    const gate = deferred();
    const entered = deferred();
    const window = new FakeWindow();
    const retarget = mock(async () => {
      entered.resolve();
      await gate.promise;
    });
    const controller = createController({
      createQuickChatWindow: async () => window as never,
      retargetQuickChatWindow: retarget,
    });
    await controller.showQuickChatWindow();
    window.hide();
    const first = controller.showQuickChatWindow({ threadId: "first" });
    await entered.promise;
    const queued = controller.showQuickChatWindow({ threadId: "stale" });
    controller.setQuitPending(true);
    controller.setQuitPending(false);
    gate.resolve();
    await Promise.all([first, queued]);

    expect(retarget).toHaveBeenCalledTimes(1);
    expect(window.visible).toBe(false);
    expect(window.destroyed).toBe(false);
    await controller.showQuickChatWindow({ threadId: "fresh" });
    expect(retarget).toHaveBeenCalledTimes(2);
    expect(window.visible).toBe(true);
    controller.dispose();
  });

  test("defers settings-driven native integration changes until quit is cancelled", () => {
    const controller = createController();
    controller.applyPersistedState(enabledShortcutState);
    controller.setQuitPending(true);
    controller.applyPersistedState({
      ...enabledShortcutState,
      desktopFeatureFlagOverrides: { menuBar: false },
    });
    controller.initialize();
    expect(controller.hasTray()).toBe(true);
    expect(globalShortcutState.unregisteredAccelerators).toEqual([]);

    controller.setQuitPending(false);
    expect(controller.hasTray()).toBe(false);
    expect(globalShortcutState.unregisteredAccelerators).toEqual(["Alt+Space"]);
    controller.dispose();
  });
});

describe("resolveTrayIconPath", () => {
  beforeEach(() => {
    createdTrays.length = 0;
    resetGlobalShortcutState();
    setElectronMockOverrides(electronMockOverrides);
  });

  test("uses the packaged resources tray asset on macOS", () => {
    const resolvedPath = resolveTrayIconPath("/tmp/app.asar/out/main", {
      isPackaged: true,
      platform: "darwin",
      resourcesPath: "/Applications/Cowork.app/Contents/Resources",
    });

    expect(resolvedPath).toBe("/Applications/Cowork.app/Contents/Resources/tray/icon.png");
  });

  test("uses the packaged resources tray asset on Windows", () => {
    const resolvedPath = resolveTrayIconPath(
      "C:\\Program Files\\Cowork\\resources\\app.asar\\out\\main",
      {
        isPackaged: true,
        platform: "win32",
        resourcesPath: "C:\\Program Files\\Cowork\\resources",
      },
    );

    expect(resolvedPath).toBe(
      path.win32.join("C:\\Program Files\\Cowork\\resources", "tray", "icon.ico"),
    );
  });

  test("prefers the desktop build directory when running from out/main", () => {
    const rootDir = "/Users/jasoncantor/Downloads/agent-coworker/apps/desktop/out/main";
    const resolvedPath = resolveTrayIconPath(rootDir, {
      isPackaged: false,
      platform: "darwin",
      pathExists: (candidatePath) =>
        candidatePath === "/Users/jasoncantor/Downloads/agent-coworker/apps/desktop/build/icon.png",
    });

    expect(resolvedPath).toBe(
      "/Users/jasoncantor/Downloads/agent-coworker/apps/desktop/build/icon.png",
    );
  });

  test("falls back to the primary dev candidate when probing cannot find the asset", () => {
    const rootDir = "/Users/jasoncantor/Downloads/agent-coworker/apps/desktop/out/main";
    const resolvedPath = resolveTrayIconPath(rootDir, {
      isPackaged: false,
      platform: "darwin",
      pathExists: () => false,
    });

    expect(resolvedPath).toBe(
      "/Users/jasoncantor/Downloads/agent-coworker/apps/desktop/build/icon.png",
    );
  });

  test("builds a black alpha mask for macOS tray icons", () => {
    const bitmap = Buffer.from([255, 255, 255, 255, 0, 0, 0, 255]);

    const masked = createTrayMaskBitmap(bitmap);

    expect([...masked]).toEqual([0, 0, 0, 0, 0, 0, 0, 255]);
  });

  test("opens the utility window when the tray icon is clicked", async () => {
    createdTrays.length = 0;
    const createUtilityWindow = mock(async () => new FakeWindow() as never);
    const createQuickChatWindow = mock(async () => new FakeWindow() as never);
    const retargetQuickChatWindow = mock(async () => {});
    const controller = new QuickChatController({
      appName: "Cowork",
      platform: "darwin",
      trayIconPath: "/tmp/icon.png",
      getMainWindow: () => null,
      createMainWindow: async () => new FakeWindow() as never,
      createQuickChatWindow,
      retargetQuickChatWindow,
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
    expect(retargetQuickChatWindow).toHaveBeenCalledTimes(0);
    expect(tray.contextMenu).toBe(null);
  });

  test("opens the native tray menu only from the secondary tray click on macOS", () => {
    createdTrays.length = 0;
    const controller = new QuickChatController({
      appName: "Cowork",
      platform: "darwin",
      trayIconPath: "/tmp/icon.png",
      getMainWindow: () => null,
      createMainWindow: async () => new FakeWindow() as never,
      createQuickChatWindow: async () => new FakeWindow() as never,
      retargetQuickChatWindow: async () => {},
      createUtilityWindow: async () => new FakeWindow() as never,
    });

    controller.initialize();

    const tray = createdTrays[0];
    if (!tray) {
      throw new Error("expected tray to be created");
    }

    expect(tray.contextMenu).toBe(null);

    tray.emit("right-click");

    expect(Array.isArray(tray.contextMenu)).toBe(true);
  });

  test("removes the tray when the menu bar feature flag is disabled", () => {
    createdTrays.length = 0;
    const controller = new QuickChatController({
      appName: "Cowork",
      platform: "darwin",
      trayIconPath: "/tmp/icon.png",
      getMainWindow: () => null,
      createMainWindow: async () => new FakeWindow() as never,
      createQuickChatWindow: async () => new FakeWindow() as never,
      retargetQuickChatWindow: async () => {},
      createUtilityWindow: async () => new FakeWindow() as never,
    });

    controller.initialize();
    expect(createdTrays).toHaveLength(1);
    expect(createdTrays[0]?.destroyed).toBe(false);

    controller.applyPersistedState({
      version: 2,
      workspaces: [],
      threads: [],
      desktopFeatureFlagOverrides: {
        menuBar: false,
      },
    });

    expect(createdTrays[0]?.destroyed).toBe(true);
    expect(controller.hasTray()).toBe(false);
  });

  test("removes the tray when the quick chat icon setting is disabled", () => {
    const controller = new QuickChatController({
      appName: "Cowork",
      platform: "darwin",
      trayIconPath: "/tmp/icon.png",
      getMainWindow: () => null,
      createMainWindow: async () => new FakeWindow() as never,
      createQuickChatWindow: async () => new FakeWindow() as never,
      retargetQuickChatWindow: async () => {},
      createUtilityWindow: async () => new FakeWindow() as never,
    });

    controller.initialize();
    expect(createdTrays).toHaveLength(1);
    expect(controller.hasTray()).toBe(true);

    controller.applyPersistedState({
      version: 2,
      workspaces: [],
      threads: [],
      desktopSettings: {
        quickChat: {
          iconEnabled: false,
          shortcutEnabled: false,
          shortcutAccelerator: "CommandOrControl+Shift+Space",
        },
      },
    });

    expect(createdTrays[0]?.destroyed).toBe(true);
    expect(controller.hasTray()).toBe(false);
  });

  test("registers and unregisters the quick chat shortcut from persisted settings", () => {
    const controller = createController();

    controller.initialize();
    expect(globalShortcutState.registeredAccelerators).toEqual([]);

    controller.applyPersistedState({
      version: 2,
      workspaces: [],
      threads: [],
      desktopSettings: {
        quickChat: {
          iconEnabled: true,
          shortcutEnabled: true,
          shortcutAccelerator: "Alt+Space",
        },
      },
    });

    expect(globalShortcutState.registeredAccelerators).toEqual(["Alt+Space"]);
    expect(globalShortcutState.unregisteredAccelerators).toEqual([]);

    controller.applyPersistedState({
      version: 2,
      workspaces: [],
      threads: [],
      desktopSettings: {
        quickChat: {
          iconEnabled: true,
          shortcutEnabled: false,
          shortcutAccelerator: "Alt+Space",
        },
      },
    });

    expect(globalShortcutState.registeredAccelerators).toEqual(["Alt+Space"]);
    expect(globalShortcutState.unregisteredAccelerators).toEqual(["Alt+Space"]);
  });

  test("unregisters the quick chat shortcut when the menu bar feature is disabled", () => {
    const controller = createController();

    controller.applyPersistedState({
      version: 2,
      workspaces: [],
      threads: [],
      desktopSettings: {
        quickChat: {
          iconEnabled: true,
          shortcutEnabled: true,
          shortcutAccelerator: "CommandOrControl+Shift+Space",
        },
      },
    });

    controller.applyPersistedState({
      version: 2,
      workspaces: [],
      threads: [],
      desktopFeatureFlagOverrides: {
        menuBar: false,
      },
      desktopSettings: {
        quickChat: {
          iconEnabled: true,
          shortcutEnabled: true,
          shortcutAccelerator: "CommandOrControl+Shift+Space",
        },
      },
    });

    expect(globalShortcutState.registeredAccelerators).toEqual(["CommandOrControl+Shift+Space"]);
    expect(globalShortcutState.unregisteredAccelerators).toEqual(["CommandOrControl+Shift+Space"]);
  });

  test("retries quick chat shortcut registration after Electron rejects an accelerator", () => {
    const controller = createController();
    globalShortcutState.registerResult = false;

    controller.applyPersistedState({
      version: 2,
      workspaces: [],
      threads: [],
      desktopSettings: {
        quickChat: {
          iconEnabled: true,
          shortcutEnabled: true,
          shortcutAccelerator: "Alt+Space",
        },
      },
    });

    globalShortcutState.registerResult = true;
    controller.applyPersistedState({
      version: 2,
      workspaces: [],
      threads: [],
      desktopSettings: {
        quickChat: {
          iconEnabled: true,
          shortcutEnabled: true,
          shortcutAccelerator: "Alt+Space",
        },
      },
    });

    expect(globalShortcutState.registeredAccelerators).toEqual(["Alt+Space", "Alt+Space"]);
    expect(globalShortcutState.unregisteredAccelerators).toEqual([]);
  });

  test("replaces the registered shortcut when the accelerator changes", () => {
    const controller = createController();

    controller.applyPersistedState({
      version: 2,
      workspaces: [],
      threads: [],
      desktopSettings: {
        quickChat: {
          iconEnabled: true,
          shortcutEnabled: true,
          shortcutAccelerator: "CommandOrControl+Shift+Space",
        },
      },
    });
    controller.applyPersistedState({
      version: 2,
      workspaces: [],
      threads: [],
      desktopSettings: {
        quickChat: {
          iconEnabled: true,
          shortcutEnabled: true,
          shortcutAccelerator: "CommandOrControl+Shift+K",
        },
      },
    });

    expect(globalShortcutState.registeredAccelerators).toEqual([
      "CommandOrControl+Shift+Space",
      "CommandOrControl+Shift+K",
    ]);
    expect(globalShortcutState.unregisteredAccelerators).toEqual(["CommandOrControl+Shift+Space"]);
  });

  test("reports tray availability while the tray surface is active", () => {
    createdTrays.length = 0;
    const controller = new QuickChatController({
      appName: "Cowork",
      platform: "win32",
      trayIconPath: "/tmp/icon.ico",
      getMainWindow: () => null,
      createMainWindow: async () => new FakeWindow() as never,
      createQuickChatWindow: async () => new FakeWindow() as never,
      retargetQuickChatWindow: async () => {},
      createUtilityWindow: async () => new FakeWindow() as never,
    });

    controller.initialize();

    expect(controller.hasTray()).toBe(true);
  });

  test("destroys utility windows but keeps quick chat usable when the menu bar feature is disabled", async () => {
    createdTrays.length = 0;
    const quickChatWindow = new FakeWindow();
    const utilityWindow = new FakeWindow();
    const controller = new QuickChatController({
      appName: "Cowork",
      platform: "win32",
      trayIconPath: "/tmp/icon.ico",
      getMainWindow: () => null,
      createMainWindow: async () => new FakeWindow() as never,
      createQuickChatWindow: async () => quickChatWindow as never,
      retargetQuickChatWindow: async () => {},
      createUtilityWindow: async () => utilityWindow as never,
    });

    controller.initialize();
    await controller.showQuickChatWindow();
    await controller.showUtilityWindow();

    controller.applyPersistedState({
      version: 2,
      workspaces: [],
      threads: [],
      desktopFeatureFlagOverrides: {
        menuBar: false,
      },
    });

    expect(quickChatWindow.destroyed).toBe(false);
    expect(utilityWindow.destroyed).toBe(true);
    expect(controller.hasTray()).toBe(false);
  });

  test("keeps quick chat windows alive on trayless platforms during state sync", async () => {
    const quickChatWindow = new FakeWindow();
    const controller = new QuickChatController({
      appName: "Cowork",
      platform: "linux",
      trayIconPath: "/tmp/icon.png",
      getMainWindow: () => null,
      createMainWindow: async () => new FakeWindow() as never,
      createQuickChatWindow: async () => quickChatWindow as never,
      retargetQuickChatWindow: async () => {},
      createUtilityWindow: async () => new FakeWindow() as never,
    });

    controller.initialize();
    await controller.showQuickChatWindow();

    controller.applyPersistedState({
      version: 2,
      workspaces: [],
      threads: [],
    });

    expect(quickChatWindow.destroyed).toBe(false);
    expect(createdTrays).toHaveLength(0);
    expect(controller.hasTray()).toBe(false);
  });

  test("positions anchored macOS popup windows below the tray icon", async () => {
    const utilityWindow = new FakeWindow();
    const controller = createController({
      platform: "darwin",
      createUtilityWindow: async () => utilityWindow as never,
    });

    await controller.showUtilityWindow({ x: 600, y: 20, width: 40, height: 22 });

    expect(utilityWindow.bounds).toEqual({ x: 410, y: 52, width: 420, height: 520 });
  });

  test("positions anchored Windows popup windows above and right-aligned to the tray icon", async () => {
    const utilityWindow = new FakeWindow();
    const controller = createController({
      platform: "win32",
      trayIconPath: "/tmp/icon.ico",
      createUtilityWindow: async () => utilityWindow as never,
    });

    await controller.showUtilityWindow({ x: 600, y: 700, width: 40, height: 22 });

    expect(utilityWindow.bounds).toEqual({ x: 220, y: 170, width: 420, height: 520 });
  });

  test("centers unanchored quick chat windows in the active work area", async () => {
    const quickChatWindow = new FakeWindow();
    const controller = createController({
      platform: "linux",
      createQuickChatWindow: async () => quickChatWindow as never,
    });

    await controller.showQuickChatWindow();

    expect(quickChatWindow.bounds).toEqual({ x: 510, y: 190, width: 420, height: 520 });
  });

  test("closes quick chat when opening the main window without popup keep-alive", async () => {
    createdTrays.length = 0;
    const mainWindow = new FakeWindow();
    const quickChatWindow = new FakeWindow();
    const controller = new QuickChatController({
      appName: "Cowork",
      platform: "linux",
      trayIconPath: "/tmp/icon.png",
      getMainWindow: () => mainWindow as never,
      createMainWindow: async () => mainWindow as never,
      createQuickChatWindow: async () => quickChatWindow as never,
      retargetQuickChatWindow: async () => {},
      createUtilityWindow: async () => new FakeWindow() as never,
    });

    controller.initialize();
    await controller.showQuickChatWindow();
    await controller.showMainWindow();

    expect(quickChatWindow.closeCalls).toBe(1);
    expect(quickChatWindow.destroyed).toBe(true);
    expect(mainWindow.visible).toBe(true);
    expect(mainWindow.focused).toBe(true);
  });

  test("hides quick chat when opening the main window with popup keep-alive", async () => {
    createdTrays.length = 0;
    const mainWindow = new FakeWindow();
    const quickChatWindow = new FakeWindow();
    const controller = new QuickChatController({
      appName: "Cowork",
      platform: "darwin",
      trayIconPath: "/tmp/icon.png",
      getMainWindow: () => mainWindow as never,
      createMainWindow: async () => mainWindow as never,
      createQuickChatWindow: async () => quickChatWindow as never,
      retargetQuickChatWindow: async () => {},
      createUtilityWindow: async () => new FakeWindow() as never,
    });

    controller.initialize();
    await controller.showQuickChatWindow();
    await controller.showMainWindow();

    expect(quickChatWindow.closeCalls).toBe(0);
    expect(quickChatWindow.destroyed).toBe(false);
    expect(quickChatWindow.visible).toBe(false);
    expect(mainWindow.visible).toBe(true);
    expect(mainWindow.focused).toBe(true);
  });

  test("retargets existing quick chat windows for explicit thread requests", async () => {
    createdTrays.length = 0;
    const quickChatWindow = new FakeWindow();
    const createQuickChatWindow = mock(async () => quickChatWindow as never);
    const retargetQuickChatWindow = mock(async () => {});
    const controller = new QuickChatController({
      appName: "Cowork",
      platform: "darwin",
      trayIconPath: "/tmp/icon.png",
      getMainWindow: () => null,
      createMainWindow: async () => new FakeWindow() as never,
      createQuickChatWindow,
      retargetQuickChatWindow,
      createUtilityWindow: async () => new FakeWindow() as never,
    });

    controller.initialize();
    await controller.showQuickChatWindow({ threadId: "thread-1" });
    await controller.showQuickChatWindow({ threadId: "thread-1" });

    expect(createQuickChatWindow).toHaveBeenCalledTimes(1);
    expect(retargetQuickChatWindow).toHaveBeenCalledTimes(1);
    expect(retargetQuickChatWindow).toHaveBeenCalledWith(quickChatWindow, { threadId: "thread-1" });
  });

  test("passes new-thread requests when creating quick chat windows", async () => {
    createdTrays.length = 0;
    const quickChatWindow = new FakeWindow();
    const createQuickChatWindow = mock(async () => quickChatWindow as never);
    const controller = new QuickChatController({
      appName: "Cowork",
      platform: "darwin",
      trayIconPath: "/tmp/icon.png",
      getMainWindow: () => null,
      createMainWindow: async () => new FakeWindow() as never,
      createQuickChatWindow,
      retargetQuickChatWindow: async () => {},
      createUtilityWindow: async () => new FakeWindow() as never,
    });

    controller.initialize();
    await controller.showQuickChatWindow({ newThread: true });

    expect(createQuickChatWindow).toHaveBeenCalledTimes(1);
    expect(createQuickChatWindow).toHaveBeenCalledWith({ newThread: true });
  });

  test("retargets existing quick chat windows for new-thread requests", async () => {
    createdTrays.length = 0;
    const quickChatWindow = new FakeWindow();
    const createQuickChatWindow = mock(async () => quickChatWindow as never);
    const retargetQuickChatWindow = mock(async () => {});
    const controller = new QuickChatController({
      appName: "Cowork",
      platform: "darwin",
      trayIconPath: "/tmp/icon.png",
      getMainWindow: () => null,
      createMainWindow: async () => new FakeWindow() as never,
      createQuickChatWindow,
      retargetQuickChatWindow,
      createUtilityWindow: async () => new FakeWindow() as never,
    });

    controller.initialize();
    await controller.showQuickChatWindow();
    await controller.showQuickChatWindow({ newThread: true });

    expect(createQuickChatWindow).toHaveBeenCalledTimes(1);
    expect(retargetQuickChatWindow).toHaveBeenCalledTimes(1);
    expect(retargetQuickChatWindow).toHaveBeenCalledWith(quickChatWindow, { newThread: true });
  });
});
