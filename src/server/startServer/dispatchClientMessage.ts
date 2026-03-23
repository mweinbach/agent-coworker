import { createAgentClientMessageHandlers } from "./dispatchClientMessage.agents";
import {
  type DispatchClientMessageArgs,
  type LegacyClientMessageHandler,
  type LegacyClientMessageHandlerMap,
  sendUnknownSessionError,
} from "./dispatchClientMessage.shared";
import { createMcpClientMessageHandlers } from "./dispatchClientMessage.mcp";
import { createMemoryAndBackupsClientMessageHandlers } from "./dispatchClientMessage.memoryBackups";
import { createProviderClientMessageHandlers } from "./dispatchClientMessage.provider";
import { createSessionClientMessageHandlers } from "./dispatchClientMessage.session";
import { createSkillsClientMessageHandlers } from "./dispatchClientMessage.skills";
import { createThreadTurnClientMessageHandlers } from "./dispatchClientMessage.threadTurn";

const handlers = {
  ...createThreadTurnClientMessageHandlers(),
  ...createSessionClientMessageHandlers(),
  ...createProviderClientMessageHandlers(),
  ...createSkillsClientMessageHandlers(),
  ...createMcpClientMessageHandlers(),
  ...createMemoryAndBackupsClientMessageHandlers(),
  ...createAgentClientMessageHandlers(),
} satisfies LegacyClientMessageHandlerMap;

export function dispatchClientMessage({
  ws,
  session,
  message,
  sessionBindings,
}: DispatchClientMessageArgs): void {
  if (message.type === "client_hello") return;

  if (message.sessionId !== session.id) {
    sendUnknownSessionError({ ws, session, message, sessionBindings });
    return;
  }

  const handler = handlers[message.type] as LegacyClientMessageHandler<
    Exclude<DispatchClientMessageArgs["message"], { type: "client_hello" }>
  >;
  handler({ ws, session, message, sessionBindings });
}
