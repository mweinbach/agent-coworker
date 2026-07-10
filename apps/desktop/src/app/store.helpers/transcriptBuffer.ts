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
  captureEvent?: (event: PendingTranscriptEntry) => boolean;
  appendBatch?: (events: PendingTranscriptEntry[]) => Promise<void>;
  schedule?: (callback: () => void, delayMs: number) => unknown;
};

export function createTranscriptBuffer(deps: TranscriptBufferDeps) {
  let transcriptBuffer: PendingTranscriptEntry[] = [];
  let transcriptTimer: unknown = null;
  const captureEvent = deps.captureEvent ?? captureTranscriptEvent;
  const appendBatch = deps.appendBatch ?? appendTranscriptBatch;
  const schedule = deps.schedule ?? globalThis.setTimeout;

  function flushTranscriptBuffer() {
    if (transcriptBuffer.length === 0) return;
    const batch = transcriptBuffer;
    transcriptBuffer = [];
    transcriptTimer = null;
    // Session snapshots are the long-term history source, but transcript JSONL
    // still backs compatibility paths like offline fallback hydration and usage.
    void appendBatch(batch);
  }

  function appendThreadTranscript(
    threadId: string,
    direction: "server" | "client",
    payload: unknown,
  ) {
    const event = { ts: deps.nowIso(), threadId, direction, payload };
    if (captureEvent(event)) {
      return;
    }
    transcriptBuffer.push(event);
    if (!transcriptTimer) {
      transcriptTimer = schedule(flushTranscriptBuffer, TRANSCRIPT_BATCH_MS);
    }
  }

  return {
    appendThreadTranscript,
  };
}
