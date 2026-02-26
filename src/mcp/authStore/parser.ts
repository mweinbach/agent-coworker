import { z } from "zod";

import type { MCPServerCredentialsDocument } from "./types";

const nonEmptyStringSchema = z.string().trim().min(1);
const isoTimestampSchema = z.string().datetime({ offset: true });

const oauthPendingSchema = z.object({
  challengeId: nonEmptyStringSchema,
  state: nonEmptyStringSchema,
  codeVerifier: nonEmptyStringSchema,
  redirectUri: nonEmptyStringSchema,
  createdAt: isoTimestampSchema,
  expiresAt: isoTimestampSchema,
  authorizationServerUrl: nonEmptyStringSchema.optional(),
});

const oauthTokensSchema = z.object({
  accessToken: nonEmptyStringSchema,
  tokenType: nonEmptyStringSchema.optional(),
  refreshToken: nonEmptyStringSchema.optional(),
  expiresAt: isoTimestampSchema.optional(),
  scope: nonEmptyStringSchema.optional(),
  resource: nonEmptyStringSchema.optional(),
  updatedAt: isoTimestampSchema,
});

const oauthClientInfoSchema = z.object({
  clientId: nonEmptyStringSchema,
  clientSecret: nonEmptyStringSchema.optional(),
  updatedAt: isoTimestampSchema,
});

const apiKeyCredentialSchema = z.object({
  value: nonEmptyStringSchema,
  keyId: nonEmptyStringSchema.optional(),
  updatedAt: isoTimestampSchema,
});

const oauthCredentialSchema = z.object({
  pending: oauthPendingSchema.optional(),
  tokens: oauthTokensSchema.optional(),
  clientInformation: oauthClientInfoSchema.optional(),
}).strict();

const credentialRecordSchema = z.object({
  apiKey: apiKeyCredentialSchema.optional(),
  oauth: oauthCredentialSchema.optional(),
}).strict();

const credentialsDocSchema = z.object({
  version: z.literal(1),
  updatedAt: isoTimestampSchema,
  servers: z.record(z.string().min(1), credentialRecordSchema),
}).strict();

export const DEFAULT_MCP_CREDENTIALS_DOCUMENT: MCPServerCredentialsDocument = {
  version: 1,
  updatedAt: new Date(0).toISOString(),
  servers: {},
};

export function normalizeCredentialsDoc(raw: unknown): MCPServerCredentialsDocument {
  const parsed = credentialsDocSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid credential store schema: ${parsed.error.issues[0]?.message ?? "validation_failed"}`);
  }
  return parsed.data;
}
