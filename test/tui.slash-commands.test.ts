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
        setProviderApiKey: () => {},
        requestHarnessContext: () => {},
        setHarnessContext: () => {},
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
        setProviderApiKey: () => {},
        requestHarnessContext: () => {},
        setHarnessContext: () => {},
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

  test("parseSlashInput supports multi-word command names when provided", () => {
    expect(parseSlashInput("/my review HEAD~2..HEAD", ["my review"])).toEqual({
      name: "my review",
      argumentsText: "HEAD~2..HEAD",
    });

    expect(parseSlashInput("/my review HEAD~2..HEAD")).toEqual({
      name: "my",
      argumentsText: "review HEAD~2..HEAD",
    });
  });

  test("hctx set generates a default harness context payload", async () => {
    let setPayload: any = null;

    const commands = createLocalSlashCommands({
      syncActions: {
        reset: () => {},
        cancel: () => {},
        setProviderApiKey: () => {},
        requestHarnessContext: () => {},
        setHarnessContext: (context) => {
          setPayload = context;
        },
      },
      route: {
        navigate: () => {},
      },
      dialog: {},
      exit: {
        exit: () => {},
      },
    });

    const resolved = findLocalSlashCommand(commands, "hctx");
    expect(resolved).not.toBeNull();
    await Promise.resolve(resolved?.execute("set verify harness wiring"));

    expect(setPayload).not.toBeNull();
    expect(typeof setPayload.runId).toBe("string");
    expect(setPayload.runId.startsWith("tui-")).toBe(true);
    expect(setPayload.objective).toBe("verify harness wiring");
    expect(Array.isArray(setPayload.acceptanceCriteria)).toBe(true);
    expect(Array.isArray(setPayload.constraints)).toBe(true);
    expect(setPayload.metadata?.source).toBe("tui");
  });

  test("slo command is not registered", () => {
    const commands = createLocalSlashCommands({
      syncActions: {
        reset: () => {},
        cancel: () => {},
        setProviderApiKey: () => {},
        requestHarnessContext: () => {},
        setHarnessContext: () => {},
      },
      route: {
        navigate: () => {},
      },
      dialog: {},
      exit: {
        exit: () => {},
      },
    });

    const resolved = findLocalSlashCommand(commands, "slo");
    expect(resolved).toBeNull();
  });
});
