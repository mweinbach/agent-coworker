/**
 * Source of the worker thread that executes a model-authored workflow script.
 *
 * ⚠️ THIS MUST STAY A STRING CONSTANT. DO NOT "clean it up" into a sibling module.
 *
 * `Bun.build({ splitting: true, target: "bun" })` silently drops modules that are
 * only referenced as `new Worker(new URL("./child.ts", import.meta.url).href)` —
 * it emits the entrypoint alone. A real sibling file therefore works under
 * `bun src/server/index.ts` and ships BROKEN in the packaged binary, a failure
 * that never reproduces in development. Keeping the source inline as a string and
 * booting it from a `blob:` URL sidesteps the bundler entirely, needs no temp
 * files, and is verified to survive `bun build --compile`.
 *
 * ── Why two boundaries ────────────────────────────────────────────────────────
 *
 * The script is authored by a language model, so it is untrusted input.
 *
 *   • The `node:vm` context provides the AUTHORITY boundary. A fresh realm has no
 *     ambient capabilities and confines the function-constructor chain:
 *     `(function(){}).constructor("return typeof Bun")()` evaluates to `undefined`
 *     inside it, where in a merely parameter-shadowed scope
 *     `[].constructor.constructor("return process")()` reaches the real global.
 *
 *   • The `Worker` provides the AVAILABILITY boundary. `vm` cannot interrupt
 *     `while(true){}`; without a separate thread one such script would freeze the
 *     whole Cowork server — every session, every socket, every in-flight agent.
 *     Worker startup measures 13–16ms against agent calls that take seconds.
 *
 * ── Why the seal is an allowlist ──────────────────────────────────────────────
 *
 * A fresh Bun vm realm ships `ShadowRealm`, `WebAssembly`, `Atomics`,
 * `SharedArrayBuffer`, `WeakRef`, `FinalizationRegistry`, `Intl` and `eval`, and
 * that set grows with each engine release. Two of those are not merely untidy:
 *
 *   • `new ShadowRealm()` inside a vm context CRASHES the Bun process (verified:
 *     exit code 3, a panic — not a catchable exception). `terminate()` cannot save
 *     you from a process panic, so a denylist that misses it forfeits the entire
 *     availability argument.
 *   • `Intl` is an independent clock (`new Intl.DateTimeFormat().format()`), and
 *     `WeakRef`/`FinalizationRegistry` expose GC ordering. Both silently poison
 *     journal replay, which is worse than having no resume at all.
 *
 * So we enumerate `Object.getOwnPropertyNames(globalThis)` inside the realm and
 * strip everything not explicitly permitted. Adding a global to ALLOWED_GLOBALS is
 * a deliberate act; forgetting to deny a new one is not silently fatal.
 *
 * Any change here must keep `test/workflows/sandbox.escape.test.ts` green — that
 * suite pins the escape surface so a Bun upgrade which reopens the realm fails CI
 * rather than the journal.
 */

/** Globals a workflow script is permitted to see. Everything else is stripped. */
const ALLOWED_GLOBALS = [
  "globalThis",
  "undefined",
  "NaN",
  "Infinity",
  "isNaN",
  "isFinite",
  "parseInt",
  "parseFloat",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "Object",
  "Function",
  "Array",
  "String",
  "Boolean",
  "Number",
  "Math",
  "Date",
  "RegExp",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "AggregateError",
  "SuppressedError",
  "JSON",
  "Promise",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Symbol",
  "BigInt",
  "Proxy",
  "Reflect",
  "Iterator",
  "console",
  "ArrayBuffer",
  "DataView",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float16Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "DisposableStack",
  "AsyncDisposableStack",
];

/**
 * In-realm source: strips non-allowlisted globals and installs determinism traps.
 * Evaluated inside the vm context before any model-authored code.
 */
const SEAL_SOURCE = `
(() => {
  const ALLOWED = new Set(__ALLOWED__);
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    if (ALLOWED.has(name)) continue;
    try { delete globalThis[name]; } catch {}
    if (name in globalThis) {
      try {
        Object.defineProperty(globalThis, name, { value: undefined, configurable: false });
      } catch {}
    }
  }

  const deny = (what) => () => {
    throw new Error(
      what + " is not available in workflow scripts: it would break journal resume. " +
      "Derive the value from args or the call index instead."
    );
  };

  // Determinism traps are narrowing Proxies, not removals: new Date(0) and the
  // rest of Math keep working. The thrown message is the documentation the
  // authoring model actually reads, so it names the reason and the alternative.
  const RealDate = Date;
  const TrappedDate = new Proxy(RealDate, {
    construct: (t, a) => (a.length === 0 ? deny("new Date()")() : Reflect.construct(t, a)),
    get: (t, p) => (p === "now" ? deny("Date.now()")() : Reflect.get(t, p)),
  });
  // Required: without it, new (new Date(0).constructor)() walks back to the real
  // Date and reads the wall clock straight through the Proxy.
  Object.defineProperty(RealDate.prototype, "constructor", {
    value: TrappedDate,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(globalThis, "Date", { value: TrappedDate, configurable: false });
  Object.defineProperty(Math, "random", { value: deny("Math.random()"), configurable: false });
})();
`;

