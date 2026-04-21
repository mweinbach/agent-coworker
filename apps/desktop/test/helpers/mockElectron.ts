type ElectronMockShape = Record<string, unknown>;

const defaultApp = {
  getPath: () => process.cwd(),
  getAppPath: () => process.cwd(),
  getName: () => "Cowork Test",
  isPackaged: false,
  quit: () => {},
};

const defaultBrowserWindow = {
  fromWebContents: () => null,
  getFocusedWindow: () => null,
  getAllWindows: () => [],
};

const defaultMenu = {
  buildFromTemplate: () => ({
    popup() {},
  }),
};

const defaultNativeImage = {
  createFromPath() {
    return {
      isEmpty: () => true,
      resize: () => ({
        isEmpty: () => true,
        getSize: () => ({ width: 0, height: 0 }),
        toBitmap: () => Buffer.alloc(0),
      }),
    };
  },
  createEmpty() {
    return {
      isEmpty: () => true,
      resize: () => ({
        isEmpty: () => true,
        getSize: () => ({ width: 0, height: 0 }),
        toBitmap: () => Buffer.alloc(0),
      }),
    };
  },
  createFromBitmap() {
    return {
      setTemplateImage() {},
    };
  },
};

const defaultScreen = {
  getDisplayMatching() {
    return { workArea: { x: 0, y: 0, width: 1440, height: 900 } };
  },
  getDisplayNearestPoint() {
    return { workArea: { x: 0, y: 0, width: 1440, height: 900 } };
  },
  getCursorScreenPoint() {
    return { x: 0, y: 0 };
  },
};

const defaultGlobalShortcut = {
  register: () => true,
  unregister() {},
};

const defaultDialog = {
  async showOpenDialog() {
    return { canceled: true, filePaths: [] };
  },
};

class DefaultTray {
  constructor(_icon: unknown) {}

  setToolTip() {}

  setContextMenu() {}

  getBounds() {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  popUpContextMenu() {}

  on() {}

  destroy() {}
}

let electronMockOverrides: ElectronMockShape = {};

function mergeMock<T extends Record<string, unknown>>(defaults: T, key: keyof ElectronMockShape): T {
  const override = electronMockOverrides[key];
  if (!override || typeof override !== "object") {
    return defaults;
  }
  return {
    ...defaults,
    ...override as Partial<T>,
  };
}

export function setElectronMockOverrides(overrides: ElectronMockShape = {}) {
  electronMockOverrides = overrides;
}

const electronMock = {
  get app() {
    return mergeMock(defaultApp, "app");
  },
  get BrowserWindow() {
    return mergeMock(defaultBrowserWindow, "BrowserWindow");
  },
  get Menu() {
    return mergeMock(defaultMenu, "Menu");
  },
  get Tray() {
    return electronMockOverrides.Tray ?? DefaultTray;
  },
  get nativeImage() {
    return mergeMock(defaultNativeImage, "nativeImage");
  },
  get screen() {
    return mergeMock(defaultScreen, "screen");
  },
  get globalShortcut() {
    return mergeMock(defaultGlobalShortcut, "globalShortcut");
  },
  get dialog() {
    return mergeMock(defaultDialog, "dialog");
  },
};

export function createElectronMock(overrides?: ElectronMockShape) {
  if (overrides) {
    setElectronMockOverrides(overrides);
  }
  return electronMock;
}
