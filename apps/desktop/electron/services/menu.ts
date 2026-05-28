import { Menu } from "electron";

import { buildDesktopMenuTemplate, type InstallDesktopMenuOptions } from "./menuTemplate";

export { type InstallDesktopMenuOptions };

export function installDesktopApplicationMenu(options: InstallDesktopMenuOptions): void {
  const menu = Menu.buildFromTemplate(buildDesktopMenuTemplate(options));
  Menu.setApplicationMenu(menu);
}
