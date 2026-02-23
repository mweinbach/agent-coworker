import type { ClientMessage } from "../protocol";
import type { AgentSession } from "../session/AgentSession";

import { type SessionBinding, type StartServerSocket } from "./types";
import { buildProtocolErrorEvent } from "./decodeClientMessage";

type DispatchClientMessageArgs = {
  ws: StartServerSocket;
  session: AgentSession;
  message: ClientMessage;
  sessionBindings: Map<string, SessionBinding>;
};

export function dispatchClientMessage({
  ws,
  session,
  message,
  sessionBindings,
}: DispatchClientMessageArgs): void {
  if (message.type === "client_hello") return;

  if (message.sessionId !== session.id) {
    ws.send(JSON.stringify(
      buildProtocolErrorEvent(
        session.id,
        `Unknown sessionId: ${message.sessionId}`,
        "unknown_session",
      ),
    ));
    return;
  }

  switch (message.type) {
    case "ping":
      try {
        ws.send(JSON.stringify({ type: "pong", sessionId: message.sessionId }));
      } catch {
        // ignore
      }
      return;
    case "user_message":
      return void session.sendUserMessage(message.text, message.clientMessageId);
    case "ask_response":
      return session.handleAskResponse(message.requestId, message.answer);
    case "approval_response":
      return session.handleApprovalResponse(message.requestId, message.approved);
    case "set_model":
      return void session.setModel(message.model, message.provider);
    case "refresh_provider_status":
      return void session.refreshProviderStatus();
    case "provider_catalog_get":
      return void session.emitProviderCatalog();
    case "provider_auth_methods_get":
      return session.emitProviderAuthMethods();
    case "provider_auth_authorize":
      return void session.authorizeProviderAuth(message.provider, message.methodId);
    case "provider_auth_callback":
      return void session.callbackProviderAuth(message.provider, message.methodId, message.code);
    case "provider_auth_set_api_key":
      return void session.setProviderApiKey(message.provider, message.methodId, message.apiKey);
    case "cancel":
      return session.cancel();
    case "session_close":
      return void (async () => {
        await session.closeForHistory();
        session.dispose("client requested close");
        sessionBindings.delete(session.id);
        try {
          ws.close();
        } catch {
          // ignore
        }
      })();
    case "reset":
      return session.reset();
    case "list_tools":
      return session.listTools();
    case "list_commands":
      return void session.listCommands();
    case "execute_command":
      return void session.executeCommand(message.name, message.arguments ?? "", message.clientMessageId);
    case "list_skills":
      return void session.listSkills();
    case "read_skill":
      return void session.readSkill(message.skillName);
    case "disable_skill":
      return void session.disableSkill(message.skillName);
    case "enable_skill":
      return void session.enableSkill(message.skillName);
    case "delete_skill":
      return void session.deleteSkill(message.skillName);
    case "set_enable_mcp":
      return void session.setEnableMcp(message.enableMcp);
    case "mcp_servers_get":
      return void session.emitMcpServers();
    case "mcp_server_upsert":
      return void session.upsertMcpServer(message.server, message.previousName);
    case "mcp_server_delete":
      return void session.deleteMcpServer(message.name);
    case "mcp_server_validate":
      return void session.validateMcpServer(message.name);
    case "mcp_server_auth_authorize":
      return void session.authorizeMcpServerAuth(message.name);
    case "mcp_server_auth_callback":
      return void session.callbackMcpServerAuth(message.name, message.code);
    case "mcp_server_auth_set_api_key":
      return void session.setMcpServerApiKey(message.name, message.apiKey);
    case "mcp_servers_migrate_legacy":
      return void session.migrateLegacyMcpServers(message.scope);
    case "harness_context_get":
      return session.getHarnessContext();
    case "harness_context_set":
      return session.setHarnessContext(message.context);
    case "session_backup_get":
      return void session.getSessionBackupState();
    case "session_backup_checkpoint":
      return void session.createManualSessionCheckpoint();
    case "session_backup_restore":
      return void session.restoreSessionBackup(message.checkpointId);
    case "session_backup_delete_checkpoint":
      return void session.deleteSessionCheckpoint(message.checkpointId);
    case "get_messages":
      return session.getMessages(message.offset, message.limit);
    case "set_session_title":
      return session.setSessionTitle(message.title);
    case "list_sessions":
      return void session.listSessions();
    case "delete_session":
      return void session.deleteSession(message.targetSessionId);
    case "set_config":
      return void session.setConfig(message.config);
    case "upload_file":
      return void session.uploadFile(message.filename, message.contentBase64);
  }
}
