import { describe, expect, mock, test } from "bun:test";

import { createDeferredMcpTools } from "../src/mcp/deferredTools";
import type { RuntimeToolMap } from "../src/runtime/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(
  initial: RuntimeToolMap = {},
  options: {
    filterTools?: (tools: Record<string, unknown>) => Record<string, unknown>;
    assertCanMutate?: (name: string) => void | Promise<void>;
    abortSignal?: AbortSignal;
  } = {},
) {
  let catalog = initial;
  let errors: string[] = [];
  const withTools = mock(
    async <T>(operation: (tools: Record<string, unknown>, errors: string[]) => Promise<T>) =>
      await operation(catalog, errors),
  );
  return {
    tools: createDeferredMcpTools({
      withTools,
      filterTools: options.filterTools ?? ((tools) => tools),
      ...options,
    }),
    withTools,
    replace: (next: RuntimeToolMap) => {
      catalog = next;
    },
    setErrors: (next: string[]) => {
      errors = next;
    },
  };
}

const echoSchema = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
function echoTool(description = "Echo text") {
  return { description, inputSchema: echoSchema, execute: mock(async (input: unknown) => input) };
}

async function search(tools: RuntimeToolMap, input: unknown) {
  return (await tools.toolSearch.execute(input)) as {
    tools: Array<{ name: string; description: string; inputSchema: unknown }>;
    total: number;
    nextOffset?: number;
    errors?: string[];
  };
}

