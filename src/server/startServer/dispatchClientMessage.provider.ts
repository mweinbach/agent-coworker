import type { LegacyClientMessageHandlerMap } from "./dispatchClientMessage.shared";

export function createProviderClientMessageHandlers(): Pick<
  LegacyClientMessageHandlerMap,
  | "refresh_provider_status"
  | "provider_catalog_get"
  | "provider_auth_methods_get"
  | "provider_auth_authorize"
  | "provider_auth_logout"
  | "provider_auth_callback"
  | "provider_auth_set_api_key"
  | "provider_auth_copy_api_key"
> {
  return {
    refresh_provider_status: ({ session }) =>
      void session.refreshProviderStatus(),
    provider_catalog_get: ({ session }) =>
      void session.emitProviderCatalog(),
    provider_auth_methods_get: ({ session }) =>
      session.emitProviderAuthMethods(),
    provider_auth_authorize: ({ session, message }) =>
      void session.authorizeProviderAuth(message.provider, message.methodId),
    provider_auth_logout: ({ session, message }) =>
      void session.logoutProviderAuth(message.provider),
    provider_auth_callback: ({ session, message }) =>
      void session.callbackProviderAuth(message.provider, message.methodId, message.code),
    provider_auth_set_api_key: ({ session, message }) =>
      void session.setProviderApiKey(message.provider, message.methodId, message.apiKey),
    provider_auth_copy_api_key: ({ session, message }) =>
      void session.copyProviderApiKey(message.provider, message.sourceProvider),
  };
}
