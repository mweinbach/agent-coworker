import type { SessionFeedItem, SessionSnapshot } from "./sessionSnapshot";
import { isToolInputDigest, type ToolInputDigest } from "./toolInputDigest";
import { TOOL_RETRY_TURN_ANNOTATION_TYPE } from "./toolRetry";

const TOOL_RETRY_METADATA_ANNOTATION_TYPE = "cowork.toolRetryMetadata";
const TOOL_RETRY_METADATA_VERSION = 1;
export const MAX_PERSISTED_TOOL_RETRY_METADATA = 256;

type ToolRetryMetadataEntry = {
  itemId: string;
  inputDigest?: ToolInputDigest;
  retryOf?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEntry(value: unknown): ToolRetryMetadataEntry | null {
  if (!isRecord(value) || typeof value.itemId !== "string" || !value.itemId.trim()) return null;
  const inputDigest = isToolInputDigest(value.inputDigest) ? value.inputDigest : undefined;
  const retryOf =
    typeof value.retryOf === "string" && value.retryOf.trim() ? value.retryOf : undefined;
  if (!inputDigest && !retryOf) return null;
  return {
    itemId: value.itemId,
    ...(inputDigest ? { inputDigest } : {}),
    ...(retryOf ? { retryOf } : {}),
  };
}

function isMetadataAnnotation(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.type === TOOL_RETRY_METADATA_ANNOTATION_TYPE &&
    value.version === TOOL_RETRY_METADATA_VERSION
  );
}

function isRetryTurnAnnotation(value: unknown): boolean {
  return isRecord(value) && value.type === TOOL_RETRY_TURN_ANNOTATION_TYPE;
}

function isRetryTurnMessage(item: SessionFeedItem): boolean {
  return (
    item.kind === "message" &&
    item.role === "user" &&
    item.annotations?.some(isRetryTurnAnnotation) === true
  );
}

function entriesFromFeed(feed: SessionFeedItem[]): ToolRetryMetadataEntry[] {
  return feed
    .filter(
      (item): item is Extract<SessionFeedItem, { kind: "tool" }> =>
        item.kind === "tool" && (item.inputDigest !== undefined || item.retryOf !== undefined),
    )
    .slice(-MAX_PERSISTED_TOOL_RETRY_METADATA)
    .map((item) => ({
      itemId: item.id,
      ...(item.inputDigest ? { inputDigest: item.inputDigest } : {}),
      ...(item.retryOf ? { retryOf: item.retryOf } : {}),
    }));
}

function withoutMetadataAnnotations(
  annotations: Array<Record<string, unknown>> | undefined,
): Array<Record<string, unknown>> {
  return (annotations ?? []).filter((annotation) => !isMetadataAnnotation(annotation));
}

export function hydrateToolRetrySnapshotMetadata(snapshot: SessionSnapshot): SessionSnapshot {
  const next = structuredClone(snapshot);
  const metadataByItemId = new Map<string, ToolRetryMetadataEntry>();
  for (const item of next.feed) {
    if (item.kind !== "message" || !item.annotations) continue;
    for (const annotation of item.annotations) {
      if (!isMetadataAnnotation(annotation) || !Array.isArray(annotation.entries)) continue;
      for (const value of annotation.entries.slice(-MAX_PERSISTED_TOOL_RETRY_METADATA)) {
        const entry = parseEntry(value);
        if (entry) metadataByItemId.set(entry.itemId, entry);
      }
    }
    const annotations = withoutMetadataAnnotations(item.annotations);
    if (annotations.length > 0) {
      item.annotations = annotations;
    } else {
      delete item.annotations;
    }
  }
  next.feed = next.feed.filter((item) => !isRetryTurnMessage(item));
  for (const item of next.feed) {
    if (item.kind !== "tool") continue;
    const metadata = metadataByItemId.get(item.id);
    if (!metadata) continue;
    if (metadata.inputDigest) item.inputDigest = metadata.inputDigest;
    if (metadata.retryOf) item.retryOf = metadata.retryOf;
  }
  return next;
}

export function encodeToolRetrySnapshotMetadata(snapshot: SessionSnapshot): SessionSnapshot {
  const hydrated = hydrateToolRetrySnapshotMetadata(snapshot);
  const entries = entriesFromFeed(hydrated.feed);
  let targetMessageIndex = -1;
  const feed = hydrated.feed.map((item, index): SessionFeedItem => {
    if (item.kind === "message") {
      targetMessageIndex = index;
      const annotations = withoutMetadataAnnotations(item.annotations);
      return {
        ...item,
        ...(annotations.length > 0 ? { annotations } : {}),
      };
    }
    if (item.kind !== "tool") return item;
    const rollbackSafeItem = { ...item };
    delete rollbackSafeItem.inputDigest;
    delete rollbackSafeItem.retryOf;
    return rollbackSafeItem;
  });

  if (entries.length > 0 && targetMessageIndex >= 0) {
    const target = feed[targetMessageIndex];
    if (target?.kind === "message") {
      feed[targetMessageIndex] = {
        ...target,
        annotations: [
          ...(target.annotations ?? []),
          {
            type: TOOL_RETRY_METADATA_ANNOTATION_TYPE,
            version: TOOL_RETRY_METADATA_VERSION,
            entries,
          },
        ],
      };
    }
  }
  return {
    ...hydrated,
    feed,
  };
}
