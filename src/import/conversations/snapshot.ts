import type { SessionFeedItem } from "../../shared/sessionSnapshot";
import { shortHash } from "./normalize";
import type { ExternalConversation, ExternalConversationItem } from "./types";

function feedId(conversation: ExternalConversation, item: ExternalConversationItem): string {
  return `import-feed-${shortHash({ fingerprint: conversation.fingerprint, itemId: item.id })}`;
}

export function buildImportBanner(
  conversation: ExternalConversation,
  importedAt: string,
): SessionFeedItem {
  const original = conversation.originalModel
    ? ` Original model: ${conversation.originalModel}.`
    : "";
  return {
    id: `import-banner-${shortHash({ fingerprint: conversation.fingerprint, importedAt })}`,
    kind: "system",
    ts: importedAt,
    line: `Imported from ${conversation.source} on ${importedAt}.${original} Future Cowork turns use sanitized summarized context, not the original provider continuation state.`,
  };
}

export function conversationToSessionFeed(
  conversation: ExternalConversation,
  opts: { importedAt: string },
): SessionFeedItem[] {
  const feed: SessionFeedItem[] = [buildImportBanner(conversation, opts.importedAt)];
  for (const item of conversation.items) {
    if (item.kind === "user" || item.kind === "assistant") {
      feed.push({
        id: feedId(conversation, item),
        kind: "message",
        role: item.kind,
        ts: item.ts,
        text: item.text,
      });
      continue;
    }
    if (item.kind === "reasoning") {
      feed.push({
        id: feedId(conversation, item),
        kind: "reasoning",
        mode: "summary",
        ts: item.ts,
        text: item.text,
      });
      continue;
    }
    if (item.kind === "system") {
      feed.push({
        id: feedId(conversation, item),
        kind: "system",
        ts: item.ts,
        line: item.text,
      });
      continue;
    }
    feed.push({
      id: feedId(conversation, item),
      kind: "tool",
      ts: item.ts,
      name: item.name,
      state: item.error ? "output-error" : "output-available",
      ...(item.args !== undefined ? { args: item.args } : {}),
      ...(item.error
        ? { result: item.error }
        : item.result !== undefined
          ? { result: item.result }
          : {}),
      completedAt: item.ts,
    });
  }
  return feed;
}

export function countVisibleMessages(conversation: ExternalConversation): number {
  return conversation.items.filter((item) => item.kind === "user" || item.kind === "assistant")
    .length;
}

export function previewText(conversation: ExternalConversation): string | null {
  for (let index = conversation.items.length - 1; index >= 0; index -= 1) {
    const item = conversation.items[index];
    if ((item.kind === "user" || item.kind === "assistant") && item.text.trim()) {
      return item.text.trim().slice(0, 240);
    }
  }
  return null;
}
