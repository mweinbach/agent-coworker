import { describe, expect, test } from "bun:test";

import { buildDesktopMenuTemplate } from "../electron/services/menuTemplate";

describe("desktop application menu", () => {
  test("includes app menu role on macOS", () => {
    const template = buildDesktopMenuTemplate(
      {
        includeDevTools: false,
        openExternal: () => {},
        sendCommand: () => {},
      },
      "darwin",
    );

    expect(template[0]?.role).toBe("appMenu");
    const fileMenu = template.find((item: any) => item.label === "File");
    expect(fileMenu?.submenu?.some((entry: any) => entry.label === "New Thread")).toBe(true);
  });

  test("uses Windows labels and includes help menu", () => {
    const template = buildDesktopMenuTemplate(
      {
        includeDevTools: true,
        openExternal: () => {},
        sendCommand: () => {},
      },
      "win32",
    );

    expect(template[0]?.label).toBe("&File");
    expect(template.some((item: any) => item.label === "&Help")).toBe(true);
  });
});