/**
 * In-realm source: builds the host object handed to the script's default export.
 *
 * `parallel`/`pipeline`/`judge`/`compact` are defined HERE, inside the realm, so
 * the arrays and promises they produce are realm-native. `agent` is deliberately
 * not exposed as a realm global — it arrives only via the destructured argument.
 */
const HOST_SOURCE = `
((bridge, argsJson, budgetTotal) => {
  const budgetState = { spent: 0 };
  bridge.onBudget = (spent) => { budgetState.spent = spent; };

  const agent = async (prompt, opts) => {
    // JSON at the boundary: guarantees the value the script sees has realm-native
    // prototypes, and guarantees it is serializable — which the journal requires.
    const raw = await bridge.agent(JSON.stringify({ prompt, opts: opts || {} }));
    const parsed = JSON.parse(raw);
    if (!parsed.ok) {
      const err = new Error(parsed.message);
      if (parsed.stack) err.stack = parsed.stack;
      throw err;
    }
    return parsed.value;
  };

  // Barrier. Every thunk runs; a rejected thunk yields null so a partial fan-out
  // still returns. Per-call onError:"fail" (the default) rejects before this,
  // which is what makes a task-locked parent abort instead of degrading into N nulls.
  const parallel = async (thunks) => {
    const settled = await Promise.allSettled(Array.from(thunks, (t) => t()));
    const out = [];
    for (const r of settled) out.push(r.status === "fulfilled" ? r.value : null);
    return out;
  };

  // No barrier between stages: item 2 may reach stage 3 while item 5 is still in
  // stage 1. Wall-clock is the slowest single chain, not the sum of per-stage maxima.
  const pipeline = async (items, ...stages) => {
    const runItem = async (item, index) => {
      let acc = item;
      for (const stage of stages) {
        if (acc === null || acc === undefined) return null;
        acc = await stage(acc, item, index);
      }
      return acc;
    };
    const settled = await Promise.allSettled(Array.from(items, runItem));
    const out = [];
    for (const r of settled) out.push(r.status === "fulfilled" ? r.value : null);
    return out;
  };

  const compact = (items) => Array.from(items).filter((v) => v !== null && v !== undefined);

  // Vote aggregation is where model-written orchestration JS goes subtly wrong,
  // so the correct version ships as a helper rather than being rewritten per script.
  const judge = async (candidate, opts) => {
    const n = Math.max(1, Math.min(9, (opts && opts.n) || 3));
    const rubric = (opts && opts.rubric) || "Is this correct?";
    const aggregate = (opts && opts.aggregate) || "majority";
    const agentOpts = Object.assign({}, (opts && opts.agent) || {});
    const schema = {
      type: "object",
      properties: {
        pass: { type: "boolean" },
        score: { type: "number" },
        reason: { type: "string" },
      },
      required: ["pass", "score", "reason"],
      additionalProperties: false,
    };
    const votes = compact(
      await parallel(
        Array.from({ length: n }, (_unused, i) => () =>
          agent(
            rubric +
              "\\n\\nCandidate:\\n" +
              (typeof candidate === "string" ? candidate : JSON.stringify(candidate, null, 1)) +
              "\\n\\nJudge independently. You are judge " + (i + 1) + " of " + n + ".",
            Object.assign({}, agentOpts, {
              schema,
              label: (agentOpts.label || "judge") + ":" + (i + 1),
              onError: "null",
            })
          )
        )
      )
    );
    if (votes.length === 0) return { verdict: "fail", score: 0, votes: [] };
    const passes = votes.filter((v) => v && v.pass === true).length;
    const scores = votes.map((v) => (v && typeof v.score === "number" ? v.score : 0));
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    let verdict;
    if (aggregate === "unanimous") verdict = passes === votes.length ? "pass" : "fail";
    else if (aggregate === "worst") verdict = passes === votes.length ? "pass" : "fail";
    else if (aggregate === "meanScore") verdict = mean >= 0.5 ? "pass" : "fail";
    else verdict = passes * 2 > votes.length ? "pass" : "fail";
    const score = aggregate === "worst" ? Math.min.apply(null, scores) : mean;
    return { verdict, score, votes };
  };

  // A labelled scope for progress + journaling. NOT invocation of a registered
  // workflow — there is no registry in v1.
  const workflow = async (label, fn) => {
    bridge.phase(String(label));
    return await fn();
  };

  const host = {
    agent,
    parallel,
    pipeline,
    compact,
    judge,
    workflow,
    phase: (title) => bridge.phase(String(title)),
    log: (message) => bridge.log(String(message)),
    args: Object.freeze(JSON.parse(argsJson)),
    budget: {
      total: budgetTotal,
      spent: () => budgetState.spent,
      remaining: () =>
        budgetTotal === null ? Infinity : Math.max(0, budgetTotal - budgetState.spent),
    },
  };

  // Ergonomic realm globals. \`agent\` is intentionally absent: forcing it through
  // the destructured argument is what makes "meta must be a pure literal"
  // structural — host functions do not exist during module top-level evaluation.
  globalThis.parallel = parallel;
  globalThis.pipeline = pipeline;
  globalThis.compact = compact;
  globalThis.judge = judge;

  return host;
})
`;

