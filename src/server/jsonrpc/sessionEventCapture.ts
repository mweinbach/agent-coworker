import type { SessionEvent } from "../protocol";
import type { SessionBinding } from "../startServer/types";

type BindingSink = (event: SessionEvent) => void;

type SessionEventCaptureDeps = {
  addBindingSink: (binding: SessionBinding, sinkId: string, sink: BindingSink) => void;
  removeBindingSink: (binding: SessionBinding, sinkId: string) => void;
  createSinkId?: () => string;
};

export function createSessionEventCapture({
  addBindingSink,
  removeBindingSink,
  createSinkId = () => `capture:${crypto.randomUUID()}`,
}: SessionEventCaptureDeps) {
  const capture = async <T extends SessionEvent>(
    binding: SessionBinding,
    action: () => Promise<void> | void,
    predicate: (event: SessionEvent) => event is T,
    timeoutMs = 5_000,
  ): Promise<T> => {
    const sinkId = createSinkId();
    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        removeBindingSink(binding, sinkId);
        reject(new Error("Timed out waiting for control event"));
      }, timeoutMs);

      addBindingSink(binding, sinkId, (event) => {
        if (!predicate(event)) return;
        clearTimeout(timeout);
        removeBindingSink(binding, sinkId);
        resolve(event);
      });

      void Promise.resolve(action()).catch((error) => {
        clearTimeout(timeout);
        removeBindingSink(binding, sinkId);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  };

  const captureMutationOutcome = async <T extends SessionEvent>(
    binding: SessionBinding,
    action: () => Promise<void> | void,
    predicate: (event: SessionEvent) => event is T,
    timeoutMs = 5_000,
    idleMs = 25,
  ): Promise<T | null> => {
    const sinkId = createSinkId();
    return await new Promise<T | null>((resolve, reject) => {
      let actionResolved = false;
      let settled = false;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;

      const settle = (value: T | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (idleTimer) {
          clearTimeout(idleTimer);
        }
        removeBindingSink(binding, sinkId);
        resolve(value);
      };

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (idleTimer) {
          clearTimeout(idleTimer);
        }
        removeBindingSink(binding, sinkId);
        reject(new Error("Timed out waiting for control event"));
      }, timeoutMs);

      addBindingSink(binding, sinkId, (event) => {
        if (!predicate(event)) return;
        settle(event);
      });

      void Promise.resolve(action())
        .then(() => {
          actionResolved = true;
          idleTimer = setTimeout(() => {
            if (actionResolved) {
              settle(null);
            }
          }, idleMs);
        })
        .catch((error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (idleTimer) {
            clearTimeout(idleTimer);
          }
          removeBindingSink(binding, sinkId);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  };

  const captureMutationEvents = async <T extends SessionEvent>(
    binding: SessionBinding,
    action: () => Promise<void> | void,
    predicate: (event: SessionEvent) => event is T,
    timeoutMs = 5_000,
    idleMs = 25,
  ): Promise<T[]> => {
    const sinkId = createSinkId();
    return await new Promise<T[]>((resolve, reject) => {
      let actionResolved = false;
      let settled = false;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      const events: T[] = [];

      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (idleTimer) {
          clearTimeout(idleTimer);
        }
        removeBindingSink(binding, sinkId);
        resolve(events);
      };

      const scheduleIdleSettle = () => {
        if (!actionResolved || settled) {
          return;
        }
        if (idleTimer) {
          clearTimeout(idleTimer);
        }
        idleTimer = setTimeout(() => {
          settle();
        }, idleMs);
      };

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (idleTimer) {
          clearTimeout(idleTimer);
        }
        removeBindingSink(binding, sinkId);
        reject(new Error("Timed out waiting for control event"));
      }, timeoutMs);

      addBindingSink(binding, sinkId, (event) => {
        if (!predicate(event)) return;
        events.push(event);
        scheduleIdleSettle();
      });

      void Promise.resolve(action())
        .then(() => {
          actionResolved = true;
          scheduleIdleSettle();
        })
        .catch((error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (idleTimer) {
            clearTimeout(idleTimer);
          }
          removeBindingSink(binding, sinkId);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  };

  return {
    capture,
    captureMutationOutcome,
    captureMutationEvents,
  };
}
