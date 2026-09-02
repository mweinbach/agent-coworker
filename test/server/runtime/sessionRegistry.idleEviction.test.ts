import { describe, expect, mock, test } from "bun:test";

import { SessionRegistry } from "../../../src/server/runtime/SessionRegistry";
import type { SessionBinding } from "../../../src/server/startServer/types";

function createBinding(id: string, opts: { busy?: boolean; connected?: boolean } = {}) {
  const dispose = mock(() => {});
  const cancel = mock(() => {});
  const sinks = new Map<string, (event: never) => void>([[`journal:${id}`, () => {}]]);
  if (opts.connected !== false) {
    sinks.set(`connection:${id}`, () => {});
  }
  const binding = {
    session: null,
    socket: null,
    sinks,
    runtime: {
      id,
      read: { isBusy: opts.busy === true },
      turns: { cancel },
      lifecycle: { dispose },
    },
  } as unknown as SessionBinding;
  return { binding, dispose, cancel };
}

function createRegistry(bindings: SessionBinding[]): SessionRegistry {
  return {
    sessionBindings: new Map(bindings.map((binding) => [binding.runtime!.id, binding])),
    sessionIdleSince: new Map<string, number>(),
    countLiveConnectionSinks: SessionRegistry.prototype.countLiveConnectionSinks,
    disposeBinding: SessionRegistry.prototype.disposeBinding,
  } as unknown as SessionRegistry;
}

describe("SessionRegistry idle thread lifecycle", () => {
  test("marks a thread idle when its last client disconnects despite its durable journal sink", () => {
    const { binding } = createBinding("thread-idle");
    const registry = createRegistry([binding]);

    SessionRegistry.prototype.removeBindingSink.call(registry, binding, "connection:thread-idle");

    expect(binding.sinks.has("journal:thread-idle")).toBe(true);
    expect(registry.sessionIdleSince.has("thread-idle")).toBe(true);
  });

  test("evicts journal-only idle threads without closing a busy sibling's shared Codex client", () => {
    const idle = createBinding("thread-idle", { connected: false });
    const busy = createBinding("thread-busy", { busy: true });
    const registry = createRegistry([idle.binding, busy.binding]);
    registry.sessionIdleSince.set("thread-idle", Date.now() - 1_000);

    SessionRegistry.prototype.evictIdleSessionBindings.call(registry, 100);

    expect(idle.dispose).toHaveBeenCalledWith("idle eviction", {
      closeSharedCodexClient: false,
    });
    expect(registry.sessionBindings.has("thread-idle")).toBe(false);
    expect(registry.sessionIdleSince.has("thread-idle")).toBe(false);
    expect(busy.dispose).not.toHaveBeenCalled();
    expect(registry.sessionBindings.has("thread-busy")).toBe(true);
  });

  test("never evicts a busy thread even after its last client disconnects", () => {
    const busy = createBinding("thread-busy", { busy: true, connected: false });
    const registry = createRegistry([busy.binding]);
    registry.sessionIdleSince.set("thread-busy", Date.now() - 1_000);

    SessionRegistry.prototype.evictIdleSessionBindings.call(registry, 100);

    expect(busy.dispose).not.toHaveBeenCalled();
    expect(registry.sessionBindings.has("thread-busy")).toBe(true);
  });

  test("disposing an individual thread preserves the workspace-shared Codex client by default", () => {
    const removed = createBinding("thread-removed");
    const busy = createBinding("thread-busy", { busy: true });
    const registry = createRegistry([removed.binding, busy.binding]);

    SessionRegistry.prototype.disposeBinding.call(registry, removed.binding, "thread deleted");

    expect(removed.cancel).toHaveBeenCalledTimes(1);
    expect(removed.dispose).toHaveBeenCalledWith("thread deleted", {
      closeSharedCodexClient: false,
    });
    expect(busy.dispose).not.toHaveBeenCalled();
  });
});
