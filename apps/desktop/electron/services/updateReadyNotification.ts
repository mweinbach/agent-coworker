/**
 * Keeps the update-ready Notification referenced until the user handles it.
 * A timed-out Windows toast stays clickable from Action Center, so `timedOut`
 * closes keep the reference, and closing a replaced toast leaves the newer one.
 */
export function createUpdateReadyNotificationHold<T extends object>() {
  let current: T | null = null;
  return {
    hold(notification: T): void {
      current = notification;
    },
    release(notification: T, reason?: string): void {
      if (reason !== "timedOut" && current === notification) current = null;
    },
    held: (): T | null => current,
  };
}
