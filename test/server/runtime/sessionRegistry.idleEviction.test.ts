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
});

function makeBuiltThread(id: string) {
  return {
    session: { id, warmSessionResources: () => {} },
    runtime: { id, read: { isBusy: false }, settings: { setTitle: () => {} } },
  };
}

function makeIdleClockRegistry(opts: {
  bindings?: Map<string, SessionBinding>;
  buildSession?: () => ReturnType<typeof makeBuiltThread>;
  ensureSink?: (
    binding: SessionBinding,
    sessionId: string,
    addSink: (binding: SessionBinding, sinkId: string, sink: () => void) => void,
  ) => void;
  getSessionRecord?: (sessionId: string) => { sessionId: string } | null;
}) {
  return Object.assign(Object.create(SessionRegistry.prototype), {
    config: { workingDirectory: "/workspace" },
    buildSession: opts.buildSession ?? (() => makeBuiltThread("thread-created")),
    options: {
      shouldWarmSessionResources: () => false,
      threadJournal: {
        ensureSink: (
          binding: SessionBinding,
          sessionId: string,
          addSink: (binding: SessionBinding, sinkId: string, sink: () => void) => void,
        ) => {
          opts.ensureSink?.(binding, sessionId, addSink);
        },
      },
      sessionDb: {
        getSessionRecord: (sessionId: string) => opts.getSessionRecord?.(sessionId) ?? null,
      },
    },
    sessionBindings: opts.bindings ?? new Map(),
    sessionIdleSince: new Map<string, number>(),
  }) as SessionRegistry;
}

function attachJournalSink(
  binding: SessionBinding,
  sessionId: string,
  addSink: (binding: SessionBinding, sinkId: string, sink: () => void) => void,
) {
  addSink(binding, `journal:${sessionId}`, () => {});
}

describe("SessionRegistry idle clock on create and load", () => {
  test("starts the idle clock for a new thread that only has its journal sink", () => {
    const registry = makeIdleClockRegistry({ ensureSink: attachJournalSink });

    const runtime = registry.createJsonRpcThreadSession("/workspace");

    expect(runtime.id).toBe("thread-created");
    expect(registry.sessionIdleSince.get("thread-created")).toBeGreaterThan(0);
    expect(
      registry.sessionBindings.get("thread-created")?.sinks.has("journal:thread-created"),
    ).toBe(true);
  });

  test("does not start the idle clock when thread setup attaches a client sink", () => {
    const registry = makeIdleClockRegistry({
      ensureSink: (binding, sessionId, addSink) => {
        attachJournalSink(binding, sessionId, addSink);
        addSink(binding, `connection:${sessionId}`, () => {});
      },
    });

    registry.createJsonRpcThreadSession("/workspace");

    expect(registry.sessionIdleSince.has("thread-created")).toBe(false);
  });

  test("starts the idle clock when a persisted thread is loaded with only a journal sink", () => {
    const registry = makeIdleClockRegistry({
      buildSession: () => makeBuiltThread("thread-cold"),
      ensureSink: attachJournalSink,
      getSessionRecord: () => ({ sessionId: "thread-cold" }),
    });

    const binding = registry.loadThreadBinding("thread-cold");

    expect(binding?.runtime?.id).toBe("thread-cold");
    expect(registry.sessionIdleSince.get("thread-cold")).toBeGreaterThan(0);
  });

  test("does not start the idle clock when loading a persisted thread attaches a client", () => {
    const registry = makeIdleClockRegistry({
      buildSession: () => makeBuiltThread("thread-cold"),
      ensureSink: (binding, sessionId, addSink) => {
        attachJournalSink(binding, sessionId, addSink);
        addSink(binding, `connection:${sessionId}`, () => {});
      },
      getSessionRecord: () => ({ sessionId: "thread-cold" }),
    });

    registry.loadThreadBinding("thread-cold");

    expect(registry.sessionIdleSince.has("thread-cold")).toBe(false);
  });

  test("restarts the idle clock when a disconnected idle thread is loaded again", () => {
    const { binding } = createBinding("thread-idle", { connected: false });
    const registry = makeIdleClockRegistry({
      bindings: new Map([["thread-idle", binding]]),
    });
    registry.sessionIdleSince.set("thread-idle", 1);

    const loaded = registry.loadThreadBinding("thread-idle");

    expect(loaded).toBe(binding);
    expect(registry.sessionIdleSince.get("thread-idle")).toBeGreaterThan(1);
  });

  test("leaves the idle clock untouched when a busy thread is loaded", () => {
    const { binding } = createBinding("thread-busy", { busy: true, connected: false });
    const registry = makeIdleClockRegistry({
      bindings: new Map([["thread-busy", binding]]),
    });
    registry.sessionIdleSince.set("thread-busy", 1);

    registry.loadThreadBinding("thread-busy");

    expect(registry.sessionIdleSince.get("thread-busy")).toBe(1);
  });

  test("does not mark a live client thread idle when it is loaded", () => {
    const { binding } = createBinding("thread-live");
    const registry = makeIdleClockRegistry({
      bindings: new Map([["thread-live", binding]]),
    });

    registry.loadThreadBinding("thread-live");

    expect(registry.sessionIdleSince.has("thread-live")).toBe(false);
  });

  test("does not mark an unknown thread idle", () => {
    const registry = makeIdleClockRegistry({});

    expect(registry.loadThreadBinding("missing")).toBeNull();
    expect(registry.sessionIdleSince.size).toBe(0);
  });
});

