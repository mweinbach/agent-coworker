import { createContext, useContext } from "react";

export type ChatViewContextValue = {
  developerMode: boolean;
};

export const ChatViewContext = createContext<ChatViewContextValue | null>(null);

export function useChatViewContext(): ChatViewContextValue {
  const context = useContext(ChatViewContext);
  if (!context) {
    throw new Error("ChatViewContext is not available");
  }
  return context;
}
