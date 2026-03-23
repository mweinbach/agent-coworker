import type { LegacyClientMessageHandlerMap } from "./dispatchClientMessage.shared";

export function createMcpClientMessageHandlers(): Pick<
  LegacyClientMessageHandlerMap,
  | "mcp_servers_get"
  | "mcp_server_upsert"
  | "mcp_server_delete"
  | "mcp_server_validate"
  | "mcp_server_auth_authorize"
  | "mcp_server_auth_callback"
  | "mcp_server_auth_set_api_key"
  | "mcp_servers_migrate_legacy"
> {
  return {
    mcp_servers_get: ({ session }) =>
      void session.emitMcpServers(),
    mcp_server_upsert: ({ session, message }) =>
      void session.upsertMcpServer(message.server, message.previousName),
    mcp_server_delete: ({ session, message }) =>
      void session.deleteMcpServer(message.name),
    mcp_server_validate: ({ session, message }) =>
      void session.validateMcpServer(message.name),
    mcp_server_auth_authorize: ({ session, message }) =>
      void session.authorizeMcpServerAuth(message.name),
    mcp_server_auth_callback: ({ session, message }) =>
      void session.callbackMcpServerAuth(message.name, message.code),
    mcp_server_auth_set_api_key: ({ session, message }) =>
      void session.setMcpServerApiKey(message.name, message.apiKey),
    mcp_servers_migrate_legacy: ({ session, message }) =>
      void session.migrateLegacyMcpServers(message.scope),
  };
}
