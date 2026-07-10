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
  const transcriptBuffer: Array<{
    event: PendingTranscriptEntry;
    capturePending: boolean;
  }> = [];
  let transcriptTimer: unknown = null;
  const captureEvent = deps.captureEvent ?? captureTranscriptEvent;
  const appendBatch = deps.appendBatch ?? appendTranscriptBatch;
  const schedule = deps.schedule ?? globalThis.setTimeout;

  function flushTranscriptBuffer() {
    const batch = transcriptBuffer.filter((entry) => !entry.capturePending);
    if (batch.length === 0) {
      transcriptTimer = null;
      return;
    }
    for (const entry of batch) {
      transcriptBuffer.splice(transcriptBuffer.indexOf(entry), 1);
    }
    transcriptTimer = null;
    // Session snapshots are the long-term history source, but transcript JSONL
    // still backs compatibility paths like offline fallback hydration and usage.
    void appendBatch(batch.map((entry) => entry.event)).catch(() => {
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
      transcriptBuffer.push({ event, capturePending: false });
      scheduleFlush();
      return;
    }
    const pending = { event, capturePending: true };
    transcriptBuffer.push(pending);
    void capture.then(
      () => {
        const index = transcriptBuffer.indexOf(pending);
        if (index >= 0) {
          transcriptBuffer.splice(index, 1);
        }
      },
      () => {
        pending.capturePending = false;
        scheduleFlush();
      },
    );
  }

  return {
    appendThreadTranscript,
    pendingCount: () => transcriptBuffer.length,
  };
}
