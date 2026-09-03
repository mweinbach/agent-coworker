import type { TranscriptCaptureResult } from "../../lib/desktopApi";
import { appendTranscriptBatch, captureTranscriptEvent } from "../../lib/desktopCommands";

type PendingTranscriptEntry = {
  ts: string;
  threadId: string;
  direction: "server" | "client";
  payload: unknown;
};

const TRANSCRIPT_BATCH_MS = 200;

type TranscriptBufferDeps = {
  nowIso: () => string;
  captureEvent?: (event: PendingTranscriptEntry) => Promise<TranscriptCaptureResult> | null;
  appendBatch?: (events: PendingTranscriptEntry[]) => Promise<void>;
  schedule?: (callback: () => void, delayMs: number) => unknown;
};

export function createTranscriptBuffer(deps: TranscriptBufferDeps) {
  const transcriptBuffer = new Set<{
    event: PendingTranscriptEntry;
    capturePending: boolean;
  }>();
  let transcriptTimer: unknown = null;
  const captureEvent = deps.captureEvent ?? captureTranscriptEvent;
  const appendBatch = deps.appendBatch ?? appendTranscriptBatch;
  const schedule = deps.schedule ?? globalThis.setTimeout;

  function flushTranscriptBuffer() {
    const batch: PendingTranscriptEntry[] = [];
    for (const entry of transcriptBuffer) {
      if (entry.capturePending) continue;
      batch.push(entry.event);
      transcriptBuffer.delete(entry);
    }
    transcriptTimer = null;
    if (batch.length === 0) {
      return;
    }
    // Session snapshots are the long-term history source, but transcript JSONL
    // still backs compatibility paths like offline fallback hydration and usage.
    void appendBatch(batch).catch(() => {
      // Transcript JSONL is a compatibility projection. Session state remains
      // authoritative if the Electron bridge disappears during teardown.
    });
  }

  function scheduleFlush(): void {
    if (!transcriptTimer) {
      transcriptTimer = schedule(flushTranscriptBuffer, TRANSCRIPT_BATCH_MS);
    }
  }

  function appendThreadTranscript(
    threadId: string,
    direction: "server" | "client",
    payload: unknown,
  ) {
    const event = { ts: deps.nowIso(), threadId, direction, payload };
    const capture = captureEvent(event);
    if (!capture) {
      transcriptBuffer.add({ event, capturePending: false });
      scheduleFlush();
      return;
    }
    const pending = { event, capturePending: true };
    transcriptBuffer.add(pending);
    void capture.then(
      () => {
        transcriptBuffer.delete(pending);
      },
      () => {
        pending.capturePending = false;
        scheduleFlush();
      },
    );
  }

  return {
    appendThreadTranscript,
    pendingCount: () => transcriptBuffer.size,
  };
}
