import type { LegacyClientMessageHandlerMap } from "./dispatchClientMessage.shared";

export function createAgentClientMessageHandlers(): Pick<
  LegacyClientMessageHandlerMap,
  "agent_spawn" | "agent_list_get" | "agent_input_send" | "agent_wait" | "agent_resume" | "agent_close"
> {
  return {
    agent_spawn: ({ session, message }) =>
      void session.createAgentSession({
        message: message.message,
        ...(message.role ? { role: message.role } : {}),
        ...(message.model ? { model: message.model } : {}),
        ...(message.reasoningEffort ? { reasoningEffort: message.reasoningEffort } : {}),
        ...(message.forkContext !== undefined ? { forkContext: message.forkContext } : {}),
      }),
    agent_list_get: ({ session }) =>
      void session.listAgentSessions(),
    agent_input_send: ({ session, message }) =>
      void session.sendAgentInput(message.agentId, message.message, message.interrupt),
    agent_wait: ({ session, message }) =>
      void session.waitForAgents(message.agentIds, message.timeoutMs),
    agent_resume: ({ session, message }) =>
      void session.resumeAgent(message.agentId),
    agent_close: ({ session, message }) =>
      void session.closeAgent(message.agentId),
  };
}
