import type { CitationSource } from "../../../../../src/shared/displayCitationMarkers";
import type { FeedItem } from "../../app/types";

function sourceDedupeKey(source: CitationSource): string {
  if (typeof source.referenceId === "string" && source.referenceId.trim()) {
    return `ref:${source.referenceId.trim()}`;
  }
  if (typeof source.url === "string" && source.url.trim()) return `url:${source.url.trim()}`;
  if (typeof source.title === "string" && source.title.trim())
    return `title:${source.title.trim()}`;
  return JSON.stringify(source);
}

/**
 * Preserve citation metadata for every assistant while appending earlier turn
 * sources to the final assistant after its own index-aligned source entries.
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
      const finalSources = sourcesByMessageId.get(lastAssistantId) ?? [];
      const promotedSources = [...finalSources];
      const finalSourceKeys = new Set(finalSources.map(sourceDedupeKey));
      for (const source of turnSources) {
        const key = sourceDedupeKey(source);
        if (finalSourceKeys.has(key)) continue;
        finalSourceKeys.add(key);
        promotedSources.push(source);
      }
      result.set(lastAssistantId, promotedSources);
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
        result.set(item.id, existing);
        pushSources(existing);
      }
    }
  }
  flush();
  return result;
}
