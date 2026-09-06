import { describe, expect, test } from "bun:test";

import { type CodeModeCatalog, createCodeModeTool } from "../src/runtime/codeMode";
import { CODE_MODE_WORKER_SOURCE } from "../src/runtime/codeModeWorker";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const catalog: CodeModeCatalog = {
  search: ({ query }) => ({ tools: [{ name: query, inputSchema: { type: "object" } }] }),
  call: ({ name, arguments: args }) => ({ name, arguments: args }),
};

function execute(code: string, options: Parameters<typeof createCodeModeTool>[0] = { catalog }) {
  return Promise.resolve(createCodeModeTool(options).execute({ code }));
}

describe("code mode: real worker", () => {
  test("global constructor and prototype chains cannot reach host capabilities", async () => {
    expect(
      await execute(`
        const body = "return [typeof process, typeof Bun, typeof fetch]";
        const probes = [
          () => globalThis.constructor.constructor(body)(),
          () => Reflect.get(globalThis, "constructor").constructor(body)(),
          () => Object.getPrototypeOf(globalThis).constructor.constructor(body)(),
          () => Reflect.getPrototypeOf(globalThis).constructor.constructor(body)(),
          () => globalThis.__proto__.constructor.constructor(body)(),
          () => Function("return this")().constructor.constructor(body)(),
          () => globalThis.valueOf().constructor.constructor(body)(),
          () => globalThis.toString.constructor(body)(),
          () => Object.getOwnPropertyDescriptor(globalThis, "constructor").value.constructor(body)(),
        ];
        return probes.map(probe => {
          try { return probe(); }
          catch (error) {
            // Missing/blocked paths must not expose host constructors via errors.
            return error.constructor.constructor(body)();
          }
        });
      `),
    ).toEqual(Array.from({ length: 9 }, () => ["undefined", "undefined", "undefined"]));
  });

  test("parallel catalog operations preserve structured content and obey concurrency", async () => {
    let active = 0;
    let peak = 0;
    let calls = 0;
    const gate = deferred();
    const ready = deferred();
    const nested = {
      content: [{ type: "text", text: "raw source [1]" }],
      sources: [{ url: "https://example.invalid/local-fixture", citation: { id: "1", start: 2 } }],
      structuredContent: { nested: { value: [1, null, "raw"] } },
    };
    const run = execute(
      `const found = await tools.search("lookup");
       const results = await Promise.all([0, 1, 2, 3, 4].map(i => tools.call("lookup", {i})));
       return { found, results };`,
      {
        catalog: {
          ...catalog,
          async call(input, options) {
            expect(input.name).toBe("lookup");
            expect(options?.abortSignal).toBeInstanceOf(AbortSignal);
            calls += 1;
            active += 1;
            peak = Math.max(peak, active);
            if (active === 2) ready.resolve();
            await gate.promise;
            active -= 1;
            return nested;
          },
        },
        limits: { maxConcurrency: 2 },
      },
    );
    await ready.promise;
    expect(calls).toBe(2);
    gate.resolve();
    expect(await run).toEqual({
      found: { tools: [{ name: "lookup", inputSchema: { type: "object" } }] },
      results: Array(5).fill(nested),
    });
    expect(peak).toBe(2);
    expect(calls).toBe(5);
  });

  test("catalog validation errors are realm-native and can be caught", async () => {
    const received: unknown[] = [];
    expect(
      await execute(
        `try { await tools.call("reserved", {bad: true}); }
         catch (error) {
           return { message: error.message,
             host: error.constructor.constructor("return [typeof process, typeof Bun]")() };
         }`,
        {
          catalog: {
            ...catalog,
            call(input) {
              received.push(input);
              throw new TypeError("catalog rejected reserved tool");
            },
          },
        },
      ),
    ).toEqual({
      message: "catalog rejected reserved tool",
      host: ["undefined", "undefined"],
    });
    expect(received).toEqual([{ name: "reserved", arguments: { bad: true } }]);
  });

  test("constructor chains, tools, results and returned thenables never expose host functions", async () => {
    expect(
      await execute(`
        const result = await tools.call("echo", {});
        const promise = tools.search("echo");
        const probes = [
          [].constructor.constructor("return typeof process")(),
          tools.call.constructor("return typeof Bun")(),
          result.constructor.constructor("return typeof process")(),
          promise.constructor.constructor("return typeof Bun")(),
          (function*(){}).constructor("return typeof process")().next().value,
          await (async function(){}).constructor("return typeof Bun")(),
        ];
        return { then(resolve, reject) {
          resolve({
            probes,
            resolveHost: resolve.constructor("return typeof process")(),
            rejectHost: reject.constructor("return typeof Bun")(),
            ambient: [typeof fetch, typeof process, typeof Bun, typeof ShadowRealm,
              typeof WebAssembly, typeof Atomics, typeof SharedArrayBuffer,
              typeof globalThis.postMessage, typeof globalThis.Worker],
          });
        } };
      `),
    ).toEqual({
      probes: Array(6).fill("undefined"),
      resolveHost: "undefined",
      rejectHost: "undefined",
      ambient: Array(9).fill("undefined"),
    });
  });

  test("static imports fail and dynamic import errors cannot escape the realm", async () => {
    await expect(execute(`import fs from "node:fs"; return fs;`)).rejects.toThrow();
    await expect(execute(`}\nimport fs from "node:fs";\nfunction injected() {`)).rejects.toThrow(
      "imports are not available",
    );
    expect(
      await execute(`
        const failures = [];
        for (const name of ["node:" + "fs", "bun", "https://example.invalid/no-network"]) {
          try { await import(name); }
          catch (error) { failures.push({
            message: error.message,
            host: error.constructor.constructor("return [typeof process, typeof Bun]")(),
          }); }
        }
        return { failures, meta: Object.keys(import.meta) };
      `),
    ).toEqual({
      failures: Array.from({ length: 3 }, () => ({
        message: "imports are not available in code mode",
        host: ["undefined", "undefined"],
      })),
      meta: [],
    });
  });

  test("function-constructor dynamic imports do not expose loader errors from the host", async () => {
    expect(
      await execute(`
        const failures = [];
        for (const make of [Function, (async function() {}).constructor]) {
          try {
            await make('return import("node:fs")')();
            failures.push("loaded");
          } catch (error) {
            failures.push(error.constructor.constructor("return [typeof process, typeof Bun]")());
          }
        }
        return failures;
      `),
    ).toEqual([
      ["undefined", "undefined"],
      ["undefined", "undefined"],
    ]);
  });

  test("mutated intrinsics cannot replace the private JSON bridge", async () => {
    expect(
      await execute(`
        JSON.stringify = () => () => {};
        JSON.parse = () => ({ok: true, value: "forged"});
        Error = Function;
        return await tools.call("echo", {value: 7});
      `),
    ).toEqual({ name: "echo", arguments: { value: 7 } });
  });

  test("real worker transport rejections release RPCs and expose only realm errors", async () => {
    // Inject a host DataCloneError at the real transport boundary, not a fake
    // catalog rejection. A subsequent request proves pending bookkeeping drains.
    const source = `${CODE_MODE_WORKER_SOURCE}
      const originalPost = postMessage;
      let failed = false;
      postMessage = (message) => {
        if (message.t === "request" && !failed) {
          failed = true;
          throw new DOMException("fixture transport rejection", "DataCloneError");
        }
        originalPost(message);
      };
    `;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const worker = new Worker(url, { type: "module" } as WorkerOptions);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const requests: number[] = [];
    try {
      const result = new Promise<unknown>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("transport test timed out")), 2000);
        worker.onerror = (event) => reject(new Error(event.message));
        worker.onmessage = ({ data }) => {
          if (data.t === "request") {
            requests.push(data.id);
            worker.postMessage({
              t: "result",
              id: data.id,
              payload: JSON.stringify({ ok: true, value: { good: true } }),
            });
          } else if (data.t === "done") resolve(JSON.parse(data.payload));
          else if (data.t === "error") reject(new Error(data.message));
        };
      });
      worker.postMessage({
        t: "start",
        code: `
          let failure;
          try { await tools.call("bad", {}); }
          catch (error) {
            failure = {
              message: error.message,
              host: error.constructor.constructor("return [typeof process, typeof Bun]")(),
            };
          }
          return {failure, good: await tools.call("good", {})};
        `,
        limits: { maxCalls: 5, maxArgumentBytes: 4096, maxOutputBytes: 4096 },
      });
      expect(await result).toEqual({
        failure: {
          message: "fixture transport rejection",
          host: ["undefined", "undefined"],
        },
        good: { good: true },
      });
      expect(requests).toEqual([1]);
    } finally {
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
    }
  });

  test("infinite loops are interrupted by the worker timeout", async () => {
    await expect(
      execute("while (true) {}", { catalog, limits: { timeoutMs: 100 } }),
    ).rejects.toThrow("timed out");
    expect(await execute("return 7;")).toBe(7);
  });

  test("abort interrupts an infinite loop and already-aborted runs never call the catalog", async () => {
    const controller = new AbortController();
    let called = false;
    const started = deferred();
    const tool = createCodeModeTool({
      catalog: {
        ...catalog,
        call() {
          called = true;
          started.resolve();
          return null;
        },
      },
      abortSignal: controller.signal,
    });
    const run = Promise.resolve(
      tool.execute({ code: `await tools.call("ready", {}); while (true) {}` }),
    );
    await started.promise;
    controller.abort();
    await expect(run).rejects.toThrow("cancelled");
    called = false;
    await expect(
      Promise.resolve(tool.execute({ code: `await tools.call("never", {});` })),
    ).rejects.toThrow("cancelled");
    expect(called).toBe(false);
  });

  for (const termination of ["abort", "timeout"] as const) {
    test(`${termination} aborts dispatched calls, drops queued work and retains ownership`, async () => {
      const controller = new AbortController();
      const started = deferred();
      const aborted = deferred();
      const release = deferred();
      let settled = false;
      let calls = 0;
      let finished = false;
      const tool = createCodeModeTool({
        catalog: {
          ...catalog,
          async call(_input, options) {
            calls += 1;
            options?.abortSignal?.addEventListener("abort", () => aborted.resolve(), {
              once: true,
            });
            started.resolve();
            await release.promise; // Deliberately emulate a tool that ignores cancellation.
            finished = true;
            return null;
          },
        },
        limits: { maxConcurrency: 1, timeoutMs: termination === "timeout" ? 200 : 2000 },
      });
      const run = Promise.resolve(
        tool.execute(
          { code: `await Promise.all([1, 2, 3].map(n => tools.call("wait", {n})));` },
          { abortSignal: controller.signal },
        ),
      );
      void run.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await started.promise;
      if (termination === "abort") controller.abort();
      await aborted.promise;
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(finished).toBe(false);
      expect(calls).toBe(1);
      release.resolve();
      await expect(run).rejects.toThrow(termination === "abort" ? "cancelled" : "timed out");
      expect(finished).toBe(true);
      expect(calls).toBe(1);
    });
  }

  test("synchronous cancellation inside catalog dispatch still retains ownership", async () => {
    const controller = new AbortController();
    const started = deferred();
    const release = deferred();
    let settled = false;
    const run = execute(`return await tools.call("cancel", {});`, {
      abortSignal: controller.signal,
      catalog: {
        ...catalog,
        async call() {
          controller.abort();
          started.resolve();
          await release.promise;
          return null;
        },
      },
    });
    void run.catch(() => {
      settled = true;
    });
    await started.promise;
    expect(settled).toBe(false);
    release.resolve();
    await expect(run).rejects.toThrow("cancelled");
  });

  test("call ceiling counts searches and cannot be swallowed by model code", async () => {
    let calls = 0;
    await expect(
      execute(
        `await tools.search("one"); await tools.call("two", {});
         try { await tools.call("three", {}); } catch {}
         return "must fail";`,
        {
          catalog: {
            search: () => {
              calls += 1;
              return [];
            },
            call: () => {
              calls += 1;
              return null;
            },
          },
          limits: { maxCalls: 2 },
        },
      ),
    ).rejects.toThrow("maxCalls");
    expect(calls).toBe(2);
  });

  test("source, argument, output and nested result byte limits are enforced", async () => {
    await expect(
      execute("return 'ééé';", { catalog, limits: { maxSourceBytes: 8 } }),
    ).rejects.toThrow("maxSourceBytes");
    await expect(
      execute(`return "é".repeat(20);`, { catalog, limits: { maxOutputBytes: 32 } }),
    ).rejects.toThrow("maxOutputBytes");
    await expect(
      execute(`return await tools.call("echo", {large: "x".repeat(100)});`, {
        catalog,
        limits: { maxArgumentBytes: 64 },
      }),
    ).rejects.toThrow("maxArgumentBytes");
    await expect(
      execute(`return await tools.call("large", {});`, {
        catalog: { ...catalog, call: () => ({ value: "x".repeat(1000) }) },
        limits: { maxOutputBytes: 128 },
      }),
    ).rejects.toThrow("maxOutputBytes");
  });

  test("detached calls and delayed continuation chains are drained before completion", async () => {
    const started = deferred();
    const release = deferred();
    const calls: string[] = [];
    let settled = false;
    const run = execute(
      `tools.call("first", {}).then(async () => {
         for (let i = 0; i < 20; i++) await Promise.resolve();
         await tools.call("second", {});
       });
       return {done: true};`,
      {
        catalog: {
          ...catalog,
          async call({ name }) {
            calls.push(name);
            if (name === "first") {
              started.resolve();
              await release.promise;
            }
            return null;
          },
        },
      },
    );
    void run.then(() => {
      settled = true;
    });
    await started.promise;
    expect(settled).toBe(false);
    release.resolve();
    expect(await run).toEqual({ done: true });
    expect(calls).toEqual(["first", "second"]);
  });

  test("detached rejected calls drain without leaking an unhandled rejection", async () => {
    let completed = false;
    expect(
      await execute(`tools.call("reject", {}); return "done";`, {
        catalog: {
          ...catalog,
          async call() {
            await Promise.resolve();
            completed = true;
            throw new Error("expected detached failure");
          },
        },
      }),
    ).toBe("done");
    expect(completed).toBe(true);
  });

  test("missing returns become null and cyclic or non-JSON returns fail", async () => {
    expect(await execute("const a = 1;")).toBe(null);
    await expect(execute("const a = {}; a.self = a; return a;")).rejects.toThrow();
    await expect(execute("return 1n;")).rejects.toThrow();
    await expect(execute("return () => 1;")).rejects.toThrow("JSON data");
  });
});
