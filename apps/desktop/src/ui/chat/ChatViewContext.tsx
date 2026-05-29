import { createContext, useContext } from "react";

import type { MentionCatalog } from "./composerMentions";

export type ChatViewContextValue = {
  developerMode: boolean;
  /** Skill/plugin catalog used to render @-mentions in the transcript. */
  mentionCatalog: MentionCatalog;
};

export const ChatViewContext = createContext<ChatViewContextValue | null>(null);

export function useChatViewContext(): ChatViewContextValue {
  const context = useContext(ChatViewContext);
  if (!context) {
    throw new Error("ChatViewContext is not available");
  }
  return context;
}
