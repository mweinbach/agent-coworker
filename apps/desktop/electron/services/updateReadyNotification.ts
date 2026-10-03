/**
 * Keeps the update-ready Notification referenced until the user handles it.
 * A garbage-collected Notification stops delivering click and action events.
 * A timed-out Windows toast stays clickable from Action Center, so that close
 * keeps the reference. Replacing the toast must not drop the newer one when
 * the older toast later closes.
 */
export function createUpdateReadyNotificationHold<T extends object>() {
  let current: T | null = null;

  function release(notification: T): void {
    if (current === notification) current = null;
  }

  return {
    hold(notification: T): void {
      current = notification;
    },
    release,
    releaseUnlessTimedOut(notification: T, reason: string | undefined): void {
      if (reason === "timedOut") return;
      release(notification);
    },
    held(): T | null {
      return current;
    },
  };
}
