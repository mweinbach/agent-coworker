import { describe, expect, test } from "bun:test";

import {
  getSelectedSelectItem,
  resolveDialogSelectKeyAction,
  type SelectItem,
} from "../apps/TUI/ui/dialog-select";

describe("DialogSelect helpers", () => {
  const providerItems: SelectItem[] = [
    { label: "Google", value: "google", description: "Connected" },
    { label: "Anthropic", value: "anthropic", description: "Connect provider" },
  ];

  test("Enter on default selection resolves first provider", () => {
    const selected = getSelectedSelectItem(providerItems, 0);
    expect(selected?.value).toBe("google");
  });

  test("Down then Enter resolves Anthropic selection", () => {
    const action = resolveDialogSelectKeyAction("down", 0, providerItems.length);
    expect(action.nextSelectedIndex).toBe(1);

    const selected = getSelectedSelectItem(providerItems, action.nextSelectedIndex);
    expect(selected?.value).toBe("anthropic");
  });

  test("Escape key resolves to dismiss action", () => {
    const action = resolveDialogSelectKeyAction("escape", 0, providerItems.length);
    expect(action.dismiss).toBe(true);
  });
});