/**
 * The worker module source. Booted from a `blob:` URL by `WorkflowRunner`.
 */
export const WORKFLOW_WORKER_BOOTSTRAP = `
import vm from "node:vm";

const post = (msg) => postMessage(msg);
const pending = new Map();
const activeRpcs = new Set();
let nextCallId = 0;

const rpc = (make) => {
  const call = new Promise((resolve, reject) => {
    const callId = nextCallId++;
    pending.set(callId, { resolve, reject });
    post(make(callId));
  });
  let tracked;
  tracked = call.finally(() => activeRpcs.delete(tracked));
  activeRpcs.add(tracked);
  return tracked;
};

const drainRpcs = async () => {
  for (;;) {
    // Flush promise continuations first: a detached chain may enqueue its next
    // agent() only after the previous RPC resolves.
    await Promise.resolve();
    const active = Array.from(activeRpcs);
    if (active.length === 0) {
      await Promise.resolve();
      if (activeRpcs.size === 0) return;
      continue;
    }
    await Promise.allSettled(active);
  }
};

let onBudgetUpdate = null;

self.onmessage = async (ev) => {
  const msg = ev.data;

  if (msg.t === "agentResult" || msg.t === "metaAck") {
    const entry = pending.get(msg.callId);
    if (!entry) return;
    pending.delete(msg.callId);
    if (msg.ok === false) entry.reject(new Error(msg.message || "host rejected the call"));
    else entry.resolve(msg.payload);
    return;
  }

  if (msg.t === "budgetUpdate") {
    if (onBudgetUpdate) onBudgetUpdate(msg.spentUsd);
    return;
  }

  if (msg.t !== "start") return;

  try {
    const context = vm.createContext({});
    vm.runInContext(${JSON.stringify(SEAL_SOURCE)}.replace("__ALLOWED__", ${JSON.stringify(
      JSON.stringify(ALLOWED_GLOBALS),
    )}), context);

    const denyImport = () => {
      throw new Error(
        "imports are not available in workflow scripts; everything you need is the argument to the default export"
      );
    };

    const bridge = {
      agent: (payload) => rpc((callId) => ({ t: "agent", callId, payload })),
      phase: (title) => post({ t: "phase", title }),
      log: (message) => post({ t: "log", message }),
      set onBudget(fn) { onBudgetUpdate = fn; },
    };

    const buildHost = vm.runInContext(${JSON.stringify(HOST_SOURCE)}, context);
    const host = buildHost(bridge, msg.argsJson, msg.budgetTotal);

    const mod = new vm.SourceTextModule(msg.js, {
      context,
      importModuleDynamically: denyImport,
    });
    await mod.link(denyImport);
    // Host functions are NOT reachable during this evaluation — that is what makes
    // \`meta\` structurally a pure literal rather than something an AST walk polices.
    await mod.evaluate();

    const meta = mod.namespace.meta;
    const ack = await rpc((callId) => ({
      t: "meta",
      callId,
      meta: JSON.parse(JSON.stringify(meta === undefined ? null : meta)),
    }));
    if (ack && ack.ok === false) throw new Error(ack.message);

    const run = mod.namespace.default;
    if (typeof run !== "function") {
      throw new Error("the default export must be a function");
    }

    const result = await run(host);
    await drainRpcs();
    post({ t: "done", result: JSON.parse(JSON.stringify(result === undefined ? null : result)) });
  } catch (error) {
    post({
      t: "error",
      message: error && error.message ? String(error.message) : String(error),
      stack: error && error.stack ? String(error.stack) : undefined,
    });
  }
};
`;
