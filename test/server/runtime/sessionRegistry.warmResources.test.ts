import { describe, expect, mock, test } from "bun:test";

import { SessionRegistry } from "../../../src/server/runtime/SessionRegistry";

function makeBuiltSession(id: string) {
  const warmSessionResources = mock(() => {});
  const session = { id, warmSessionResources };
  const runtime = { id };
  return { warmSessionResources, built: { session, runtime, isResume: false } };
}

describe("SessionRegistry first-turn resource warming", () => {
  test("createJsonRpcThreadSession warms session resources in the background", () => {
    const { warmSessionResources, built } = makeBuiltSession("thread-1");
    const registry = {
      config: { workingDirectory: "/tmp/base" },
      buildSession: () => built,
      options: { threadJournal: { ensureSink: () => {} } },
      sessionBindings: new Map(),
    } as unknown as SessionRegistry;

    const runtime = SessionRegistry.prototype.createJsonRpcThreadSession.call(
      registry,
      "/tmp/workspace",
    );

    expect(runtime.id).toBe("thread-1");
    expect(warmSessionResources).toHaveBeenCalledTimes(1);
  });

  test("loadThreadBinding warms resources when building a cold binding", () => {
    const { warmSessionResources, built } = makeBuiltSession("thread-2");
    const registry = {
      buildSession: () => built,
      options: {
        threadJournal: { ensureSink: () => {} },
        sessionDb: { getSessionRecord: () => ({ sessionId: "thread-2" }) },
      },
      sessionBindings: new Map(),
    } as unknown as SessionRegistry;

    const binding = SessionRegistry.prototype.loadThreadBinding.call(registry, "thread-2");

    expect(binding?.session).toBe(built.session as never);
    expect(warmSessionResources).toHaveBeenCalledTimes(1);
  });

  test("loadThreadBinding does not re-warm an already-live binding", () => {
    const { warmSessionResources, built } = makeBuiltSession("thread-3");
    const liveBinding = { session: built.session, runtime: built.runtime, sinks: new Map() };
    const registry = {
      buildSession: () => {
        throw new Error("should not rebuild a live binding");
      },
      options: { threadJournal: { ensureSink: () => {} } },
      sessionBindings: new Map([["thread-3", liveBinding]]),
    } as unknown as SessionRegistry;

    const binding = SessionRegistry.prototype.loadThreadBinding.call(registry, "thread-3");

    expect(binding).toBe(liveBinding as never);
    expect(warmSessionResources).not.toHaveBeenCalled();
  });

  test("createJsonRpcThreadSession skips warming while startup readiness is pending", () => {
    const { warmSessionResources, built } = makeBuiltSession("thread-pending");
    const registry = {
      config: { workingDirectory: "/tmp/base" },
      buildSession: () => built,
      options: {
        shouldWarmSessionResources: () => false,
        threadJournal: { ensureSink: () => {} },
      },
      sessionBindings: new Map(),
    } as unknown as SessionRegistry;

    const runtime = SessionRegistry.prototype.createJsonRpcThreadSession.call(
      registry,
      "/tmp/workspace",
    );

    expect(runtime.id).toBe("thread-pending");
    expect(warmSessionResources).not.toHaveBeenCalled();
  });

  test("loadThreadBinding skips warming a cold binding while startup readiness is pending", () => {
    const { warmSessionResources, built } = makeBuiltSession("thread-resume-pending");
    const registry = {
      buildSession: () => built,
      options: {
        shouldWarmSessionResources: () => false,
        threadJournal: { ensureSink: () => {} },
        sessionDb: { getSessionRecord: () => ({ sessionId: "thread-resume-pending" }) },
      },
      sessionBindings: new Map(),
    } as unknown as SessionRegistry;

    const binding = SessionRegistry.prototype.loadThreadBinding.call(
      registry,
      "thread-resume-pending",
    );

    expect(binding?.session).toBe(built.session as never);
    expect(warmSessionResources).not.toHaveBeenCalled();
  });

  test("warmLiveSessionResources warms every live session after startup readiness completes", () => {
    const first = makeBuiltSession("thread-live-1");
    const second = makeBuiltSession("thread-live-2");
    const registry = {
      sessionBindings: new Map([
        [
          "thread-live-1",
          { session: first.built.session, runtime: first.built.runtime, sinks: new Map() },
        ],
        [
          "thread-live-2",
          { session: second.built.session, runtime: second.built.runtime, sinks: new Map() },
        ],
        ["thread-empty", { session: null, runtime: null, sinks: new Map() }],
      ]),
    } as unknown as SessionRegistry;

    SessionRegistry.prototype.warmLiveSessionResources.call(registry);

    expect(first.warmSessionResources).toHaveBeenCalledTimes(1);
    expect(second.warmSessionResources).toHaveBeenCalledTimes(1);
  });
});
