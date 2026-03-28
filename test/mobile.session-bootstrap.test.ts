import { describe, expect, test } from "bun:test";

import { createSessionBootstrapController } from "../apps/mobile/src/features/cowork/sessionBootstrap";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}

describe("mobile session bootstrap controller", () => {
  test("retries session bootstrap after a transient initialize failure", async () => {
    let initializeAttempts = 0;
    let requestThreadListCalls = 0;
    let hydrateWorkspaceContextCalls = 0;
    let resetTransportSessionCalls = 0;
    let clearThreadsCalls = 0;
    let clearWorkspaceBoundStoresCalls = 0;
    let getTransportSnapshotCalls = 0;

    const controller = createSessionBootstrapController({
      client: {
        async initialize() {
          initializeAttempts += 1;
          if (initializeAttempts === 1) {
            throw new Error("transient initialize failure");
          }
        },
        resetTransportSession() {
          resetTransportSessionCalls += 1;
        },
      },
      clearThreads() {
        clearThreadsCalls += 1;
      },
      clearWorkspaceBoundStores() {
        clearWorkspaceBoundStoresCalls += 1;
      },
      async hydrateRemoteThreads() {
        requestThreadListCalls += 1;
      },
      async hydrateWorkspaceContext() {
        hydrateWorkspaceContextCalls += 1;
      },
      async getTransportSnapshot() {
        getTransportSnapshotCalls += 1;
        return {
          status: "connected",
          transportMode: "native",
        };
      },
      isTransportReady(snapshot) {
        return snapshot.status === "connected" && snapshot.transportMode === "native";
      },
      retryDelayMs: 20,
    });

    await controller.ensureConnectedSession();

    await waitForCondition(() => initializeAttempts >= 2);
    await waitForCondition(() => requestThreadListCalls === 1);
    await waitForCondition(() => hydrateWorkspaceContextCalls === 1);

    expect(initializeAttempts).toBe(2);
    expect(requestThreadListCalls).toBe(1);
    expect(hydrateWorkspaceContextCalls).toBe(1);
    expect(getTransportSnapshotCalls).toBe(1);
    expect(resetTransportSessionCalls).toBe(0);
    expect(clearThreadsCalls).toBe(0);
    expect(clearWorkspaceBoundStoresCalls).toBe(0);

    controller.dispose();
  });

  test("ignores stale bootstrap completion after a reset during hydration", async () => {
    let initializeAttempts = 0;
    let hydrateRemoteThreadsCalls = 0;
    let hydrateWorkspaceContextCalls = 0;
    let resetTransportSessionCalls = 0;
    let clearThreadsCalls = 0;
    let clearWorkspaceBoundStoresCalls = 0;

    const secondInitialize = createDeferred<void>();
    const firstHydrateRemoteThreads = createDeferred<void>();
    const secondHydrateRemoteThreads = createDeferred<void>();

    const controller = createSessionBootstrapController({
      client: {
        async initialize() {
          initializeAttempts += 1;
          if (initializeAttempts === 2) {
            await secondInitialize.promise;
          }
        },
        resetTransportSession() {
          resetTransportSessionCalls += 1;
        },
      },
      clearThreads() {
        clearThreadsCalls += 1;
      },
      clearWorkspaceBoundStores() {
        clearWorkspaceBoundStoresCalls += 1;
      },
      async hydrateRemoteThreads() {
        hydrateRemoteThreadsCalls += 1;
        if (hydrateRemoteThreadsCalls === 1) {
          await firstHydrateRemoteThreads.promise;
          return;
        }
        await secondHydrateRemoteThreads.promise;
      },
      async hydrateWorkspaceContext() {
        hydrateWorkspaceContextCalls += 1;
      },
      async getTransportSnapshot() {
        return {
          status: "connected",
          transportMode: "native",
        };
      },
      isTransportReady(snapshot) {
        return snapshot.status === "connected" && snapshot.transportMode === "native";
      },
      retryDelayMs: 20,
    });

    void controller.ensureConnectedSession();
    await waitForCondition(() => hydrateRemoteThreadsCalls === 1);

    controller.resetClientSession();
    void controller.ensureConnectedSession();
    await waitForCondition(() => initializeAttempts === 2);

    firstHydrateRemoteThreads.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(hydrateWorkspaceContextCalls).toBe(0);

    secondInitialize.resolve();
    await waitForCondition(() => hydrateRemoteThreadsCalls === 2);
    secondHydrateRemoteThreads.resolve();
    await waitForCondition(() => hydrateWorkspaceContextCalls === 1);

    expect(initializeAttempts).toBe(2);
    expect(hydrateRemoteThreadsCalls).toBe(2);
    expect(hydrateWorkspaceContextCalls).toBe(1);
    expect(resetTransportSessionCalls).toBe(1);
    expect(clearThreadsCalls).toBe(1);
    expect(clearWorkspaceBoundStoresCalls).toBe(1);

    controller.dispose();
  });
});
