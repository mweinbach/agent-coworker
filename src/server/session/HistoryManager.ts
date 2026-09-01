import type { ModelMessage } from "../../types";
import type { SessionContext } from "./SessionContext";

const MAX_MESSAGE_HISTORY = 200;

function runtimeMessageWindow(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length <= MAX_MESSAGE_HISTORY) return [...messages];

  let start = messages.length - (MAX_MESSAGE_HISTORY - 1);
  // Tool results belong to the immediately preceding assistant call. If that
  // call falls outside the window, omit its results as well.
  while (start < messages.length && messages[start].role === "tool") start += 1;

  return [messages[0], ...messages.slice(start)];
}

export class HistoryManager {
  constructor(private readonly context: SessionContext) {}

  refreshRuntimeMessagesFromHistory() {
    this.context.state.messages = runtimeMessageWindow(this.context.state.allMessages);
  }

  appendMessagesToHistory(messages: ModelMessage[]) {
    if (messages.length === 0) return;

    // Avoid V8 max argument limit by concatenating instead of spreading large arrays
    this.context.state.allMessages = this.context.state.allMessages.concat(messages);
    this.context.state.messages = runtimeMessageWindow(
      this.context.state.messages.concat(messages),
    );
  }
}
