import { describe, expect, mock, test } from "bun:test";

import { SessionRegistry } from "../../../src/server/runtime/SessionRegistry";
import type { SessionBinding } from "../../../src/server/startServer/types";

function createShutdownBinding(id: string, settlement: Promise<void> = Promise.resolve()) {
  const cancelAndWaitForSettlement = mock(async () => {
    await settlement;
  });
  const dispose = mock(() => {});
  const waitForPersistenceIdle = mock(async () => {});
  const binding = {
    session: null,
    sinks: new Map([[`journal:${id}`, () => {}]]),
    runtime: {
      id,
      turns: { cancelAndWaitForSettlement },
      lifecycle: { dispose, waitForPersistenceIdle },
    },
  } as unknown as SessionBinding;
  return { binding, cancelAndWaitForSettlement, dispose, waitForPersistenceIdle };
}

function createRegistry(bindings: SessionBinding[]): SessionRegistry {
  return {
    sessionBindings: new Map(bindings.map((binding) => [binding.runtime!.id, binding])),
    sessionIdleSince: new Map<string, number>(),
  } as unknown as SessionRegistry;
}

describe("SessionRegistry shutdown durability", () => {
  test("settles active turns before disposing sessions and flushing their terminal snapshots", async () => {
    let releaseTurn: () => void = () => undefined;
    const turnSettled = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const active = createShutdownBinding("active-thread", turnSettled);
    const registry = createRegistry([active.binding]);

    const shutdown = SessionRegistry.prototype.disposeAll.call(registry, "server stopping");
    await Promise.resolve();

    expect(active.cancelAndWaitForSettlement).toHaveBeenCalledWith({
      includeSubagents: true,
      timeoutMs: 5_000,
    });
    expect(active.dispose).not.toHaveBeenCalled();
    expect(active.waitForPersistenceIdle).not.toHaveBeenCalled();

    releaseTurn();
    await shutdown;

    expect(active.dispose).toHaveBeenCalledWith("server stopping");
    expect(active.waitForPersistenceIdle).toHaveBeenCalledTimes(1);
    expect(registry.sessionBindings.size).toBe(0);
  });

  test("does not close shared provider resources while any sibling turn is still settling", async () => {
    let releaseSibling: () => void = () => undefined;
    const siblingSettled = new Promise<void>((resolve) => {
      releaseSibling = resolve;
    });
    const idle = createShutdownBinding("idle-thread");
    const sibling = createShutdownBinding("busy-sibling", siblingSettled);
    const registry = createRegistry([idle.binding, sibling.binding]);

    const shutdown = SessionRegistry.prototype.disposeAll.call(registry, "server stopping");
    await Promise.resolve();
    await Promise.resolve();

    expect(idle.dispose).not.toHaveBeenCalled();
    expect(sibling.dispose).not.toHaveBeenCalled();

    releaseSibling();
    await shutdown;

    expect(idle.dispose).toHaveBeenCalledTimes(1);
    expect(sibling.dispose).toHaveBeenCalledTimes(1);
  });

  test("retains bindings and waits for persistence before completing shutdown", async () => {
    const persistenceStarted = Promise.withResolvers<void>();
    const persistenceFinished = Promise.withResolvers<void>();
    const active = createShutdownBinding("persisting-thread");
    active.waitForPersistenceIdle.mockImplementation(async () => {
      persistenceStarted.resolve();
      await persistenceFinished.promise;
    });
    const registry = createRegistry([active.binding]);
    registry.sessionIdleSince.set("persisting-thread", 1);
    let shutdownFinished = false;
    const shutdown = SessionRegistry.prototype.disposeAll
      .call(registry, "server stopping")
      .then(() => {
        shutdownFinished = true;
      });

    try {
      await persistenceStarted.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(active.dispose).toHaveBeenCalledWith("server stopping");
      expect(shutdownFinished).toBe(false);
      expect(registry.sessionBindings.get("persisting-thread")).toBe(active.binding);
      expect(registry.sessionIdleSince.has("persisting-thread")).toBe(true);
    } finally {
      persistenceFinished.resolve();
      await shutdown;
    }

    expect(shutdownFinished).toBe(true);
    expect(registry.sessionBindings.size).toBe(0);
    expect(registry.sessionIdleSince.size).toBe(0);
  });

  test("still disposes and flushes a session when cancellation settlement fails", async () => {
    const failedSettlement = Promise.reject(new Error("settlement timeout"));
    failedSettlement.catch(() => {});
    const rejected = createShutdownBinding("failed-settlement", failedSettlement);
    const registry = createRegistry([rejected.binding]);

    await SessionRegistry.prototype.disposeAll.call(registry, "server stopping");

    expect(rejected.dispose).toHaveBeenCalledWith("server stopping");
    expect(rejected.waitForPersistenceIdle).toHaveBeenCalledTimes(1);
    expect(registry.sessionBindings.size).toBe(0);
  });
});
