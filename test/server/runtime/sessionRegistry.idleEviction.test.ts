import { describe, expect, mock, test } from "bun:test";

import { SessionRegistry } from "../../../src/server/runtime/SessionRegistry";

type FakeBinding = {
  runtime: {
    id: string;
    read: { isBusy: boolean };
    lifecycle: { dispose: ReturnType<typeof mock> };
  };
  sinks: Map<string, (evt: unknown) => void>;
};

function makeRegistry(bindings: Array<[string, FakeBinding]>) {
  const sessionBindings = new Map(bindings);
  const sessionIdleSince = new Map<string, number>();
  return {
    sessionBindings,
    sessionIdleSince,
  } as unknown as SessionRegistry & {
    sessionBindings: Map<string, FakeBinding>;
    sessionIdleSince: Map<string, number>;
  };
}

function makeBinding(id: string, opts: { busy?: boolean } = {}): FakeBinding {
  return {
    runtime: {
      id,
      read: { isBusy: opts.busy ?? false },
      lifecycle: { dispose: mock(() => {}) },
    },
    sinks: new Map(),
  };
}

describe("SessionRegistry idle eviction", () => {
  test("starts the idle clock when the last live sink leaves a journal-backed binding", () => {
    const binding = makeBinding("thread-journal");
    const registry = makeRegistry([["thread-journal", binding]]);
    const sink = () => {};

    SessionRegistry.prototype.addBindingSink.call(registry, binding, "journal:thread-journal", sink);
    SessionRegistry.prototype.addBindingSink.call(registry, binding, "conn:1", sink);
    expect(registry.sessionIdleSince.has("thread-journal")).toBe(false);

    SessionRegistry.prototype.removeBindingSink.call(registry, binding, "conn:1");

    expect(binding.sinks.has("journal:thread-journal")).toBe(true);
    expect(registry.sessionIdleSince.has("thread-journal")).toBe(true);
  });

  test("evicts idle journal-backed sessions after the timeout when not busy", () => {
    const binding = makeBinding("thread-idle");
    const registry = makeRegistry([["thread-idle", binding]]);
    const sink = () => {};

    SessionRegistry.prototype.addBindingSink.call(registry, binding, "journal:thread-idle", sink);
    SessionRegistry.prototype.addBindingSink.call(registry, binding, "conn:1", sink);
    SessionRegistry.prototype.removeBindingSink.call(registry, binding, "conn:1");
    registry.sessionIdleSince.set("thread-idle", Date.now() - 10_000);

    SessionRegistry.prototype.evictIdleSessionBindings.call(registry, 1_000);

    expect(binding.runtime.lifecycle.dispose).toHaveBeenCalledWith("idle eviction");
    expect(registry.sessionBindings.has("thread-idle")).toBe(false);
    expect(registry.sessionIdleSince.has("thread-idle")).toBe(false);
  });

  test("does not evict busy sessions past the idle timeout", () => {
    const binding = makeBinding("thread-busy", { busy: true });
    const registry = makeRegistry([["thread-busy", binding]]);
    const sink = () => {};

    SessionRegistry.prototype.addBindingSink.call(registry, binding, "journal:thread-busy", sink);
    SessionRegistry.prototype.addBindingSink.call(registry, binding, "conn:1", sink);
    SessionRegistry.prototype.removeBindingSink.call(registry, binding, "conn:1");
    registry.sessionIdleSince.set("thread-busy", Date.now() - 10_000);

    SessionRegistry.prototype.evictIdleSessionBindings.call(registry, 1_000);

    expect(binding.runtime.lifecycle.dispose).not.toHaveBeenCalled();
    expect(registry.sessionBindings.has("thread-busy")).toBe(true);
  });

  test("clears the idle clock when a live sink reattaches", () => {
    const binding = makeBinding("thread-rejoin");
    const registry = makeRegistry([["thread-rejoin", binding]]);
    const sink = () => {};

    SessionRegistry.prototype.addBindingSink.call(registry, binding, "journal:thread-rejoin", sink);
    SessionRegistry.prototype.addBindingSink.call(registry, binding, "conn:1", sink);
    SessionRegistry.prototype.removeBindingSink.call(registry, binding, "conn:1");
    expect(registry.sessionIdleSince.has("thread-rejoin")).toBe(true);

    SessionRegistry.prototype.addBindingSink.call(registry, binding, "conn:2", sink);

    expect(registry.sessionIdleSince.has("thread-rejoin")).toBe(false);
  });

  test("still evicts non-journal bindings with empty sinks", () => {
    const binding = makeBinding("control-idle");
    const registry = makeRegistry([["control-idle", binding]]);
    const sink = () => {};

    SessionRegistry.prototype.addBindingSink.call(registry, binding, "conn:1", sink);
    SessionRegistry.prototype.removeBindingSink.call(registry, binding, "conn:1");
    registry.sessionIdleSince.set("control-idle", Date.now() - 10_000);

    SessionRegistry.prototype.evictIdleSessionBindings.call(registry, 1_000);

    expect(binding.runtime.lifecycle.dispose).toHaveBeenCalledWith("idle eviction");
    expect(registry.sessionBindings.has("control-idle")).toBe(false);
  });
});
