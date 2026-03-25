const globalKey = "__coworkProcessTestLocks";

function getLockRegistry(): Map<string, Promise<void>> {
  const globalState = globalThis as typeof globalThis & {
    [globalKey]?: Map<string, Promise<void>>;
  };
  if (!globalState[globalKey]) {
    globalState[globalKey] = new Map<string, Promise<void>>();
  }
  return globalState[globalKey]!;
}

export async function withGlobalTestLock<T>(
  name: string,
  run: () => Promise<T>,
): Promise<T> {
  const registry = getLockRegistry();
  const previous = registry.get(name) ?? Promise.resolve();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => pending);
  registry.set(name, queued);

  await previous;
  try {
    return await run();
  } finally {
    release();
    if (registry.get(name) === queued) {
      registry.delete(name);
    }
  }
}
