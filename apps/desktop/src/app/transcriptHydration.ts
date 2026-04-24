import {
  extractAgentStateFromTranscript,
  extractUsageStateFromTranscript,
  mapTranscriptToFeed,
} from "./store.feedMapping";
import type { HydratedTranscriptSnapshot, TranscriptEvent } from "./types";

export function hydrateTranscriptSnapshot(
  transcript: TranscriptEvent[],
): HydratedTranscriptSnapshot {
  const usageState = extractUsageStateFromTranscript(transcript);
  return {
    feed: mapTranscriptToFeed(transcript),
    agents: extractAgentStateFromTranscript(transcript),
    sessionUsage: usageState.sessionUsage ?? null,
    lastTurnUsage: usageState.lastTurnUsage ?? null,
  };
}
