import { AlertTriangle, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { TranscriptDeliveryFailure } from "@/lib/desktopApi";
import {
  appendTranscriptBatch,
  discardTranscriptBatch,
  onTranscriptDeliveryFailure,
  retryTranscriptDelivery,
} from "@/lib/desktopCommands";

function failureKey(failure: TranscriptDeliveryFailure): string {
  return failure.batchId ?? `${failure.reason}:${failure.message}`;
}

export function TranscriptDeliveryRecovery() {
  const [failures, setFailures] = useState<TranscriptDeliveryFailure[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(
    () =>
      onTranscriptDeliveryFailure((failure) => {
        const key = failureKey(failure);
        setFailures((current) => [
          ...current.filter((candidate) => failureKey(candidate) !== key),
          failure,
        ]);
      }),
    [],
  );

  const failure = failures.at(-1) ?? null;
  if (!failure) {
    return null;
  }

  const removeCurrent = (): void => {
    const key = failureKey(failure);
    setFailures((current) => current.filter((candidate) => failureKey(candidate) !== key));
  };

  const retry = async (): Promise<void> => {
    setBusy(true);
    try {
      if (failure.batchId) {
        await retryTranscriptDelivery(failure.batchId);
      } else if (failure.recoverableEvents?.length) {
        await appendTranscriptBatch(failure.recoverableEvents);
      } else {
        await retryTranscriptDelivery();
      }
      removeCurrent();
    } finally {
      setBusy(false);
    }
  };

  const discard = async (): Promise<void> => {
    if (!failure.batchId) {
      return;
    }
    setBusy(true);
    try {
      await discardTranscriptBatch(failure.batchId);
      removeCurrent();
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
        <CardDescription>{failure.message}</CardDescription>
      </CardHeader>
      <CardContent className="flex justify-end gap-2 px-4">
        {failure.canDiscard && failure.batchId ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void discard()}>
            <Trash2 data-icon="inline-start" />
            Discard
          </Button>
        ) : null}
        {failure.canRetry ? (
          <Button size="sm" disabled={busy} onClick={() => void retry()}>
            <RotateCcw data-icon="inline-start" />
            Retry
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
