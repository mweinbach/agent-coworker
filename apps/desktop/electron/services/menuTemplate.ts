import type { MenuItemConstructorOptions } from "electron";

import type { DesktopMenuCommand } from "../../src/lib/desktopApi";

export type InstallDesktopMenuOptions = {
  includeDevTools: boolean;
  openExternal: (url: string) => void;
  sendCommand: (command: DesktopMenuCommand) => void;
};

function sfSymbol(name: string): Electron.NativeImage | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }
  try {
    // Lazy import to avoid test-environment errors where Electron native modules
    // are unavailable.
    const { nativeImage } = require("electron") as typeof import("electron");
    const img = nativeImage.createFromNamedImage(name);
    return img.isEmpty() ? undefined : img;
  } catch {
    return undefined;
  }
}

function commandItem(
  label: string,
  command: DesktopMenuCommand,
  sendCommand: (command: DesktopMenuCommand) => void,
  accelerator?: string,
  icon?: Electron.NativeImage,
): MenuItemConstructorOptions {
  return {
    label,
    accelerator,
    ...(icon ? { icon } : {}),
    click: () => {
      sendCommand(command);
    },
  };
}

export function buildDesktopMenuTemplate(
  options: InstallDesktopMenuOptions,
  platform: NodeJS.Platform = process.platform,
): MenuItemConstructorOptions[] {
  const isMac = platform === "darwin";
  const buildUpdatesItem = () => commandItem("Check for Updates…", "openUpdates", options.sendCommand, undefined, sfSymbol("arrow.triangle.2.circlepath"));

  const fileMenu: MenuItemConstructorOptions = {
    label: isMac ? "File" : "&File",
    submenu: [
      commandItem("New Thread", "newThread", options.sendCommand, "CmdOrCtrl+N", sfSymbol("plus.message")),
      commandItem("Skills", "openSkills", options.sendCommand, "CmdOrCtrl+Shift+K", sfSymbol("wand.and.stars")),
      { type: "separator" },
      commandItem("Settings", "openSettings", options.sendCommand, "CmdOrCtrl+,", sfSymbol("gearshape")),
      commandItem("Workspace Settings", "openWorkspacesSettings", options.sendCommand, undefined, sfSymbol("folder.badge.gearshape")),
      ...(isMac
        ? [{ type: "separator" as const }, { role: "close" as const }]
        : [{ type: "separator" as const }, { role: "quit" as const }]),
    ],
  };

  const editMenu: MenuItemConstructorOptions = {
    label: isMac ? "Edit" : "&Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: isMac ? "View" : "&View",
    submenu: [
      commandItem("Toggle Sidebar", "toggleSidebar", options.sendCommand, "CmdOrCtrl+B", sfSymbol("sidebar.left")),
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
      ...(options.includeDevTools
        ? [
            { type: "separator" as const },
            { role: "reload" as const },
            { role: "forceReload" as const },
            { role: "toggleDevTools" as const },
          ]
        : []),
    ],
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: isMac ? "Window" : "&Window",
    role: "windowMenu",
    submenu: isMac
      ? [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }]
      : [{ role: "minimize" }, { role: "close" }],
  };

  const helpMenu: MenuItemConstructorOptions = {
    label: isMac ? "Help" : "&Help",
    submenu: [
      buildUpdatesItem(),
      { type: "separator" },
      {
        label: "Cowork on GitHub",
        click: () => {
          options.openExternal("https://github.com/mweinbach/agent-coworker");
        },
      },
    ],
  };

  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      role: "appMenu",
      submenu: [
        { role: "about" },
        buildUpdatesItem(),
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  template.push(fileMenu, editMenu, viewMenu, windowMenu, helpMenu);
  return template;
}
