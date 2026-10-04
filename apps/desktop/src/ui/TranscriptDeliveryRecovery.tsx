import { AlertTriangle, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { TranscriptDeliveryFailure } from "@/lib/desktopApi";
import {
  discardTranscriptBatch,
  onTranscriptDeliveryFailure,
  retryTranscriptDelivery,
} from "@/lib/desktopCommands";

function failureKey(failure: TranscriptDeliveryFailure): string {
  return failure.recoveryId ?? failure.batchId ?? `${failure.reason}:${failure.message}`;
}

export function TranscriptDeliveryRecovery() {
  const [failures, setFailures] = useState<TranscriptDeliveryFailure[]>([]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<{ key: string; message: string } | null>(null);

  useEffect(
    () =>
      onTranscriptDeliveryFailure((failure) => {
        const key = failureKey(failure);
        setFailures((current) =>
          [...current.filter((candidate) => failureKey(candidate) !== key), failure].slice(-64),
        );
      }),
    [],
  );

  const failure = failures.at(-1) ?? null;
  if (!failure) {
    return null;
  }

  const currentKey = failureKey(failure);
  const actionId = failure.recoveryId ?? failure.batchId ?? undefined;
  const currentError = actionError?.key === currentKey ? actionError.message : null;

  const runAction = async (
    task: () => Promise<unknown>,
    fallbackMessage: string,
  ): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      await task();
      setFailures((current) => current.filter((candidate) => failureKey(candidate) !== currentKey));
    } catch (error) {
      setActionError({
        key: currentKey,
        message: error instanceof Error ? error.message : fallbackMessage,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="fixed right-4 bottom-4 w-[min(28rem,calc(100vw-2rem))] gap-4 py-4 shadow-lg">
      <CardHeader className="gap-1 px-4">
        <CardTitle className="flex items-center gap-2 text-sm">
          <AlertTriangle className="size-4" aria-hidden="true" />
          Transcript sync needs attention
        </CardTitle>
        <CardDescription>
          {failure.message}
          {currentError ? ` ${currentError}` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex justify-end gap-2 px-4">
        {failure.canDiscard && actionId ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() =>
              void runAction(
                () => discardTranscriptBatch(actionId),
                "Unable to discard transcript delivery",
              )
            }
          >
            <Trash2 data-icon="inline-start" />
            Discard
          </Button>
        ) : null}
        {failure.canRetry ? (
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              void runAction(
                () => retryTranscriptDelivery(actionId),
                "Unable to retry transcript delivery",
              )
            }
          >
            <RotateCcw data-icon="inline-start" />
            Retry
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
