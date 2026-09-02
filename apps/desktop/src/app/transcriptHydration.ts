import {
  extractAgentStateFromTranscript,
  extractUsageStateFromTranscript,
  extractWorkflowRunsFromTranscript,
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
    workflowRuns: extractWorkflowRunsFromTranscript(transcript),
    sessionUsage: usageState.sessionUsage ?? null,
    lastTurnUsage: usageState.lastTurnUsage ?? null,
  };
}
