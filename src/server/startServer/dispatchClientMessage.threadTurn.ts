import type { LegacyClientMessageHandlerMap } from "./dispatchClientMessage.shared";
import { sendPong } from "./dispatchClientMessage.shared";

export function createThreadTurnClientMessageHandlers(): Pick<
  LegacyClientMessageHandlerMap,
  "ping" | "user_message" | "steer_message" | "ask_response" | "approval_response" | "cancel" | "reset"
> {
  return {
    ping: ({ ws, message }) => {
      sendPong(ws, message.sessionId);
    },
    user_message: ({ session, message }) =>
      void session.sendUserMessage(message.text, message.clientMessageId),
    steer_message: ({ session, message }) =>
      void session.sendSteerMessage(message.text, message.expectedTurnId, message.clientMessageId),
    ask_response: ({ session, message }) =>
      session.handleAskResponse(message.requestId, message.answer),
    approval_response: ({ session, message }) =>
      session.handleApprovalResponse(message.requestId, message.approved),
    cancel: ({ session, message }) =>
      session.cancel({ includeSubagents: message.includeSubagents === true }),
    reset: ({ session }) =>
      session.reset(),
  };
}
