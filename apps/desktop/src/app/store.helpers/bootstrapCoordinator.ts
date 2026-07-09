export type BootstrapRunContext = {
  isCurrent: () => boolean;
};

export type BootstrapCoordinator = {
  run: (task: (context: BootstrapRunContext) => Promise<void>) => Promise<void>;
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
      const promise = (async () => {
        await task({
          isCurrent: () => generation === runGeneration,
        });
      })();
      inFlight = promise;

      const release = () => {
        if (inFlight === promise) {
          inFlight = null;
        }
      };
      void promise.then(release, release);

      return promise;
    },
  };
}
