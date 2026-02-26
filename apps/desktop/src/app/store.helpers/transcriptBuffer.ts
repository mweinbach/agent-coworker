import { appendTranscriptBatch } from "../../lib/desktopCommands";

type PendingTranscriptEntry = {
  ts: string;
  threadId: string;
  direction: "server" | "client";
  payload: unknown;
};

const TRANSCRIPT_BATCH_MS = 200;

type TranscriptBufferDeps = {
  nowIso: () => string;
};

export function createTranscriptBuffer(deps: TranscriptBufferDeps) {
  let transcriptBuffer: PendingTranscriptEntry[] = [];
  let transcriptTimer: ReturnType<typeof setTimeout> | null = null;

  function flushTranscriptBuffer() {
    if (transcriptBuffer.length === 0) return;
    const batch = transcriptBuffer;
    transcriptBuffer = [];
    transcriptTimer = null;
    void appendTranscriptBatch(batch);
  }

  function appendThreadTranscript(threadId: string, direction: "server" | "client", payload: unknown) {
    transcriptBuffer.push({ ts: deps.nowIso(), threadId, direction, payload });
    if (!transcriptTimer) {
      transcriptTimer = setTimeout(flushTranscriptBuffer, TRANSCRIPT_BATCH_MS);
    }
  }

  return {
    appendThreadTranscript,
  };
}
