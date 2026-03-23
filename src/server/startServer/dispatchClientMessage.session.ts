import type { LegacyClientMessageHandlerMap } from "./dispatchClientMessage.shared";
import { closeSessionAndSocket } from "./dispatchClientMessage.shared";

export function createSessionClientMessageHandlers(): Pick<
  LegacyClientMessageHandlerMap,
  | "set_model"
  | "apply_session_defaults"
  | "session_close"
  | "list_tools"
  | "list_commands"
  | "execute_command"
  | "set_enable_mcp"
  | "harness_context_get"
  | "harness_context_set"
  | "get_messages"
  | "set_session_title"
  | "list_sessions"
  | "get_session_snapshot"
  | "delete_session"
  | "set_config"
  | "upload_file"
  | "get_session_usage"
  | "set_session_usage_budget"
> {
  return {
    set_model: ({ session, message }) =>
      void session.setModel(message.model, message.provider),
    apply_session_defaults: ({ session, message }) =>
      void session.applySessionDefaults({
        ...(message.provider !== undefined ? { provider: message.provider, model: message.model! } : {}),
        ...(message.enableMcp !== undefined ? { enableMcp: message.enableMcp } : {}),
        ...(message.config !== undefined ? { config: message.config } : {}),
      }),
    session_close: ({ ws, session, sessionBindings }) =>
      closeSessionAndSocket({ ws, session, sessionBindings }),
    list_tools: ({ session }) =>
      session.listTools(),
    list_commands: ({ session }) =>
      void session.listCommands(),
    execute_command: ({ session, message }) =>
      void session.executeCommand(message.name, message.arguments ?? "", message.clientMessageId),
    set_enable_mcp: ({ session, message }) =>
      void session.setEnableMcp(message.enableMcp),
    harness_context_get: ({ session }) =>
      session.getHarnessContext(),
    harness_context_set: ({ session, message }) =>
      session.setHarnessContext(message.context),
    get_messages: ({ session, message }) =>
      session.getMessages(message.offset, message.limit),
    set_session_title: ({ session, message }) =>
      session.setSessionTitle(message.title),
    list_sessions: ({ session, message }) =>
      void session.listSessions(message.scope),
    get_session_snapshot: ({ session, message }) =>
      void session.getSessionSnapshot(message.targetSessionId),
    delete_session: ({ session, message }) =>
      void session.deleteSession(message.targetSessionId),
    set_config: ({ session, message }) =>
      void session.setConfig(message.config),
    upload_file: ({ session, message }) =>
      void session.uploadFile(message.filename, message.contentBase64),
    get_session_usage: ({ session }) =>
      session.getSessionUsage(),
    set_session_usage_budget: ({ session, message }) =>
      session.setSessionUsageBudget(message.warnAtUsd, message.stopAtUsd),
  };
}
