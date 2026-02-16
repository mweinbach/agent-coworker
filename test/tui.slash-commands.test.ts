import { describe, expect, test } from "bun:test";

import {
  createLocalSlashCommands,
  findLocalSlashCommand,
  localSlashCommandsToAutocompleteItems,
  parseSlashInput,
} from "../apps/TUI/component/prompt/slash-commands";

describe("local slash command registry", () => {
  test("autocomplete items come from executable registry entries", () => {
    const commands = createLocalSlashCommands({
      syncActions: {
        reset: () => {},
        cancel: () => {},
        connectProvider: () => {},
        setProviderApiKey: () => {},
      },
      route: {
        navigate: () => {},
      },
      dialog: {},
      exit: {
        exit: () => {},
      },
    });

    const items = localSlashCommandsToAutocompleteItems(commands);
    expect(items.length).toBeGreaterThan(0);

    for (const item of items) {
      const parsed = parseSlashInput(item.value);
      expect(parsed).not.toBeNull();
      const resolved = findLocalSlashCommand(commands, parsed!.name);
      expect(resolved).not.toBeNull();
      expect(typeof resolved!.execute).toBe("function");
    }
  });

  test("aliases resolve to the same command", async () => {
    let resetCalls = 0;
    let navigateCalls = 0;

    const commands = createLocalSlashCommands({
      syncActions: {
        reset: () => {
          resetCalls += 1;
        },
        cancel: () => {},
        connectProvider: () => {},
        setProviderApiKey: () => {},
      },
      route: {
        navigate: () => {
          navigateCalls += 1;
        },
      },
      dialog: {},
      exit: {
        exit: () => {},
      },
    });

    const resolved = findLocalSlashCommand(commands, "clear");
    expect(resolved?.name).toBe("new");

    await Promise.resolve(resolved?.execute(""));

    expect(resetCalls).toBe(1);
    expect(navigateCalls).toBe(1);
  });

  test("parseSlashInput extracts name and arguments", () => {
    expect(parseSlashInput("hello")).toBeNull();
    expect(parseSlashInput("/")).toBeNull();
    expect(parseSlashInput("/review HEAD~2..HEAD")).toEqual({
      name: "review",
      argumentsText: "HEAD~2..HEAD",
    });
  });
});
