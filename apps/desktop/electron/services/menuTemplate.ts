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
  const buildUpdatesItem = () => commandItem("Check for Updates…", "openUpdates", options.sendCommand, undefined, sfSymbol("arrow.triangle.2.circlepath"));
  const buildSharedMenus = (labels: {
    file: string;
    edit: string;
    view: string;
    window: string;
    help: string;
  }): MenuItemConstructorOptions[] => {
    const fileMenu: MenuItemConstructorOptions = {
      label: labels.file,
      submenu: [
        commandItem("New Thread", "newThread", options.sendCommand, "CmdOrCtrl+N", sfSymbol("plus.message")),
        commandItem("Skills", "openSkills", options.sendCommand, "CmdOrCtrl+Shift+K", sfSymbol("wand.and.stars")),
        { type: "separator" },
        commandItem("Settings", "openSettings", options.sendCommand, "CmdOrCtrl+,", sfSymbol("gearshape")),
        commandItem("Workspace Settings", "openWorkspacesSettings", options.sendCommand, undefined, sfSymbol("folder.badge.gearshape")),
      ],
    };

    const editMenu: MenuItemConstructorOptions = {
      label: labels.edit,
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
      label: labels.view,
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
      label: labels.window,
      role: "windowMenu",
      submenu: [{ role: "minimize" }, { role: "close" }],
    };

    const helpMenu: MenuItemConstructorOptions = {
      label: labels.help,
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

    return [fileMenu, editMenu, viewMenu, windowMenu, helpMenu];
  };

  if (platform === "darwin") {
    return [
      {
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
      },
      {
        label: "File",
        submenu: [
          commandItem("New Thread", "newThread", options.sendCommand, "CmdOrCtrl+N", sfSymbol("plus.message")),
          commandItem("Skills", "openSkills", options.sendCommand, "CmdOrCtrl+Shift+K", sfSymbol("wand.and.stars")),
          { type: "separator" },
          commandItem("Settings", "openSettings", options.sendCommand, "CmdOrCtrl+,", sfSymbol("gearshape")),
          commandItem("Workspace Settings", "openWorkspacesSettings", options.sendCommand, undefined, sfSymbol("folder.badge.gearshape")),
          { type: "separator" },
          { role: "close" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
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
      },
      {
        label: "Window",
        role: "windowMenu",
        submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }],
      },
      {
        label: "Help",
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
      },
    ];
  }

  const [fileMenu, editMenu, viewMenu, windowMenu, helpMenu] = buildSharedMenus({
    file: "&File",
    edit: "&Edit",
    view: "&View",
    window: "&Window",
    help: "&Help",
  });
  (fileMenu.submenu as MenuItemConstructorOptions[]).push({ type: "separator" }, { role: "quit" });
  return [fileMenu, editMenu, viewMenu, windowMenu, helpMenu];
}
