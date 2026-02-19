import type { MenuItemConstructorOptions } from "electron";

import type { DesktopMenuCommand } from "../../src/lib/desktopApi";

export type InstallDesktopMenuOptions = {
  includeDevTools: boolean;
  openExternal: (url: string) => void;
  sendCommand: (command: DesktopMenuCommand) => void;
};

function commandItem(
  label: string,
  command: DesktopMenuCommand,
  sendCommand: (command: DesktopMenuCommand) => void,
  accelerator?: string,
): MenuItemConstructorOptions {
  return {
    label,
    accelerator,
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

  const fileMenu: MenuItemConstructorOptions = {
    label: isMac ? "File" : "&File",
    submenu: [
      commandItem("New Thread", "newThread", options.sendCommand, "CmdOrCtrl+N"),
      commandItem("Skills", "openSkills", options.sendCommand, "CmdOrCtrl+Shift+K"),
      { type: "separator" },
      commandItem("Settings", "openSettings", options.sendCommand, "CmdOrCtrl+,"),
      commandItem("Workspace Settings", "openWorkspacesSettings", options.sendCommand),
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
      commandItem("Toggle Sidebar", "toggleSidebar", options.sendCommand, "CmdOrCtrl+B"),
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
