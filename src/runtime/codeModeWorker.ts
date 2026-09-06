import { RESTRICTED_REALM_SEAL_SOURCE } from "../utils/restrictedRealm";

/**
 * Build closures inside the restricted realm, capturing intrinsics before model
 * code can replace them. Only JSON strings and operation/status primitives cross
 * the private bridge. In
 * particular, never await a model-owned promise/thenable in the host realm:
 * its `then` could capture host resolve/reject functions.
 */
const REALM_SOURCE = `
((bridge, complete) => {
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const RealmError = Error;
  const then = Function.prototype.call.bind(Promise.prototype.then);
  const invoke = (operation, input) => {
    const promise = (async () => {
      const payload = stringify(input);
      if (typeof payload !== "string") throw new RealmError("tool input must be JSON data");
      const response = parse(await bridge(operation, payload));
      if (!response.ok) throw new RealmError(response.message);
      return response.value;
    })();
    // Detached rejections remain observed without changing the promise callers
    // receive (and can catch). The worker independently drains dispatched RPCs.
    then(promise, undefined, () => {});
    return promise;
  };
  const tools = Object.freeze({
    call: (name, args) => invoke("call", { name, arguments: args }),
    search: (query) => invoke("search", { query }),
  });
  const errorMessage = (error) => {
    try { return String(error && error.message ? error.message : error).slice(0, 4000); }
    catch { return "code mode failed"; }
  };
  return (run) => {
    const execution = (async () => {
      try {
        const value = await run(tools);
        const payload = stringify(value === undefined ? null : value);
        if (typeof payload !== "string") throw new RealmError("return value must be JSON data");
        complete(true, payload);
      } catch (error) {
        complete(false, errorMessage(error));
      }
    })();
    then(execution, undefined, (error) => complete(false, errorMessage(error)));
  };
})
`;

/**
 * MUST remain inline source booted via Blob, not a runtime-relative Worker
 * module: Bun's split/compiled bundles can omit worker-only sibling modules.
 * vm restricts ambient capabilities; the Worker interrupts runaway execution.
 * Neither is an OS security boundary or a hard memory quota.
 */
export const CODE_MODE_WORKER_SOURCE = `
import vm from "node:vm";

let started = false;
let stopped = false;
let nextId = 0;
const pending = new Map();
const active = new Set();
const encoder = new TextEncoder();
const post = (message) => { if (!stopped) postMessage(message); };
const fail = (message) => {
  if (stopped) return;
  post({ t: "error", message });
  stopped = true;
};
const drain = async () => {
  for (;;) {
    await Promise.allSettled(Array.from(active));
    // A task boundary, not just one microtask: detached .then chains may
    // schedule more calls several promise continuations after the last reply.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (active.size === 0) return;
  }
};

self.onmessage = async ({ data: msg }) => {
  if (stopped) return;
  if (msg.t === "result") {
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    entry.resolve(msg.payload);
    return;
  }
  if (msg.t !== "start" || started) return;
  started = true;
  try {
    // A host Object.prototype would expose its Function through the global's
    // inherited constructor, even after the own-global allowlist is applied.
    const context = vm.createContext(Object.create(null));
    vm.runInContext(${JSON.stringify(RESTRICTED_REALM_SEAL_SOURCE)}, context);
    const makeRealmError = vm.runInContext(
      "((RealmError) => (message) => new RealmError(message))(Error)", context
    );
    const toRealmError = (error) => {
      let message = "code mode transport failed";
      try { message = String(error && error.message ? error.message : error).slice(0, 4000); } catch {}
      return makeRealmError(message);
    };
    const bridge = (operation, payload) => {
      try {
        if (stopped) throw makeRealmError("code mode stopped");
        if (operation !== "call" && operation !== "search") throw makeRealmError("invalid operation");
        if (typeof payload !== "string") throw makeRealmError("tool input must be JSON data");
        if (encoder.encode(payload).byteLength > msg.limits.maxArgumentBytes) {
          throw makeRealmError("code mode tool input exceeds maxArgumentBytes");
        }
        if (nextId >= msg.limits.maxCalls) {
          const message = "code mode exceeded maxCalls (" + msg.limits.maxCalls + ")";
          fail(message);
          throw makeRealmError(message);
        }
        const id = nextId++;
        const call = new Promise((resolve, reject) => {
          pending.set(id, { resolve });
          try { post({ t: "request", id, operation, payload }); }
          catch (error) { pending.delete(id); reject(toRealmError(error)); }
        });
        const tracked = call.catch((error) => { throw toRealmError(error); });
        active.add(tracked);
        tracked.then(() => active.delete(tracked), () => active.delete(tracked));
        return tracked;
      } catch (error) {
        // Synchronous transport/validation failures also need realm errors.
        throw toRealmError(error);
      }
    };
    const complete = (ok, payload) => {
      if (stopped) return;
      if (typeof payload !== "string") { fail("code mode returned non-JSON data"); return; }
      if (!ok) { fail(payload); return; }
      if (encoder.encode(payload).byteLength > msg.limits.maxOutputBytes) {
        fail("code mode output exceeds maxOutputBytes");
        return;
      }
      void drain().then(() => {
        post({ t: "done", payload });
        stopped = true;
      }, (error) => fail(String(error)));
    };
    const build = vm.runInContext(${JSON.stringify(REALM_SOURCE)}, context);
    const start = build(bridge, complete);
    const denyImport = () => { throw makeRealmError("imports are not available in code mode"); };
    const mod = new vm.SourceTextModule(
      'export default async function(tools) { "use strict";\\n' + msg.code + '\\n}',
      { context, importModuleDynamically: denyImport }
    );
    await mod.link(denyImport);
    await mod.evaluate();
    start(mod.namespace.default);
  } catch (error) {
    let message = "code mode failed";
    try { message = String(error && error.message ? error.message : error).slice(0, 4000); } catch {}
    fail(message);
  }
};
`;
