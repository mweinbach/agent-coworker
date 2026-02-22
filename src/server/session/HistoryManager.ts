import type { ModelMessage } from "ai";

export class HistoryManager {
  constructor(
    private readonly handlers: {
      refreshRuntimeMessagesFromHistory: () => void;
      appendMessagesToHistory: (messages: ModelMessage[]) => void;
    }
  ) {}

  refreshRuntimeMessagesFromHistory() {
    this.handlers.refreshRuntimeMessagesFromHistory();
  }

  appendMessagesToHistory(messages: ModelMessage[]) {
    this.handlers.appendMessagesToHistory(messages);
  }
}
