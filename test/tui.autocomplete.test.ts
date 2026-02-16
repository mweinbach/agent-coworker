import { describe, expect, test } from "bun:test";

import { createAutocomplete } from "../apps/TUI/component/prompt/autocomplete";

describe("prompt autocomplete", () => {
  test("slash with empty query shows full command list (no hard cap)", () => {
    const commands = Array.from({ length: 18 }, (_, idx) => ({
      label: `/cmd${idx}`,
      value: `/cmd${idx}`,
      description: `command ${idx}`,
      category: "command",
      icon: "/",
    }));

    const ac = createAutocomplete({
      getCommands: () => commands,
      getFiles: () => [],
    });

    ac.onInput("/");

    expect(ac.state().visible).toBe(true);
    expect(ac.state().items).toHaveLength(18);
  });

  test("slash query applies fuzzy limit of 10", () => {
    const commands = Array.from({ length: 20 }, (_, idx) => ({
      label: `/connect-${idx}`,
      value: `/connect-${idx}`,
      description: `command ${idx}`,
      category: "command",
      icon: "/",
    }));

    const ac = createAutocomplete({
      getCommands: () => commands,
      getFiles: () => [],
    });

    ac.onInput("/con");

    expect(ac.state().visible).toBe(true);
    expect(ac.state().items.length).toBe(10);
  });

  test("slash only triggers at token boundaries", () => {
    const ac = createAutocomplete({
      getCommands: () => [{ label: "/help", value: "/help", category: "command" }],
      getFiles: () => [],
    });

    ac.onInput("abc/hel");
    expect(ac.state().visible).toBe(false);

    ac.onInput("abc /hel");
    expect(ac.state().visible).toBe(true);
  });

  test("escape closes visible empty results", () => {
    const ac = createAutocomplete({
      getCommands: () => [{ label: "/help", value: "/help", category: "command" }],
      getFiles: () => [],
    });

    ac.onInput("/zzzz");
    expect(ac.state().visible).toBe(true);
    expect(ac.state().items).toHaveLength(0);

    expect(ac.onKeyDown("escape", false)).toBe(true);
    expect(ac.state().visible).toBe(false);
  });

  test("select replaces slash token with trailing space", () => {
    const ac = createAutocomplete({
      getCommands: () => [
        { label: "/help", value: "/help", category: "command" },
      ],
      getFiles: () => [],
    });

    ac.onInput("/h", 2);
    const replaced = ac.select("/h", 2);
    expect(replaced).toBe("/help ");
  });
});
