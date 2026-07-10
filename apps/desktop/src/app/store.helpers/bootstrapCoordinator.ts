export type BootstrapRunContext = {
  isCurrent: () => boolean;
  waitUntil: (operation: Promise<unknown>) => void;
};

export type BootstrapCoordinator = {
  run: (task: (context: BootstrapRunContext) => Promise<void>) => Promise<void>;
  invalidate: () => void;
};

export function createBootstrapCoordinator(): BootstrapCoordinator {
  let generation = 0;
  let inFlight: Promise<void> | null = null;

  return {
    run(task) {
      if (inFlight) {
        return inFlight;
      }

      const runGeneration = ++generation;
      const ownedOperations: Promise<unknown>[] = [];
      let resolvePromise: () => void = () => {};
      let rejectPromise: (reason?: unknown) => void = () => {};
      const promise = new Promise<void>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      });
      inFlight = promise;

      const release = () => {
        if (inFlight === promise) {
          inFlight = null;
        }
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
          isCurrent: () => generation === runGeneration,
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
        release();
        rejectPromise(error);
      }

      return promise;
    },
    invalidate() {
      generation += 1;
    },
  };
}
