import type { ModelMessage } from "../../types";
import type { SessionContext } from "./SessionContext";

const MAX_MESSAGE_HISTORY = 200;
const MAX_ALL_MESSAGES = 1000;

export class HistoryManager {
  constructor(private readonly context: SessionContext) {}

  refreshRuntimeMessagesFromHistory() {
    if (this.context.state.allMessages.length <= MAX_MESSAGE_HISTORY) {
      this.context.state.messages = [...this.context.state.allMessages];
      return;
    }

    const first = this.context.state.allMessages[0];
    this.context.state.messages = [first, ...this.context.state.allMessages.slice(-(MAX_MESSAGE_HISTORY - 1))];
  }

  appendMessagesToHistory(messages: ModelMessage[]) {
    if (messages.length === 0) return;

    // Avoid V8 max argument limit by concatenating instead of spreading large arrays
    this.context.state.allMessages = this.context.state.allMessages.concat(messages);
    this.context.state.messages = this.context.state.messages.concat(messages);

    if (this.context.state.allMessages.length > MAX_ALL_MESSAGES) {
      const first = this.context.state.allMessages[0];
      const isSystem = first?.role === "system";
      const keepCount = MAX_ALL_MESSAGES - (isSystem ? 1 : 0);
      this.context.state.allMessages = [
        ...(isSystem ? [first] : []),
        ...this.context.state.allMessages.slice(-keepCount),
      ];
    }

    if (this.context.state.messages.length > MAX_MESSAGE_HISTORY) {
      const first = this.context.state.messages[0];
      this.context.state.messages = [first, ...this.context.state.messages.slice(-(MAX_MESSAGE_HISTORY - 1))];
    }
  }
}
