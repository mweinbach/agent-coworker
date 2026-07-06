import type { ConversationImportSource } from "../types";
import { claudeCodeConversationAdapter } from "./claudeCode";
import { codexConversationAdapter } from "./codex";
import { coworkConversationAdapter } from "./cowork";
import type { ConversationSourceAdapter } from "./types";

const adapters: Record<ConversationImportSource, ConversationSourceAdapter> = {
  codex: codexConversationAdapter,
  "claude-code": claudeCodeConversationAdapter,
  cowork: coworkConversationAdapter,
};

export function getConversationSourceAdapter(
  source: ConversationImportSource,
): ConversationSourceAdapter {
  return adapters[source];
}

export function listConversationSourceAdapters(): ConversationSourceAdapter[] {
  return Object.values(adapters);
}
