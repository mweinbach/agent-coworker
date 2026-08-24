import { describe, expect, mock, test } from "bun:test";

import { createForegroundRecoveryController } from "../apps/mobile/src/features/relay/foregroundRecovery";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("mobile foreground recovery", () => {
  test("refreshes the desktop event stream when the app returns from the background", async () => {
    const recover = mock(async () => {});
    const controller = createForegroundRecoveryController({
      initialState: "active",
      recover,
    });

    await controller.handleAppStateChange("background");
    await controller.handleAppStateChange("active");
    await controller.handleAppStateChange("active");

    expect(recover).toHaveBeenCalledTimes(1);
  });

  test("coalesces overlapping foreground transitions into one recovery", async () => {
    const deferred = createDeferred<void>();
    const recover = mock(async () => await deferred.promise);
    const controller = createForegroundRecoveryController({
      initialState: "inactive",
      recover,
    });

    const first = controller.handleAppStateChange("active");
    await controller.handleAppStateChange("background");
    const second = controller.handleAppStateChange("active");

    expect(recover).toHaveBeenCalledTimes(1);

    deferred.resolve();
    await Promise.all([first, second]);

    expect(recover).toHaveBeenCalledTimes(1);
  });

  test("does not revive the transport after the app provider is disposed", async () => {
    const recover = mock(async () => {});
    const controller = createForegroundRecoveryController({
      initialState: "background",
      recover,
    });

    controller.dispose();
    await controller.handleAppStateChange("active");

    expect(recover).not.toHaveBeenCalled();
  });
});
