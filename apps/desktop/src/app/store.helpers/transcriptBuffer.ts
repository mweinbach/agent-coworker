type TranscriptBufferDeps = {
  nowIso: () => string;
};

export function createTranscriptBuffer(_deps: TranscriptBufferDeps) {
  function appendThreadTranscript(threadId: string, direction: "server" | "client", payload: unknown) {
    void threadId;
    void direction;
    void payload;
    // Harness-backed session snapshots are the authoritative history source.
    // Keep legacy transcript JSONL read-only during the migration window.
  }

  return {
    appendThreadTranscript,
  };
}
