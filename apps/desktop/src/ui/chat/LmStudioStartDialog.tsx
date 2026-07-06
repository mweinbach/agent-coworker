import { Loader2 } from "lucide-react";
import { useAppStore } from "../../app/store";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { openExternalSource } from "../../lib/openExternalSource";

const LM_STUDIO_DOWNLOAD_URL = "https://lmstudio.ai";

export function LmStudioStartDialog() {
  const modal = useAppStore((s) => s.lmStudioStartModal);
  const startLmStudioServerAndRetry = useAppStore((s) => s.startLmStudioServerAndRetry);
  const dismissLmStudioStartModal = useAppStore((s) => s.dismissLmStudioStartModal);

  if (!modal) return null;

  const starting = modal.phase === "starting";
  const failed = modal.phase === "failed";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !starting) dismissLmStudioStartModal();
      }}
    >
      <DialogContent showCloseButton={!starting} className="max-w-md">
        <DialogHeader>
          <DialogTitle>LM Studio isn&apos;t running</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {modal.canAutoStart ? (
            <p className="text-sm text-muted-foreground">
              Your message needs the local LM Studio server at{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">{modal.baseUrl}</code>, but it
              isn&apos;t responding. Start it and your message will be sent automatically.
            </p>
          ) : modal.installed ? (
            <p className="text-sm text-muted-foreground">
              This chat is configured to use an LM Studio server at{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">{modal.baseUrl}</code>, which
              isn&apos;t reachable. Because it isn&apos;t a local server, it can&apos;t be started
              from here — make sure it is running, then resend your message.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              This chat uses the LM Studio provider, but LM Studio doesn&apos;t appear to be
              installed on this machine. Install it, load a model, and resend your message.
            </p>
          )}
          {failed && modal.errorDetail ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
              {modal.errorDetail}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={starting}
              onClick={() => dismissLmStudioStartModal()}
            >
              Cancel
            </Button>
            {modal.canAutoStart ? (
              <Button
                type="button"
                disabled={starting}
                onClick={() => void startLmStudioServerAndRetry()}
              >
                {starting ? (
                  <>
                    <Loader2 data-icon className="animate-spin" />
                    Starting…
                  </>
                ) : failed ? (
                  "Retry"
                ) : (
                  "Start LM Studio"
                )}
              </Button>
            ) : !modal.installed ? (
              <Button type="button" onClick={() => void openExternalSource(LM_STUDIO_DOWNLOAD_URL)}>
                Get LM Studio
              </Button>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
