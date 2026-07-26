import { describe, expect, test } from "bun:test";

import { runWorkflow } from "../../src/workflows/WorkflowRunner";
import { makeFakeControl, makeWorkflowCtx, metaHeader, workflowTmpDir } from "./harness";

/**
 * Pins the workflow sandbox's escape surface.
 *
 * Every probe here was executed against a real Bun realm while designing the
 * sandbox, so this suite is transcription rather than speculation. Its job is to
 * turn a Bun upgrade that reopens the realm into a CI failure instead of a silent
 * hole — or, for the determinism traps, instead of a journal that replays stale
 * results.
 *
 * If a probe starts failing, do NOT relax the assertion. Re-seal the realm.
 */

async function evaluate(expression: string): Promise<unknown> {
  const dir = await workflowTmpDir();
  const outcome = await runWorkflow({
    ctx: makeWorkflowCtx(dir),
    control: makeFakeControl(),
    script: `${metaHeader()}export default async function run() { return { v: ${expression} }; }`,
  });
  if (!outcome.ok) throw new Error(`script did not compile: ${JSON.stringify(outcome.issues)}`);
  return (outcome.summary.result as { v: unknown }).v;
}

async function expectThrows(expression: string): Promise<string> {
  const dir = await workflowTmpDir();
  const promise = runWorkflow({
    ctx: makeWorkflowCtx(dir),
    control: makeFakeControl(),
    script: `${metaHeader()}export default async function run() { return { v: ${expression} }; }`,
  });
  let message = "";
  await promise.then(
    () => {
      throw new Error(`expected \`${expression}\` to throw, but it resolved`);
    },
    (error: unknown) => {
      message = error instanceof Error ? error.message : String(error);
    },
  );
  return message;
}

describe("workflow sandbox: ambient capabilities", () => {
  test("host globals are not reachable", async () => {
    expect(await evaluate("typeof process")).toBe("undefined");
    expect(await evaluate("typeof Bun")).toBe("undefined");
    expect(await evaluate("typeof fetch")).toBe("undefined");
    expect(await evaluate("typeof globalThis.process")).toBe("undefined");
  });

  test("require is not callable", async () => {
    // NOTE: `typeof require` evaluates to "function" here — a Bun transpiler
    // artifact (it rewrites the bare `typeof require` probe for CJS detection),
    // not a live binding. Assert on calling it, which is what would actually
    // matter, rather than on `typeof`.
    expect(
      await evaluate(`(() => { try { return typeof require("node:fs"); }
      catch (error) { return "THREW"; } })()`),
    ).toBe("THREW");
  });

  test("import.meta carries no loader handles", async () => {
    expect(await evaluate("Object.getOwnPropertyNames(import.meta).length")).toBe(0);
    expect(await evaluate("typeof import.meta.resolve")).toBe("undefined");
    expect(await evaluate("typeof import.meta.require")).toBe("undefined");
  });

  test("the function-constructor chain is confined to the realm", async () => {
    // This is THE escape that defeats mere parameter shadowing: every array,
    // string and number reaches a constructor that compiles fresh code.
    expect(await evaluate(`[].constructor.constructor("return typeof Bun")()`)).toBe("undefined");
    expect(await evaluate(`(function(){}).constructor("return typeof process")()`)).toBe(
      "undefined",
    );
    expect(await evaluate(`"".constructor.constructor("return typeof globalThis.Bun")()`)).toBe(
      "undefined",
    );
    expect(await evaluate(`(0).constructor.constructor("return typeof process")()`)).toBe(
      "undefined",
    );
  });

  test("async and generator function constructors are confined too", async () => {
    // These three siblings of `Function` compile code just as happily, so a seal
    // that only covers Function.prototype leaves them wide open. They still
    // *exist* inside the realm — the point is that code they compile sees the
    // realm's globals, not the host's.
    expect(
      await evaluate(`await (async function(){}).constructor("return typeof process")()`),
    ).toBe("undefined");
    expect(
      await evaluate(
        `Object.getPrototypeOf(function*(){}).constructor("return typeof process")().next().value`,
      ),
    ).toBe("undefined");
    expect(
      await evaluate(
        `(await Object.getPrototypeOf(async function*(){}).constructor("return typeof Bun")().next()).value`,
      ),
    ).toBe("undefined");
  });

  test("realm intrinsics that crash or leak are stripped", async () => {
    // `new ShadowRealm()` inside a node:vm context PANICS the Bun process
    // (verified: exit code 3). terminate() cannot save the host from that, so its
    // absence is load-bearing, not tidiness.
    expect(await evaluate("typeof ShadowRealm")).toBe("undefined");
    expect(await evaluate("typeof WebAssembly")).toBe("undefined");
    expect(await evaluate("typeof Atomics")).toBe("undefined");
    expect(await evaluate("typeof SharedArrayBuffer")).toBe("undefined");
    // GC-observable ordering is nondeterminism that silently poisons replay.
    expect(await evaluate("typeof WeakRef")).toBe("undefined");
    expect(await evaluate("typeof FinalizationRegistry")).toBe("undefined");
    expect(await evaluate("typeof eval")).toBe("undefined");
  });
});

