import type { Message } from "../../pi/types";
import type { SessionContext } from "./SessionContext";

const MAX_MESSAGE_HISTORY = 200;

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

  appendMessagesToHistory(messages: Message[]) {
    if (messages.length === 0) return;

    this.context.state.allMessages.push(...messages);
    this.context.state.messages.push(...messages);
    if (this.context.state.messages.length > MAX_MESSAGE_HISTORY) {
      const first = this.context.state.messages[0];
      this.context.state.messages = [first, ...this.context.state.messages.slice(-(MAX_MESSAGE_HISTORY - 1))];
    }
  }
}
