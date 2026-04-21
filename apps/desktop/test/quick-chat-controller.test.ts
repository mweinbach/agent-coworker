import path from "node:path";

import { describe, expect, test } from "bun:test";

import { resolveTrayIconPath } from "../electron/services/trayIcon";

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
});
