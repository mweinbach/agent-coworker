import { describe, expect, test } from "bun:test";

import { buildDesktopMenuTemplate } from "../electron/services/menuTemplate";

describe("desktop application menu", () => {
  test("includes app menu role on macOS", () => {
    const commands: string[] = [];
    const template = buildDesktopMenuTemplate(
      {
        includeDevTools: false,
        openExternal: () => {},
        openQuickChat: () => {},
        sendCommand: (command) => {
          commands.push(command);
        },
      },
      "darwin",
    );

    expect(template[0]?.role).toBe("appMenu");
    const fileMenu = template.find((item: any) => item.label === "File");
    const appMenu = template[0];
    expect(fileMenu?.submenu?.some((entry: any) => entry.label === "New Thread")).toBe(true);
    expect(appMenu?.submenu?.some((entry: any) => entry.label === "Check for Updates…")).toBe(true);
    const updateEntry = appMenu?.submenu?.find(
      (entry: any) => entry.label === "Check for Updates…",
    );
    updateEntry?.click?.();
    expect(commands).toContain("openUpdates");
  });

  test("uses Windows labels and includes help menu", () => {
    const commands: string[] = [];
    const template = buildDesktopMenuTemplate(
      {
        includeDevTools: true,
        openExternal: () => {},
        openQuickChat: () => {},
        sendCommand: (command) => {
          commands.push(command);
        },
      },
      "win32",
    );

    expect(template[0]?.label).toBe("&File");
    const helpMenu = template.find((item: any) => item.label === "&Help");
    expect(helpMenu).toBeTruthy();
    const updateEntry = helpMenu?.submenu?.find(
      (entry: any) => entry.label === "Check for Updates…",
    );
    expect(updateEntry).toBeTruthy();
    updateEntry?.click?.();
    expect(commands).toContain("openUpdates");
  });

  test("keeps Linux on the non-mac menu path without an app menu role", () => {
    const template = buildDesktopMenuTemplate(
      {
        includeDevTools: false,
        openExternal: () => {},
        openQuickChat: () => {},
        sendCommand: () => {},
      },
      "linux",
    );

    expect(template[0]?.role).not.toBe("appMenu");
    expect(template[0]?.label).toBe("&File");
  });

  test("includes quick chat entry in the file menu", () => {
    let openedQuickChat = 0;
    const template = buildDesktopMenuTemplate(
      {
        includeDevTools: false,
        openExternal: () => {},
        openQuickChat: () => {
          openedQuickChat += 1;
        },
        sendCommand: () => {},
      },
      "darwin",
    );

    const fileMenu = template.find((item: any) => item.label === "File");
    const quickChatEntry = fileMenu?.submenu?.find((entry: any) => entry.label === "Open Quick Chat");
    expect(quickChatEntry).toBeTruthy();
    quickChatEntry?.click?.();
    expect(openedQuickChat).toBe(1);
  });
});
