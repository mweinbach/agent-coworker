export function enqueueThreadJournalWrite(
  queues: Map<string, Promise<void>>,
  threadId: string,
  write: () => Promise<void>,
): Promise<void> {
  const priorTail = queues.get(threadId);
  const writePromise = (priorTail ?? Promise.resolve())
    .catch(() => {
      // Swallow prior failures so later journal writes can continue.
    })
    .then(write);

  let tailPromise: Promise<void>;
  tailPromise = writePromise.finally(() => {
    if (queues.get(threadId) === tailPromise) {
      queues.delete(threadId);
    }
  });

  void tailPromise.catch(() => {
    // Callers observe failures via the returned write promise or waitForIdle().
  });
  queues.set(threadId, tailPromise);
  return writePromise;
}

export async function waitForThreadJournalWriteQueueIdle(
  queues: Map<string, Promise<void>>,
  threadId: string,
): Promise<void> {
  await (queues.get(threadId) ?? Promise.resolve()).catch(() => {
    // Journal persistence remains best-effort only.
  });
}
