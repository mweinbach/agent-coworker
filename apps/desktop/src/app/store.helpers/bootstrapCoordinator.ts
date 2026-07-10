export type BootstrapRunContext = {
  isCurrent: () => boolean;
  signal: AbortSignal;
  waitUntil: (operation: Promise<unknown>) => void;
};

export type BootstrapCoordinator = {
  run: (task: (context: BootstrapRunContext) => Promise<void>) => Promise<void>;
  invalidate: () => void;
  drain: () => Promise<void>;
};

export function createBootstrapCoordinator(): BootstrapCoordinator {
  let generation = 0;
  let inFlight: Promise<void> | null = null;
  let activeController: AbortController | null = null;
  let idlePromise: Promise<void> | null = null;

  return {
    run(task) {
      if (inFlight) {
        return inFlight;
      }

      const runGeneration = ++generation;
      const controller = new AbortController();
      const ownedOperations: Promise<unknown>[] = [];
      let resolvePromise: () => void = () => {};
      let rejectPromise: (reason?: unknown) => void = () => {};
      const promise = new Promise<void>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      });
      inFlight = promise;
      activeController = controller;
      let resolveIdle: () => void = () => {};
      const ownershipPromise = new Promise<void>((resolve) => {
        resolveIdle = resolve;
      });
      idlePromise = ownershipPromise;

      const release = () => {
        if (inFlight === promise) {
          inFlight = null;
        }
        if (activeController === controller) {
          activeController = null;
        }
        if (idlePromise === ownershipPromise) {
          idlePromise = null;
        }
        resolveIdle();
      };
      const settleOwnership = () => {
        if (ownedOperations.length === 0) {
          release();
          return;
        }
        void Promise.allSettled(ownedOperations).then(release);
      };

      try {
        const taskPromise = task({
          isCurrent: () => generation === runGeneration && !controller.signal.aborted,
          signal: controller.signal,
          waitUntil: (operation) => {
            ownedOperations.push(operation);
          },
        });
        void taskPromise.then(
          () => {
            settleOwnership();
            resolvePromise();
          },
          (error) => {
            settleOwnership();
            rejectPromise(error);
          },
        );
      } catch (error) {
        settleOwnership();
        rejectPromise(error);
      }

      return promise;
    },
    invalidate() {
      generation += 1;
      activeController?.abort();
    },
    async drain() {
      while (idlePromise) {
        await idlePromise;
      }
    },
  };
}
