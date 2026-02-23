import type { MCPServerAuthConfig } from "../../types";

export type MCPAuthMode = "none" | "missing" | "api_key" | "oauth" | "oauth_pending" | "error";
export type MCPAuthScope = "workspace" | "user";

export interface MCPServerOAuthPending {
  challengeId: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: string;
  expiresAt: string;
  /** Authorization server URL resolved during the authorize phase (RFC 9728 / RFC 8414). */
  authorizationServerUrl?: string;
}

export interface MCPServerOAuthTokens {
  accessToken: string;
  tokenType?: string;
  refreshToken?: string;
  expiresAt?: string;
  scope?: string;
  resource?: string;
  updatedAt: string;
}

export interface MCPServerOAuthClientInfo {
  clientId: string;
  clientSecret?: string;
  updatedAt: string;
}

export interface MCPServerCredentialRecord {
  apiKey?: {
    value: string;
    keyId?: string;
    updatedAt: string;
  };
  oauth?: {
    pending?: MCPServerOAuthPending;
    tokens?: MCPServerOAuthTokens;
    clientInformation?: MCPServerOAuthClientInfo;
  };
}

export interface MCPServerCredentialsDocument {
  version: 1;
  updatedAt: string;
  servers: Record<string, MCPServerCredentialRecord>;
}

export interface MCPAuthFileState {
  scope: MCPAuthScope;
  filePath: string;
  doc: MCPServerCredentialsDocument;
}

export interface MCPResolvedServerAuth {
  mode: MCPAuthMode;
  scope: MCPAuthScope;
  authType: MCPServerAuthConfig["type"];
  message: string;
  headers?: Record<string, string>;
  apiKey?: string;
  oauthTokens?: MCPServerOAuthTokens;
  oauthPending?: MCPServerOAuthPending;
  oauthClientInfo?: MCPServerOAuthClientInfo;
}
