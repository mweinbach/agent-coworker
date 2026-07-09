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
