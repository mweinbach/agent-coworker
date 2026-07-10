import { describe, expect, test } from "bun:test";

import { createBootstrapCoordinator } from "../src/app/store.helpers/bootstrapCoordinator";

function createDeferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("bootstrap coordinator", () => {
  test("returns the same promise to concurrent callers", async () => {
    const coordinator = createBootstrapCoordinator();
    const deferred = createDeferred<void>();
    let runs = 0;
    const task = async () => {
      runs += 1;
      await deferred.promise;
    };

    const first = coordinator.run(task);
    const second = coordinator.run(task);

    expect(second).toBe(first);
    expect(runs).toBe(1);

    deferred.resolve();
    await first;
  });

  test("retains generation ownership until deferred follow-up work settles", async () => {
    const coordinator = createBootstrapCoordinator();
    const followUp = createDeferred<void>();
    let runs = 0;

    const first = coordinator.run(async ({ waitUntil }) => {
      runs += 1;
      waitUntil(followUp.promise);
    });
    await first;

    expect(coordinator.run(async () => {})).toBe(first);
    expect(runs).toBe(1);

    followUp.resolve();
    await coordinator.drain();

    const second = coordinator.run(async () => {
      runs += 1;
    });
    expect(second).not.toBe(first);
    await second;
    expect(runs).toBe(2);
  });

  test("drains all work owned by the current generation", async () => {
    const coordinator = createBootstrapCoordinator();
    const followUp = createDeferred<void>();
    let drained = false;

    const run = coordinator.run(async ({ waitUntil }) => {
      waitUntil(followUp.promise);
    });
    const drain = coordinator.drain().then(() => {
      drained = true;
    });

    await run;
    expect(drained).toBe(false);

    followUp.resolve();
    await drain;
    expect(drained).toBe(true);
  });

  test("publishes the in-flight promise before task side effects can reenter", async () => {
    const coordinator = createBootstrapCoordinator();
    let reentrant: Promise<void> | null = null;
    let runs = 0;

    const first = coordinator.run(async () => {
      runs += 1;
      reentrant = coordinator.run(async () => {
        runs += 1;
      });
    });

    expect(reentrant).toBe(first);
    await first;
    expect(runs).toBe(1);
  });

  test("starts a fresh generation after a failed run settles", async () => {
    const coordinator = createBootstrapCoordinator();
    const expected = new Error("bootstrap failed");
    const failed = coordinator.run(async () => {
      throw expected;
    });

    await expect(failed).rejects.toBe(expected);

    let retried = false;
    const retry = coordinator.run(async () => {
      retried = true;
    });
    expect(retry).not.toBe(failed);
    await retry;
    expect(retried).toBe(true);
  });

  test("invalidation makes a deferred generation stale before it can write", async () => {
    const coordinator = createBootstrapCoordinator();
    const deferred = createDeferred<void>();
    let value = "initial";

    const first = coordinator.run(async ({ isCurrent }) => {
      await deferred.promise;
      if (isCurrent()) {
        value = "first";
      }
    });

    coordinator.invalidate();
    deferred.resolve();
    await first;

    expect(value).toBe("initial");

    await coordinator.run(async ({ isCurrent }) => {
      if (isCurrent()) {
        value = "second";
      }
    });
    expect(value).toBe("second");
  });

  test("invalidation aborts the active generation signal", async () => {
    const coordinator = createBootstrapCoordinator();
    const deferred = createDeferred<void>();
    let signal: AbortSignal | null = null;

    const run = coordinator.run(async (context) => {
      signal = context.signal;
      await deferred.promise;
    });

    expect(signal?.aborted).toBe(false);
    coordinator.invalidate();
    expect(signal?.aborted).toBe(true);

    deferred.resolve();
    await run;
  });

  test("rejects deferred writes from an older generation", async () => {
    const coordinator = createBootstrapCoordinator();
    let applyFirstGeneration = () => {};
    let value = "initial";

    await coordinator.run(async ({ isCurrent }) => {
      applyFirstGeneration = () => {
        if (isCurrent()) {
          value = "first";
        }
      };
    });
    await coordinator.run(async ({ isCurrent }) => {
      if (isCurrent()) {
        value = "second";
      }
    });

    applyFirstGeneration();
    expect(value).toBe("second");
  });
});