function makeChildSession(id: string) {
  return {
    id,
    sessionKind: "agent",
    parentSessionId: "parent-1",
    role: "research",
    persistenceStatus: "active",
    isBusy: false,
    currentTurnOutcome: "error",
    isAgentOf: (parentSessionId: string) => parentSessionId === "parent-1",
    beginDisconnectedReplayBuffer: () => {},
    getSessionInfoEvent: () => ({
      title: "Research child",
      provider: "google",
      createdAt: "2026-10-06T00:00:00.000Z",
      updatedAt: "2026-10-06T00:00:00.000Z",
      effectiveModel: "gemini-3-flash",
      mode: "collaborative",
      depth: 1,
    }),
    getLatestAssistantText: () => null,
    getCompactUsageSnapshot: () => null,
    getLastTurnUsage: () => null,
  };
}

describe("SessionRegistry child-agent idle clock", () => {
  test("starts the idle clock when a persisted child agent is hydrated", async () => {
    const session = makeChildSession("child-1");
    const registry = Object.assign(Object.create(SessionRegistry.prototype), {
      agentControl: null,
      buildSession: () => ({
        session,
        runtime: { id: session.id },
        isResume: true,
        resumedFromStorage: true,
      }),
      config: {},
      options: {
        sessionDb: {
          getSessionRecord: (sessionId: string) =>
            sessionId === session.id
              ? {
                  sessionId: session.id,
                  parentSessionId: "parent-1",
                  sessionKind: "agent",
                }
              : null,
        },
        loadAgentPrompt: async () => "",
        taskCoordinator: {
          getForThread: () => null,
          getActiveForSourceSession: () => null,
        },
      },
      sessionBindings: new Map(),
      sessionIdleSince: new Map<string, number>(),
    }) as SessionRegistry;

    const control = (
      registry as unknown as {
        getAgentControl: () => {
          resume: (opts: { parentSessionId: string; agentId: string }) => Promise<unknown>;
        };
      }
    ).getAgentControl();
    await control.resume({ parentSessionId: "parent-1", agentId: session.id });

    expect(registry.sessionIdleSince.get(session.id)).toBeGreaterThan(0);
    expect(registry.sessionBindings.has(session.id)).toBe(true);
  });

  test("does not restart the idle clock when an already-live child is resumed", async () => {
    const session = makeChildSession("child-live");
    const buildSession = mock(() => {
      throw new Error("live child should not be rebuilt");
    });
    const registry = Object.assign(Object.create(SessionRegistry.prototype), {
      agentControl: null,
      buildSession,
      config: {},
      options: {
        sessionDb: { getSessionRecord: () => null },
        loadAgentPrompt: async () => "",
        taskCoordinator: {
          getForThread: () => null,
          getActiveForSourceSession: () => null,
        },
      },
      sessionBindings: new Map([
        [
          session.id,
          {
            session,
            runtime: { id: session.id },
            sinks: new Map([["connection:child-live", () => {}]]),
          },
        ],
      ]),
      sessionIdleSince: new Map<string, number>([[session.id, 1]]),
    }) as SessionRegistry;

    const control = (
      registry as unknown as {
        getAgentControl: () => {
          resume: (opts: { parentSessionId: string; agentId: string }) => Promise<unknown>;
        };
      }
    ).getAgentControl();
    await control.resume({ parentSessionId: "parent-1", agentId: session.id });

    expect(buildSession).not.toHaveBeenCalled();
    expect(registry.sessionIdleSince.get(session.id)).toBe(1);
  });
});
