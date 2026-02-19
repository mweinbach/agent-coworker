import { describe, expect, test } from "bun:test";

import { buildConfirmDialog } from "../electron/services/dialogs";

describe("desktop native confirm dialog", () => {
  test("builds macOS button order with cancel first", () => {
    const built = buildConfirmDialog(
      {
        title: "Remove workspace",
        message: "Remove workspace?",
        confirmLabel: "Remove",
        cancelLabel: "Cancel",
        defaultAction: "cancel",
      },
      "darwin",
    );

    expect(built.confirmButtonIndex).toBe(1);
    expect(built.options.buttons).toEqual(["Cancel", "Remove"]);
    expect(built.options.cancelId).toBe(0);
    expect(built.options.defaultId).toBe(0);
  });

  test("builds Windows/Linux button order with confirm first", () => {
    const built = buildConfirmDialog(
      {
        title: "Remove workspace",
        message: "Remove workspace?",
        confirmLabel: "Remove",
        cancelLabel: "Cancel",
        defaultAction: "cancel",
      },
      "win32",
    );

    expect(built.confirmButtonIndex).toBe(0);
    expect(built.options.buttons).toEqual(["Remove", "Cancel"]);
    expect(built.options.cancelId).toBe(1);
    expect(built.options.defaultId).toBe(1);
  });
});
