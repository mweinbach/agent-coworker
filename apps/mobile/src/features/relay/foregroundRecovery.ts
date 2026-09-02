type ForegroundRecoveryControllerOptions = {
  initialState: string | null;
  recover: () => Promise<unknown>;
};

export function createForegroundRecoveryController(options: ForegroundRecoveryControllerOptions) {
  let currentState = options.initialState;
  let disposed = false;
  let recoveryInFlight: Promise<void> | null = null;

  const handleAppStateChange = (nextState: string): Promise<void> => {
    const previousState = currentState;
    currentState = nextState;

    if (disposed || nextState !== "active" || previousState === "active") {
      return Promise.resolve();
    }
    if (recoveryInFlight) {
      return recoveryInFlight;
    }

    recoveryInFlight = options
      .recover()
      .then(() => {})
      .finally(() => {
        recoveryInFlight = null;
      });
    return recoveryInFlight;
  };

  return {
    handleAppStateChange,
    dispose() {
      disposed = true;
    },
  };
}
