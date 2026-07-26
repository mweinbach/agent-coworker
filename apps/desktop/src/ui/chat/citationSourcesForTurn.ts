import type { CitationSource } from "../../../../../src/shared/displayCitationMarkers";
import type { FeedItem } from "../../app/types";

function sourceDedupeKey(source: CitationSource): string {
  if (typeof source.url === "string" && source.url.trim()) return `url:${source.url.trim()}`;
  if (typeof source.title === "string" && source.title.trim())
    return `title:${source.title.trim()}`;
  if (typeof source.referenceId === "string" && source.referenceId.trim()) {
    return `ref:${source.referenceId.trim()}`;
  }
  return JSON.stringify(source);
}

/**
 * Bind all sources gathered during a user turn to that turn's final assistant
 * message only. Intermediate assistant bubbles (progress narration) should not
 * render a SOURCES carousel mid-trace.
 */
export function promoteCitationSourcesToFinalAssistants(
  feed: readonly FeedItem[],
  sourcesByMessageId: ReadonlyMap<string, CitationSource[]>,
): Map<string, CitationSource[]> {
  const result = new Map<string, CitationSource[]>();
  let turnSources: CitationSource[] = [];
  let seenKeys = new Set<string>();
  let lastAssistantId: string | null = null;

  const flush = () => {
    if (lastAssistantId && turnSources.length > 0) {
      result.set(lastAssistantId, turnSources);
    }
    turnSources = [];
    seenKeys = new Set();
    lastAssistantId = null;
  };

  const pushSources = (sources: readonly CitationSource[]) => {
    for (const source of sources) {
      const key = sourceDedupeKey(source);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      turnSources.push(source);
    }
  };

  for (const item of feed) {
    if (item.kind === "message" && item.role === "user") {
      flush();
      continue;
    }
    if (item.kind === "message" && item.role === "assistant") {
      lastAssistantId = item.id;
      const existing = sourcesByMessageId.get(item.id);
      if (existing && existing.length > 0) {
        pushSources(existing);
      }
    }
  }
  flush();
  return result;
}