describe("workflow sandbox: determinism traps", () => {
  test("wall-clock and entropy sources throw", async () => {
    expect(await expectThrows("Date.now()")).toContain("Date.now()");
    expect(await expectThrows("new Date().getTime()")).toContain("new Date()");
    expect(await expectThrows("Math.random()")).toContain("Math.random()");
  });

  test("the Date prototype cannot be used to walk back to the real clock", async () => {
    // Without trapping Date.prototype.constructor this reads the wall clock
    // straight through the Proxy.
    expect(await expectThrows("new (new Date(0).constructor)().getTime()")).toContain("new Date()");
  });

  test("Intl is not available as a second clock", async () => {
    // `new Intl.DateTimeFormat().format()` returns today's date.
    expect(await evaluate("typeof Intl")).toBe("undefined");
  });

  test("explicit dates and the rest of Math still work", async () => {
    expect(await evaluate("new Date(0).toISOString()")).toBe("1970-01-01T00:00:00.000Z");
    expect(await evaluate("Math.max(1, 5, 3)")).toBe(5);
    expect(await evaluate("Math.round(2.5)")).toBe(3);
  });
});

describe("workflow sandbox: ordinary JavaScript is unaffected", () => {
  test("collections, JSON, classes and async all work", async () => {
    expect(await evaluate("[1,2,3].map((x) => x * 2)")).toEqual([2, 4, 6]);
    expect(await evaluate("JSON.parse(JSON.stringify({ a: 1 })).a")).toBe(1);
    expect(await evaluate("[...new Set([1,1,2])].length")).toBe(2);
    expect(await evaluate("new Map([[1, 'a']]).get(1)")).toBe("a");
    expect(
      await evaluate(
        "(class A { get x() { return 7; } }) && new (class A { get x() { return 7; } })().x",
      ),
    ).toBe(7);
    expect(await evaluate("await Promise.all([1, 2].map(async (n) => n + 1))")).toEqual([2, 3]);
  });
});

describe("workflow sandbox: module loading", () => {
  test("static imports are rejected at compile time", async () => {
    const dir = await workflowTmpDir();
    const outcome = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control: makeFakeControl(),
      script: `import fs from "node:fs";\n${metaHeader()}export default async function run() { return 1; }`,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.issues.some((issue) => issue.path === "imports")).toBe(true);
    }
  });

  test("a literal dynamic import is rejected at compile time", async () => {
    const dir = await workflowTmpDir();
    const outcome = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control: makeFakeControl(),
      script: `${metaHeader()}export default async function run() { return await import("node:fs"); }`,
    });
    expect(outcome.ok).toBe(false);
  });

  test("a computed dynamic import is denied at runtime", async () => {
    // The static scan cannot see through `"node:" + "fs"`, so this is the case
    // that `importModuleDynamically: denyImport` actually has to catch. A live
    // module loader re-obtains every capability the realm removed.
    const dir = await workflowTmpDir();
    const message = await runWorkflow({
      ctx: makeWorkflowCtx(dir),
      control: makeFakeControl(),
      script:
        `${metaHeader()}export default async function run() {\n` +
        `  const specifier = "node:" + "fs";\n` +
        `  return typeof (await import(specifier));\n}`,
    }).then(
      () => "",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(message.toLowerCase()).toContain("import");
  });
});
