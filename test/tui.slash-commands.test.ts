import { describe, expect, mock, test } from "bun:test";

import {
  createLocalSlashCommands,
  findLocalSlashCommand,
  localSlashCommandsToAutocompleteItems,
  parseSlashInput,
} from "../apps/TUI/component/prompt/slash-commands";

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    syncActions: {
      reset: () => {},
      cancel: () => {},
      setConfig: () => true,
      setProviderApiKey: () => {},
      requestHarnessContext: () => {},
      setHarnessContext: () => {},
    },
    route: {
      navigate: () => {},
    },
    getCurrentProvider: () => "openai",
    dialog: {},
    exit: {
      exit: () => {},
    },
    ...overrides,
  } as Parameters<typeof createLocalSlashCommands>[0];
}

describe("local slash command registry", () => {
  test("autocomplete items come from executable registry entries", () => {
    const commands = createLocalSlashCommands(makeDeps());

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

    const commands = createLocalSlashCommands(makeDeps({
      syncActions: {
        reset: () => {
          resetCalls += 1;
        },
        cancel: () => {},
        setConfig: () => true,
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
    }));

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

    const commands = createLocalSlashCommands(makeDeps({
      syncActions: {
        reset: () => {},
        cancel: () => {},
        setConfig: () => true,
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
    }));

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

  test("/verbosity updates the active openai provider via setConfig", async () => {
    const setConfig = mock(() => true);
    const commands = createLocalSlashCommands(makeDeps({
      syncActions: {
        reset: () => {},
        cancel: () => {},
        setConfig,
        setProviderApiKey: () => {},
        requestHarnessContext: () => {},
        setHarnessContext: () => {},
      },
      getCurrentProvider: () => "openai",
    }));

    const resolved = findLocalSlashCommand(commands, "verbosity");
    expect(resolved).not.toBeNull();

    await Promise.resolve(resolved?.execute("high"));

    expect(setConfig).toHaveBeenCalledWith({
      providerOptions: {
        openai: {
          textVerbosity: "high",
        },
      },
    });
  });

  test("/effort aliases reasoning-effort and targets codex-cli when active", async () => {
    const setConfig = mock(() => true);
    const commands = createLocalSlashCommands(makeDeps({
      syncActions: {
        reset: () => {},
        cancel: () => {},
        setConfig,
        setProviderApiKey: () => {},
        requestHarnessContext: () => {},
        setHarnessContext: () => {},
      },
      getCurrentProvider: () => "codex-cli",
    }));

    const resolved = findLocalSlashCommand(commands, "effort");
    expect(resolved?.name).toBe("reasoning-effort");

    await Promise.resolve(resolved?.execute("xhigh"));

    expect(setConfig).toHaveBeenCalledWith({
      providerOptions: {
        "codex-cli": {
          reasoningEffort: "xhigh",
        },
      },
    });
  });

  test("/reasoning-summary updates the active provider via setConfig", async () => {
    const setConfig = mock(() => true);
    const commands = createLocalSlashCommands(makeDeps({
      syncActions: {
        reset: () => {},
        cancel: () => {},
        setConfig,
        setProviderApiKey: () => {},
        requestHarnessContext: () => {},
        setHarnessContext: () => {},
      },
      getCurrentProvider: () => "openai",
    }));

    const resolved = findLocalSlashCommand(commands, "reasoning-summary");
    expect(resolved).not.toBeNull();

    await Promise.resolve(resolved?.execute("concise"));

    expect(setConfig).toHaveBeenCalledWith({
      providerOptions: {
        openai: {
          reasoningSummary: "concise",
        },
      },
    });
  });

  test("provider-setting commands refuse non-openai-compatible providers", async () => {
    const setConfig = mock(() => true);
    const commands = createLocalSlashCommands(makeDeps({
      syncActions: {
        reset: () => {},
        cancel: () => {},
        setConfig,
        setProviderApiKey: () => {},
        requestHarnessContext: () => {},
        setHarnessContext: () => {},
      },
      getCurrentProvider: () => "google",
    }));

    const resolved = findLocalSlashCommand(commands, "verbosity");
    expect(resolved).not.toBeNull();

    await Promise.resolve(resolved?.execute("medium"));

    expect(setConfig).not.toHaveBeenCalled();
  });

  test("slo command is not registered", () => {
    const commands = createLocalSlashCommands(makeDeps());

    const resolved = findLocalSlashCommand(commands, "slo");
    expect(resolved).toBeNull();
  });
});
