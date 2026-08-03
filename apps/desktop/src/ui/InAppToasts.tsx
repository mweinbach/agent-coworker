import { AlertCircleIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppStore } from "../app/store";
import type { Notification } from "../app/types";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { getInlineOperationClaims } from "./OperationFeedback";

const MAX_VISIBLE_TOASTS = 3;
const DEFAULT_AUTO_DISMISS_MS = 6_000;

type ToastRoute = "toast" | "inline";

/**
 * Decides, once, where an outcome is reported.
 *
 * Toasts are the only surface that reaches someone looking elsewhere, so they
 * are spent only on outcomes that have nowhere else to land:
 *
 * - `audience: "background"` — the caller knows the person is not watching.
 * - no `operationKey` — the outcome has no inline home at all.
 * - an operation whose inline `OperationFeedback` is not mounted right now.
 *
 * A failure whose inline surface is on screen is left there, reported once.
 */
function routeFor(notification: Notification): ToastRoute {
  if (notification.audience === "background") return "toast";
  if (!notification.operationKey) return "toast";
  return getInlineOperationClaims().has(notification.operationKey) ? "inline" : "toast";
}

/**
 * Keyboard-dismissible in-app outcomes. Notifications never move focus, while
 * their per-toast live-region semantics announce errors more urgently.
 *
 * Successes clear themselves after a short dwell; failures persist until they
 * are dismissed. Overflow beyond the visible stack is queued rather than
 * discarded, so nothing disappears before it is seen.
 */
export function InAppToasts({
  autoDismissMs = DEFAULT_AUTO_DISMISS_MS,
}: {
  /** Dwell time for transient (non-error) outcomes before they clear themselves. */
  autoDismissMs?: number;
} = {}) {
  const notifications = useAppStore((s) => s.notifications);
  const [dismissedIds, setDismissedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [routes, setRoutes] = useState<ReadonlyMap<string, ToastRoute>>(() => new Map());

  // Passive phase, so inline claims registered during the layout phase of the
  // same commit are already visible. Routing is decided once per notification:
  // a failure delivered inline stays delivered even after that view is closed.
  useEffect(() => {
    setRoutes((previous) => {
      let changed = previous.size !== notifications.length;
      const next = new Map<string, ToastRoute>();
      for (const notification of notifications) {
        const existing = previous.get(notification.id);
        if (existing) {
          next.set(notification.id, existing);
          continue;
        }
        changed = true;
        next.set(notification.id, routeFor(notification));
      }
      return changed ? next : previous;
    });
  }, [notifications]);

  const dismiss = useCallback((id: string) => {
    setDismissedIds((previous) => {
      if (previous.has(id)) return previous;
      const next = new Set(previous);
      next.add(id);
      return next;
    });
  }, []);

  // Oldest first: the stack is a queue, not a window onto the newest few.
  const queued = useMemo(
    () =>
      notifications.filter(
        (notification) =>
          routes.get(notification.id) === "toast" && !dismissedIds.has(notification.id),
      ),
    [dismissedIds, notifications, routes],
  );
  const visible = useMemo(() => queued.slice(0, MAX_VISIBLE_TOASTS), [queued]);
  const waiting = queued.length - visible.length;

  if (visible.length === 0) return null;

  return (
    <section
      className="pointer-events-none fixed bottom-4 right-4 z-[80] flex w-[min(100vw-2rem,22rem)] flex-col gap-2"
      aria-label="Activity notifications"
    >
      {waiting > 0 ? (
        <p
          data-slot="in-app-toast-queue"
          className="self-end rounded-full border app-border-subtle bg-background/95 px-2.5 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur"
        >
          {waiting === 1 ? "1 more waiting" : `${waiting} more waiting`}
        </p>
      ) : null}
      {visible.map((notification) => (
        <InAppToast
          key={notification.id}
          notification={notification}
          onDismiss={dismiss}
          autoDismissMs={autoDismissMs}
        />
      ))}
    </section>
  );
}

function InAppToast({
  notification,
  onDismiss,
  autoDismissMs,
}: {
  notification: Notification;
  onDismiss: (id: string) => void;
  autoDismissMs: number;
}) {
  const isError = notification.kind === "error";
  const [held, setHeld] = useState(false);

  useEffect(() => {
    // Failures are unfinished business; only transient outcomes expire. Pointer
    // and keyboard dwell hold the timer so a toast cannot vanish mid-read.
    if (isError || held) return;
    const timer = setTimeout(() => onDismiss(notification.id), autoDismissMs);
    return () => clearTimeout(timer);
  }, [autoDismissMs, held, isError, notification.id, onDismiss]);

  return (
    <div
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      aria-atomic="true"
      data-slot="in-app-toast"
      data-kind={isError ? "error" : "info"}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocusCapture={() => setHeld(true)}
      onBlurCapture={() => setHeld(false)}
      className={cn(
        "pointer-events-auto flex items-start gap-2 rounded-lg border backdrop-blur",
        isError
          ? "border-destructive/50 bg-destructive/10 p-3.5 shadow-xl ring-1 ring-destructive/15"
          : "app-border-subtle bg-background/95 p-2.5 shadow-md",
      )}
    >
      {isError ? (
        <AlertCircleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
      ) : null}
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "leading-snug",
            isError
              ? "text-sm font-semibold text-destructive"
              : "text-xs font-medium text-foreground",
          )}
        >
          {notification.title}
        </div>
        {notification.detail ? (
          <div
            className={cn(
              "mt-1 whitespace-pre-wrap break-words text-xs leading-snug text-muted-foreground",
              isError ? undefined : "line-clamp-2",
            )}
          >
            {notification.detail}
          </div>
        ) : null}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="shrink-0"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(notification.id)}
      >
        <XIcon />
      </Button>
    </div>
  );
}