describe("deferred MCP tools", () => {
  test("keeps stable tools while catalogs connect, hot swap, and disconnect", async () => {
    const harness = setup();
    const originalBridges = harness.tools;
    expect(Object.keys(harness.tools)).toEqual(["toolSearch", "mcpCall"]);
    expect((await search(harness.tools, { query: "echo" })).tools).toEqual([]);

    const first = echoTool();
    harness.replace({ mcp__test__echo: first });
    expect((await search(harness.tools, { query: "echo" })).tools).toEqual([
      { name: "mcp__test__echo", description: "Echo text", inputSchema: echoSchema },
    ]);
    expect(
      await harness.tools.mcpCall.execute({ name: "mcp__test__echo", arguments: { text: "one" } }),
    ).toEqual({ text: "one" });

    const second = { ...echoTool(), execute: mock(async () => "replacement") };
    harness.replace({ mcp__test__echo: second });
    expect(await harness.tools.mcpCall.execute({ name: "mcp__test__echo", arguments: {} })).toBe(
      "replacement",
    );
    expect(first.execute).toHaveBeenCalledTimes(1);
    expect(second.execute).toHaveBeenCalledTimes(1);
    expect(harness.tools).toBe(originalBridges);

    harness.replace({});
    await expect(
      harness.tools.mcpCall.execute({ name: "mcp__test__echo", arguments: {} }),
    ).rejects.toThrow("is not available");
  });

  test("allows tools discovered by another session without per-turn registration", async () => {
    let catalog: RuntimeToolMap = {};
    const options = {
      withTools: async <T>(
        operation: (tools: Record<string, unknown>, errors: string[]) => Promise<T>,
      ) => await operation(catalog, []),
      filterTools: (tools: Record<string, unknown>) => tools,
    };
    const first = createDeferredMcpTools(options);
    const second = createDeferredMcpTools(options);
    catalog = { mcp__test__echo: echoTool() };
    const [found] = (await search(first, { query: "echo" })).tools;
    expect(
      await second.mcpCall.execute({ name: found!.name, arguments: { text: "shared" } }),
    ).toEqual({ text: "shared" });
  });

  test("filters both discovery and calls against the current catalog", async () => {
    const allowed = echoTool("Allowed text");
    const forbidden = echoTool("Forbidden text");
    const harness = setup(
      { mcp__allowed__echo: allowed },
      {
        filterTools: (tools) =>
          Object.fromEntries(
            Object.entries(tools).filter(([name]) => name.startsWith("mcp__allowed__")),
          ),
      },
    );
    harness.replace({ mcp__allowed__echo: allowed, mcp__forbidden__echo: forbidden });
    expect((await search(harness.tools, { query: "text" })).tools.map(({ name }) => name)).toEqual([
      "mcp__allowed__echo",
    ]);
    await expect(
      harness.tools.mcpCall.execute({ name: "mcp__forbidden__echo", arguments: {} }),
    ).rejects.toThrow("is not available");
    expect(forbidden.execute).not.toHaveBeenCalled();
  });

  test("rejects inherited tool names", async () => {
    const inherited = echoTool();
    const harness = setup(Object.create({ mcp__test__echo: inherited }));
    expect((await search(harness.tools, { query: "*" })).tools).toEqual([]);
    await expect(
      harness.tools.mcpCall.execute({ name: "mcp__test__echo", arguments: {} }),
    ).rejects.toThrow("is not available");
    await expect(
      harness.tools.mcpCall.execute({ name: "constructor", arguments: {} }),
    ).rejects.toThrow("is not available");
    expect(inherited.execute).not.toHaveBeenCalled();
  });

  test("ranks exact names first and caps schemas to paginated results", async () => {
    const catalog = Object.fromEntries(
      Array.from({ length: 26 }, (_, index) => [
        `mcp__mail__tool${String(index).padStart(2, "0")}`,
        echoTool("Search email messages"),
      ]),
    );
    catalog.mcp__mail__search = echoTool("Search email messages");
    const harness = setup(catalog);
    const exact = await search(harness.tools, { query: "mcp__mail__tool25", limit: 1 });
    expect(exact.tools[0]?.name).toBe("mcp__mail__tool25");
    const first = await search(harness.tools, { query: "search email" });
    expect(first.tools).toHaveLength(5);
    expect(first.tools[0]?.name).toBe("mcp__mail__search");
    expect(first.nextOffset).toBe(5);
    const second = await search(harness.tools, {
      query: "search email",
      limit: 20,
      offset: first.nextOffset,
    });
    const last = await search(harness.tools, {
      query: "search email",
      limit: 20,
      offset: second.nextOffset,
    });
    expect(
      new Set([...first.tools, ...second.tools, ...last.tools].map(({ name }) => name)).size,
    ).toBe(27);
    expect(last.nextOffset).toBeUndefined();
    expect(
      first.tools.every(
        (tool) => Object.keys(tool).sort().join(",") === "description,inputSchema,name",
      ),
    ).toBe(true);
    expect((await search(harness.tools, { query: "no_such_capability" })).tools).toEqual([]);
  });

  test("preserves underlying results, error results, and thrown failures", async () => {
    const result = {
      content: [{ type: "text", text: "Done" }],
      structuredContent: { count: 1 },
      _meta: { source: "original" },
      isError: true,
    };
    const failure = new Error("MCP transport failed");
    const harness = setup({
      mcp__test__result: { execute: async () => result },
      mcp__test__fail: {
        execute: async () => {
          throw failure;
        },
      },
    });
    expect(await harness.tools.mcpCall.execute({ name: "mcp__test__result", arguments: {} })).toBe(
      result,
    );
    await expect(
      harness.tools.mcpCall.execute({ name: "mcp__test__fail", arguments: {} }),
    ).rejects.toBe(failure);
    harness.setErrors(["Another server could not connect"]);
    expect((await search(harness.tools, { query: "*" })).errors).toEqual([
      "Another server could not connect",
    ]);
  });

  test("preserves MCP unavailable errors without rewriting similarly worded transport errors", async () => {
    const message =
      'Tool "mcp__test__missing" is not available. Use toolSearch to find currently available tools.';
    const failure = new Error(message);
    const harness = setup({
      mcp__test__fail: {
        execute: async () => {
          throw failure;
        },
      },
    });
    await expect(
      harness.tools.mcpCall.execute({ name: "mcp__test__missing", arguments: {} }),
    ).rejects.toThrow(
      'MCP tool "mcp__test__missing" is not available. Use toolSearch to find currently available tools.',
    );
    await expect(
      harness.tools.mcpCall.execute({ name: "mcp__test__fail", arguments: {} }),
    ).rejects.toBe(failure);
  });

  test("runs the mutation guard for the actual MCP name before dispatch", async () => {
    const tool = echoTool();
    const assertCanMutate = mock(async () => {
      throw new Error("Turn no longer owns writes");
    });
    const harness = setup({ mcp__test__echo: tool }, { assertCanMutate });
    await expect(
      harness.tools.mcpCall.execute({ name: "mcp__test__echo", arguments: {} }),
    ).rejects.toThrow("Turn no longer owns writes");
    expect(assertCanMutate).toHaveBeenCalledWith("mcp__test__echo");
    expect(tool.execute).not.toHaveBeenCalled();
  });

  test("accepts provider nulls for optional search fields without changing MCP arguments", async () => {
    const tool = echoTool();
    const harness = setup({ mcp__test__echo: tool });
    expect(
      await harness.tools.toolSearch.execute({ query: "echo", limit: null, offset: null }),
    ).toMatchObject({ total: 1 });
    expect(
      await harness.tools.mcpCall.execute({ name: "mcp__test__echo", arguments: { text: null } }),
    ).toEqual({ text: null });
  });

  test("validates bridge inputs before loading tools", async () => {
    const harness = setup();
    for (const input of [
      {},
      { query: " " },
      { query: "echo", limit: 21 },
      { query: "echo", limit: 0 },
      { query: "echo", offset: -1 },
    ]) {
      await expect(harness.tools.toolSearch.execute(input)).rejects.toThrow();
    }
    for (const input of [
      {},
      { name: " ", arguments: {} },
      { name: "echo", arguments: [] },
      { name: "echo", arguments: null },
      { name: "echo", arguments: "wrong" },
    ]) {
      await expect(harness.tools.mcpCall.execute(input)).rejects.toThrow();
    }
    expect(harness.withTools).not.toHaveBeenCalled();
  });

  test("stops pending catalog loads promptly and never dispatches after cancellation", async () => {
    const controller = new AbortController();
    const loaded = deferred<void>();
    const tool = echoTool();
    const tools = createDeferredMcpTools({
      withTools: async (operation) => {
        await loaded.promise;
        return await operation({ mcp__test__echo: tool }, []);
      },
      filterTools: (catalog) => catalog,
      abortSignal: controller.signal,
    });
    const pendingSearch = tools.toolSearch.execute({ query: "echo" });
    const pendingCall = tools.mcpCall.execute({ name: "mcp__test__echo", arguments: {} });
    const completed = Promise.allSettled([pendingSearch, pendingCall]);
    controller.abort();
    expect(await completed).toEqual([
      { status: "rejected", reason: new Error("Model turn aborted.") },
      { status: "rejected", reason: new Error("Model turn aborted.") },
    ]);
    loaded.resolve();
    await loaded.promise;
    expect(tool.execute).not.toHaveBeenCalled();
  });

  test("cancellation during the mutation guard prevents a late invocation", async () => {
    const controller = new AbortController();
    const enteredGuard = deferred<void>();
    const releaseGuard = deferred<void>();
    const tool = echoTool();
    const harness = setup(
      { mcp__test__echo: tool },
      {
        abortSignal: controller.signal,
        assertCanMutate: async () => {
          enteredGuard.resolve();
          await releaseGuard.promise;
        },
      },
    );
    const call = harness.tools.mcpCall.execute({ name: "mcp__test__echo", arguments: {} });
    await enteredGuard.promise;
    controller.abort();
    await expect(call).rejects.toThrow("Model turn aborted");
    releaseGuard.resolve();
    await releaseGuard.promise;
    expect(tool.execute).not.toHaveBeenCalled();
  });

  test("forwards execution cancellation and rejects calls already cancelled", async () => {
    const controller = new AbortController();
    const tool = echoTool();
    const harness = setup({ mcp__test__echo: tool });
    await harness.tools.mcpCall.execute(
      { name: "mcp__test__echo", arguments: {} },
      { abortSignal: controller.signal },
    );
    expect(tool.execute).toHaveBeenCalledWith({}, { abortSignal: controller.signal });
    controller.abort();
    await expect(
      harness.tools.mcpCall.execute(
        { name: "mcp__test__echo", arguments: {} },
        { abortSignal: controller.signal },
      ),
    ).rejects.toThrow("Model turn aborted");
    expect(tool.execute).toHaveBeenCalledTimes(1);
  });

  test("keeps filtered MCP transport leases until a dispatched cancelled call settles", async () => {
    const controller = new AbortController();
    const entered = deferred<void>();
    const finish = deferred<void>();
    const result = { content: [{ type: "text", text: "done" }], _meta: { source: "original" } };
    let leased = false;
    let settled = false;
    const tools = createDeferredMcpTools({
      abortSignal: controller.signal,
      withTools: async (operation) => {
        leased = true;
        try {
          return await operation(
            {
              mcp__test__write: {
                execute: async () => {
                  entered.resolve();
                  await finish.promise;
                  return result;
                },
              },
            },
            [],
          );
        } finally {
          leased = false;
        }
      },
      filterTools: (catalog) => {
        expect(leased).toBe(true);
        return catalog;
      },
    });
    const pending = Promise.resolve(
      tools.mcpCall.execute({ name: "mcp__test__write", arguments: {} }),
    ).finally(() => {
      settled = true;
    });
    await entered.promise;
    controller.abort();
    await Bun.sleep(0);
    expect(leased).toBe(true);
    expect(settled).toBe(false);
    finish.resolve();
    expect(await pending).toBe(result);
    expect(leased).toBe(false);
  });
});
