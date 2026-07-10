import { XIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useAppStore } from "../app/store";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";

const MAX_VISIBLE_TOASTS = 3;

/**
 * Lightweight in-app toast stack for store notifications. The main window also
 * mirrors these to OS notices; this surface keeps them dismissible inside the app.
 */
export function InAppToasts() {
  const notifications = useAppStore((s) => s.notifications);
  const [dismissedIds, setDismissedIds] = useState<ReadonlySet<string>>(() => new Set());

  const visible = useMemo(() => {
    const active = notifications.filter((n) => !dismissedIds.has(n.id));
    return active.slice(-MAX_VISIBLE_TOASTS).reverse();
  }, [dismissedIds, notifications]);

  const dismiss = useCallback((id: string) => {
    setDismissedIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  if (visible.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[80] flex w-[min(100vw-2rem,22rem)] flex-col gap-2"
      aria-live="polite"
      aria-relevant="additions"
    >
      {visible.map((notification) => (
        <div
          key={notification.id}
          role="status"
          data-slot="in-app-toast"
          className={cn(
            "pointer-events-auto flex items-start gap-2 rounded-lg border bg-background/95 p-3 text-sm shadow-lg backdrop-blur",
            notification.kind === "error"
              ? "border-destructive/40 bg-destructive/10"
              : "border-border/70",
          )}
        >
          <div className="min-w-0 flex-1">
            <div
              className={cn(
                "font-medium leading-snug",
                notification.kind === "error" ? "text-destructive" : "text-foreground",
              )}
            >
              {notification.title}
            </div>
            {notification.detail ? (
              <div className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-snug text-muted-foreground">
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
            onClick={() => dismiss(notification.id)}
          >
            <XIcon />
          </Button>
        </div>
      ))}
    </div>
  );
}
