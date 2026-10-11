import { describe, expect, mock, test } from "bun:test";

import type { SessionEvent } from "../../../src/server/protocol";
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

  test("only the final subscriber starts idleness and reconnecting prevents eviction", () => {
    const { binding, dispose } = createBinding("thread-shared");
    const registry = createRegistry([binding]);
    SessionRegistry.prototype.addBindingSink.call(
      registry,
      binding,
      "jsonrpc:second:thread-shared",
      () => {},
    );

    SessionRegistry.prototype.removeBindingSink.call(registry, binding, "connection:thread-shared");
    expect(registry.sessionIdleSince.has("thread-shared")).toBe(false);
    SessionRegistry.prototype.removeBindingSink.call(
      registry,
      binding,
      "jsonrpc:second:thread-shared",
    );
    expect(registry.sessionIdleSince.has("thread-shared")).toBe(true);

    registry.sessionIdleSince.set("thread-shared", Date.now() - 1_000);
    SessionRegistry.prototype.addBindingSink.call(
      registry,
      binding,
      "jsonrpc:reconnected:thread-shared",
      () => {},
    );
    SessionRegistry.prototype.evictIdleSessionBindings.call(registry, 100);

    expect(registry.sessionIdleSince.has("thread-shared")).toBe(false);
    expect(registry.sessionBindings.get("thread-shared")).toBe(binding);
    expect(dispose).not.toHaveBeenCalled();
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

  test("session_busy clears the idle clock and restarts it only after the last client leaves", async () => {
    const disconnected = createIdleEmitHarness({ connected: false });
    disconnected.registry.sessionIdleSince.set("thread-1", 1);
    disconnected.emit({
      type: "session_busy",
      sessionId: "thread-1",
      busy: true,
      turnId: "turn-1",
    });
    expect(disconnected.registry.sessionIdleSince.has("thread-1")).toBe(false);
    expect(disconnected.handleThreadOutcome).not.toHaveBeenCalled();

    disconnected.emit({
      type: "session_busy",
      sessionId: "thread-1",
      busy: false,
      outcome: "error",
    });
    const idleSince = disconnected.registry.sessionIdleSince.get("thread-1");
    expect(idleSince).toBeGreaterThan(1);
    expect(disconnected.handleThreadOutcome).toHaveBeenCalledWith("thread-1", "error");
    await Promise.resolve();
    await Promise.resolve();
    expect(disconnected.checkpointThread).toHaveBeenCalledWith("thread-1", "turn error");

    const connected = createIdleEmitHarness();
    connected.registry.sessionIdleSince.set("thread-1", 1);
    connected.emit({
      type: "session_busy",
      sessionId: "thread-1",
      busy: false,
    });
    expect(connected.registry.sessionIdleSince.get("thread-1")).toBe(1);
    expect(connected.handleThreadOutcome).toHaveBeenCalledWith("thread-1", "completed");
    await Promise.resolve();
    await Promise.resolve();
    expect(connected.checkpointThread).toHaveBeenCalledWith("thread-1", "turn completed");

    connected.binding.sinks.set("connection:failing", () => {
      throw new Error("sink failed");
    });
    connected.emit({
      type: "session_busy",
      sessionId: "thread-1",
      busy: true,
    });
    expect(connected.registry.sessionIdleSince.has("thread-1")).toBe(false);
  });
});

function createIdleEmitHarness(opts: { connected?: boolean } = {}) {
  const { binding } = createBinding("thread-1", { connected: opts.connected !== false });
  const handleThreadOutcome = mock(async () => {});
  const checkpointThread = mock(async () => {});
  const registry = Object.assign(Object.create(SessionRegistry.prototype), {
    config: { userCoworkDir: "/workspace/.cowork", projectCoworkDir: "/workspace/.cowork" },
    discoveredSkills: [],
    options: {
      env: {},
      sessionDb: {},
      taskCoordinator: { handleThreadOutcome, checkpointThread },
    },
    sessionBindings: new Map([["thread-1", binding]]),
    sessionIdleSince: new Map<string, number>(),
  }) as SessionRegistry;
  const dependencies = (
    registry as unknown as {
      buildSessionCommon: (target: SessionBinding) => {
        emit: (event: SessionEvent) => void;
      };
    }
  ).buildSessionCommon(binding);
  return { registry, binding, emit: dependencies.emit, handleThreadOutcome, checkpointThread };
}
