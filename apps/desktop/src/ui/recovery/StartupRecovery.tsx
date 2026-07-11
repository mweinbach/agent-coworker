import { AlertTriangleIcon, RotateCwIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";
import { cn } from "../../lib/utils";
import { RecoveryDiagnosticsActions } from "./RecoveryDiagnosticsActions";

export function StartupRecovery({
  detail,
  init,
  retrying,
  presentation,
}: {
  detail: string;
  init: () => Promise<void>;
  retrying: boolean;
  presentation: "banner" | "page";
}) {
  const compact = presentation === "banner";
  return (
    <div
      role="alert"
      data-slot="startup-recovery"
      className={cn(
        "text-foreground",
        compact
          ? "flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2.5"
          : "flex h-full flex-col items-center justify-center bg-panel px-6 py-10",
      )}
    >
      <div
        className={cn(
          "min-w-0",
          compact
            ? "flex flex-1 items-center gap-3"
            : "flex w-full max-w-xl flex-col items-start gap-4 rounded-xl border border-destructive/30 bg-background/90 p-6 shadow-sm",
        )}
      >
        <div
          className={cn(
            "flex shrink-0 items-center justify-center rounded-lg bg-destructive/12 text-destructive",
            compact ? "size-8" : "size-10",
          )}
          aria-hidden="true"
        >
          <AlertTriangleIcon className={compact ? "size-4" : "size-5"} />
        </div>
        <div className="min-w-0 flex-1">
          <div className={cn("font-semibold", compact ? "text-sm" : "text-xl")}>
            Cowork couldn&apos;t start
          </div>
          <div
            data-selectable="text"
            className={cn(
              "mt-1 text-muted-foreground",
              compact ? "line-clamp-2 text-xs" : "text-sm",
            )}
          >
            {detail}
          </div>
          {!compact ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Your saved chats and drafts remain on this device.
            </p>
          ) : null}
        </div>
      </div>
      <div className={cn("flex flex-wrap items-start gap-2", compact ? "" : "mt-4")}>
        <Button
          type="button"
          size={compact ? "sm" : "default"}
          disabled={retrying}
          onClick={() => void init()}
        >
          {retrying ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <RotateCwIcon data-icon="inline-start" />
          )}
          {retrying ? "Retrying…" : "Retry"}
        </Button>
        <RecoveryDiagnosticsActions compact={compact} />
      </div>
    </div>
  );
}
