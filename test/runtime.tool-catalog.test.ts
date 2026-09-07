import { describe, expect, mock, test } from "bun:test";
import { z } from "zod";

import {
  createDeferredToolTools,
  createToolCatalog,
  type ToolCatalogOptions,
} from "../src/runtime/toolCatalog";
import type { RuntimeToolExecutionOptions, RuntimeToolMap } from "../src/runtime/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setup(initial: RuntimeToolMap = {}, options: Omit<ToolCatalogOptions, "withTools"> = {}) {
  let tools = initial;
  let errors: string[] = [];
  const withTools = mock(() => {});
  const catalog = createToolCatalog({
    withTools: async (operation) => {
      withTools();
      return await operation(tools, errors);
    },
    ...options,
  });
  return {
    catalog,
    tools: createDeferredToolTools(catalog),
    withTools,
    replace: (next: RuntimeToolMap) => {
      tools = next;
    },
    setErrors: (next: string[]) => {
      errors = next;
    },
  };
}

function echoTool(description = "Echo text") {
  return {
    description,
    inputSchema: z.object({ text: z.string() }).strict(),
    execute: mock(async (input: unknown, _options?: RuntimeToolExecutionOptions) => input),
  };
}

describe("filtered runtime tool catalog", () => {
  test("serializes real Zod schemas, descriptions, defaults, and JSON schemas as JSON", async () => {
    const rawSchema = {
      type: "object",
      properties: { text: { type: ["string", "null"] } },
      required: ["text"],
    };
    const harness = setup({
      nested: {
        inputSchema: z
          .object({
            filter: z.object({ tags: z.array(z.string()), mode: z.enum(["all", "any"]) }),
            limit: z.number().int().default(5).describe("Maximum results"),
          })
          .strict(),
        execute: async (input) => input,
      },
      raw: { inputSchema: rawSchema, execute: async (input) => input },
      empty: { execute: async () => null },
    });
    const result = JSON.parse(JSON.stringify(await harness.catalog.search({ query: "*" })));
    expect(result.tools.find((tool: { name: string }) => tool.name === "nested")).toMatchObject({
      name: "nested",
      description: "nested",
      inputSchema: {
        type: "object",
        properties: {
          filter: {
            type: "object",
            properties: {
              tags: { type: "array", items: { type: "string" } },
              mode: { type: "string", enum: ["all", "any"] },
            },
            required: ["tags", "mode"],
          },
          limit: { type: "integer", default: 5, description: "Maximum results" },
        },
        additionalProperties: false,
      },
    });
    expect(result.tools.find((tool: { name: string }) => tool.name === "raw").inputSchema).toEqual(
      rawSchema,
    );
    expect(
      result.tools.find((tool: { name: string }) => tool.name === "empty").inputSchema,
    ).toEqual({ type: "object", properties: {} });
  });

  test("ranks exact names, camelCase names, and capabilities with deterministic pagination", async () => {
    const tools = Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => [
        `message${String(index).padStart(2, "0")}`,
        echoTool("Find email messages"),
      ]),
    );
    tools.findEmail = echoTool("Find email messages");
    const { catalog } = setup(tools);
    expect((await catalog.search({ query: "MESSAGE24", limit: 1 })).tools[0]?.name).toBe(
      "message24",
    );
    const first = await catalog.search({ query: "find email" });
    expect(first.total).toBe(26);
    expect(first.tools).toHaveLength(5);
    expect(first.tools[0]?.name).toBe("findEmail");
    expect(first.nextOffset).toBe(5);
    const second = await catalog.search({ query: "find email", limit: 20, offset: 5 });
    const last = await catalog.search({
      query: "find email",
      limit: 20,
      offset: second.nextOffset,
    });
    expect(last.tools).toHaveLength(1);
    expect(last.nextOffset).toBeUndefined();
    expect(
      new Set([...first.tools, ...second.tools, ...last.tools].map(({ name }) => name)).size,
    ).toBe(26);
    expect((await catalog.search({ query: "*", limit: null, offset: null })).tools).toHaveLength(5);
    expect(await catalog.search({ query: "nonexistent_capability" })).toEqual({
      tools: [],
      total: 0,
    });
    expect(await catalog.search({ query: "*", offset: 100 })).toEqual({ tools: [], total: 26 });
  });

  test("only converts schemas for the requested page", async () => {
    const inputSchema = mock(() => {
      throw new Error("Off-page schema must not be read");
    });
    const { catalog } = setup({
      first: echoTool(),
      last: {
        get inputSchema() {
          return inputSchema();
        },
        execute: async () => null,
      },
    });
    expect((await catalog.search({ query: "*", limit: 1 })).tools[0]?.name).toBe("first");
    expect(inputSchema).not.toHaveBeenCalled();
  });

  test("uses fresh tools and fresh schemas for stable envelopes, without requiring discovery", async () => {
    const harness = setup();
    expect(Object.keys(harness.tools)).toEqual(["toolSearch", "toolCall"]);
    const call = harness.tools.toolCall;
    expect(await harness.catalog.search({ query: "*" })).toEqual({ tools: [], total: 0 });
    const first = echoTool();
    harness.replace({ echo: first });
    await harness.tools.toolSearch.execute({ query: "echo" });
    expect(await call.execute({ name: "echo", arguments: { text: "first" } })).toEqual({
      text: "first",
    });
    const replacement = {
      inputSchema: z.object({ count: z.number().int() }).strict(),
      execute: mock(async (input: unknown) => input),
    };
    harness.replace({ echo: replacement });
    await expect(call.execute({ name: "echo", arguments: { text: "stale" } })).rejects.toThrow();
    expect(await call.execute({ name: "echo", arguments: { count: 2 } })).toEqual({ count: 2 });
    expect((await harness.catalog.search({ query: "echo" })).tools[0]?.inputSchema).toMatchObject({
      properties: { count: { type: "integer" } },
      required: ["count"],
    });
    expect(first.execute).toHaveBeenCalledTimes(1);
    expect(replacement.execute).toHaveBeenCalledTimes(1);
    harness.replace({});
    await expect(call.execute({ name: "echo", arguments: {} })).rejects.toThrow("not available");
    harness.replace({ unseen: echoTool() });
    expect(await call.execute({ name: "unseen", arguments: { text: "no search needed" } })).toEqual(
      { text: "no search needed" },
    );
  });

  test("validates nested Zod inputs before dispatch or mutation authorization", async () => {
    const execute = mock(async (input: unknown) => input);
    const assertCanMutate = mock(() => {});
    const { catalog } = setup(
      {
        write: {
          inputSchema: z
            .object({
              entries: z.array(z.object({ path: z.string(), count: z.number().int().min(1) })),
            })
            .strict(),
          execute,
        },
      },
      { assertCanMutate },
    );
    for (const args of [
      {},
      { entries: [{ path: "a", count: "2" }] },
      { entries: [{ path: "a", count: 0 }] },
      { entries: [], unknown: true },
    ]) {
      await expect(catalog.call({ name: "write", arguments: args })).rejects.toThrow();
    }
    expect(execute).not.toHaveBeenCalled();
    expect(assertCanMutate).not.toHaveBeenCalled();
  });

  test("preserves schema-owned null normalization, defaults, and explicitly nullable values", async () => {
    const inputSchema = z.preprocess(
      (input) => {
        const args = input as Record<string, unknown>;
        return { ...args, limit: args.limit === null ? undefined : args.limit };
      },
      z.object({ limit: z.number().default(5), text: z.string().nullable() }),
    );
    const execute = mock(async (input: unknown) => input);
    const { catalog } = setup({ echo: { inputSchema, execute } });
    expect(await catalog.call({ name: "echo", arguments: { limit: null, text: null } })).toEqual({
      limit: 5,
      text: null,
    });
    expect(
      JSON.parse(JSON.stringify(await catalog.search({ query: "echo" }))).tools[0].inputSchema,
    ).toMatchObject({ type: "object", properties: { limit: { default: 5 } } });
  });

  test("preserves raw JSON-schema arguments for transport-owned validation", async () => {
    const { catalog } = setup({
      remote: {
        inputSchema: { type: "object", properties: { text: { type: ["string", "null"] } } },
        execute: async (input) => input,
      },
    });
    expect(await catalog.call({ name: "remote", arguments: { text: null } })).toEqual({
      text: null,
    });
  });

  test("rejects invalid envelopes before acquiring catalog leases", async () => {
    const { catalog, withTools } = setup();
    for (const input of [
      {},
      { query: " " },
      { query: "x", limit: 21 },
      { query: "x", limit: 0 },
      { query: "x", limit: 1.5 },
      { query: "x", offset: -1 },
      { query: "x", other: true },
    ]) {
      await expect(catalog.search(input)).rejects.toThrow();
    }
    for (const input of [
      {},
      { name: " ", arguments: {} },
      { name: "echo", arguments: null },
      { name: "echo", arguments: [] },
      { name: "echo", arguments: "wrong" },
      { name: "echo", arguments: {}, other: true },
    ]) {
      await expect(catalog.call(input)).rejects.toThrow();
    }
    expect(withTools).not.toHaveBeenCalled();
  });

  test("rejects inherited, prototype, unavailable, and reserved envelope names", async () => {
    const execute = mock(async () => "must not run");
    const inherited = { execute };
    const tools: RuntimeToolMap = Object.assign(Object.create({ inherited }), {
      toolSearch: inherited,
      toolCall: inherited,
      codeMode: inherited,
      constructor: inherited,
      prototype: inherited,
      toString: inherited,
    });
    Object.defineProperty(tools, "__proto__", { value: inherited, enumerable: true });
    const { catalog } = setup(tools);
    expect(await catalog.search({ query: "*" })).toEqual({ tools: [], total: 0 });
    for (const name of [
      "inherited",
      "__proto__",
      "constructor",
      "prototype",
      "toString",
      "missing",
      "toolSearch",
      "toolCall",
      "codeMode",
    ]) {
      await expect(catalog.call({ name, arguments: {} })).rejects.toThrow("not available");
    }
    expect(execute).not.toHaveBeenCalled();
  });

  test("rechecks the actual tool mutation gate between consecutive calls", async () => {
    let locked = false;
    const guard = mock((name: string) => {
      if (locked && name === "write") throw new Error("Turn no longer owns writes");
    });
    const execute = mock(async () => {
      locked = true;
      return "first write";
    });
    const { catalog } = setup({ write: { execute } }, { assertCanMutate: guard });
    expect(await catalog.call({ name: "write", arguments: {} })).toBe("first write");
    await expect(catalog.call({ name: "write", arguments: {} })).rejects.toThrow(
      "Turn no longer owns writes",
    );
    expect(guard.mock.calls).toEqual([["write"], ["write"]]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("preserves result identity, error metadata, thrown errors, and catalog errors", async () => {
    const result = {
      content: [{ type: "text", text: "Partial failure" }],
      structuredContent: { count: 1 },
      _meta: { sources: [{ url: "https://example.com" }] },
      isError: true,
    };
    const failure = new Error("Transport failed");
    const harness = setup({
      result: { execute: async () => result },
      fail: {
        execute: async () => {
          throw failure;
        },
      },
    });
    expect(await harness.catalog.call({ name: "result", arguments: {} })).toBe(result);
    await expect(harness.catalog.call({ name: "fail", arguments: {} })).rejects.toBe(failure);
    const errors = ["One server unavailable"];
    harness.setErrors(errors);
    const found = await harness.catalog.search({ query: "*" });
    expect(found.errors).toEqual(errors);
    errors.push("Later error");
    expect(found.errors).toEqual(["One server unavailable"]);
    harness.setErrors([]);
    expect((await harness.catalog.search({ query: "*" })).errors).toBeUndefined();
    const broken = createToolCatalog({
      withTools: async () => {
        throw failure;
      },
    });
    await expect(broken.search({ query: "*" })).rejects.toBe(failure);
    await expect(broken.call({ name: "result", arguments: {} })).rejects.toBe(failure);
  });

  test("forwards execution options and identity fields while combining cancellation signals", async () => {
    const turn = new AbortController();
    const call = new AbortController();
    const echo = echoTool();
    const { tools } = setup({ echo }, { abortSignal: turn.signal });
    const executionOptions = { abortSignal: call.signal, toolCallId: "nested-call-123" };
    await tools.toolCall.execute({ name: "echo", arguments: { text: "hello" } }, executionOptions);
    const forwarded = echo.execute.mock.calls[0]?.[1];
    expect(forwarded).toMatchObject({ toolCallId: "nested-call-123" });
    expect(forwarded?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(forwarded?.abortSignal?.aborted).toBe(false);
    call.abort();
    expect(forwarded?.abortSignal?.aborted).toBe(true);
    await expect(
      tools.toolCall.execute({ name: "echo", arguments: { text: "late" } }, executionOptions),
    ).rejects.toThrow("Model turn aborted");
    expect(echo.execute).toHaveBeenCalledTimes(1);
  });

  test("cancels pending catalog acquisition promptly without late dispatch", async () => {
    const controller = new AbortController();
    const loaded = deferred<void>();
    const released = deferred<void>();
    const echo = echoTool();
    let completed = 0;
    const catalog = createToolCatalog({
      abortSignal: controller.signal,
      withTools: async (operation) => {
        await loaded.promise;
        try {
          return await operation({ echo }, []);
        } finally {
          if (++completed === 2) released.resolve();
        }
      },
    });
    const pending = Promise.allSettled([
      catalog.search({ query: "*" }),
      catalog.call({ name: "echo", arguments: { text: "never" } }),
    ]);
    controller.abort();
    expect(await pending).toEqual([
      { status: "rejected", reason: new Error("Model turn aborted.") },
      { status: "rejected", reason: new Error("Model turn aborted.") },
    ]);
    loaded.resolve();
    await released.promise;
    expect(echo.execute).not.toHaveBeenCalled();
  });

  test("cancellation during authorization prevents dispatch after authorization completes", async () => {
    const controller = new AbortController();
    const entered = deferred<void>();
    const authorize = deferred<void>();
    const released = deferred<void>();
    const echo = echoTool();
    const catalog = createToolCatalog({
      abortSignal: controller.signal,
      withTools: async (operation) => {
        try {
          return await operation({ echo }, []);
        } finally {
          released.resolve();
        }
      },
      assertCanMutate: async () => {
        entered.resolve();
        await authorize.promise;
      },
    });
    const pending = catalog.call({ name: "echo", arguments: { text: "never" } });
    await entered.promise;
    controller.abort();
    await expect(pending).rejects.toThrow("Model turn aborted");
    authorize.resolve();
    await released.promise;
    expect(echo.execute).not.toHaveBeenCalled();
  });

  for (const outcome of ["success", "failure"] as const) {
    test(`retains dispatched-call and lease ownership during cancellation until ${outcome}`, async () => {
      const turn = new AbortController();
      const call = new AbortController();
      const started = deferred<AbortSignal | undefined>();
      const finish = deferred<unknown>();
      const result = { _meta: { original: true }, content: [{ type: "text", text: "done" }] };
      const failure = new Error("Failed after cancellation");
      let leaseActive = false;
      let settled = false;
      const catalog = createToolCatalog({
        abortSignal: turn.signal,
        withTools: async (operation) => {
          leaseActive = true;
          try {
            return await operation(
              {
                write: {
                  execute: async (_input, options) => {
                    started.resolve(options?.abortSignal);
                    return await finish.promise;
                  },
                },
              },
              [],
            );
          } finally {
            leaseActive = false;
          }
        },
      });
      const pending = catalog.call({ name: "write", arguments: {} }, { abortSignal: call.signal });
      const observed = pending.then(
        (value) => {
          settled = true;
          return { value };
        },
        (error: unknown) => {
          settled = true;
          return { error };
        },
      );
      const signal = await started.promise;
      turn.abort();
      await Bun.sleep(0);
      expect(signal?.aborted).toBe(true);
      expect(leaseActive).toBe(true);
      expect(settled).toBe(false);
      if (outcome === "success") finish.resolve(result);
      else finish.reject(failure);
      const completed = await observed;
      if ("value" in completed) expect(completed.value).toBe(result);
      else expect(completed.error).toBe(failure);
      expect(leaseActive).toBe(false);
    });
  }
});
