import { z } from "zod";

import {
  jsonRpcControlRequestSchemas,
  jsonRpcControlResultSchemas,
  providerAuthChallengeEventSchema,
  providerAuthMethodsEventSchema,
  providerAuthResultEventSchema,
  providerCatalogEventSchema,
  providerStatusEventSchema,
} from "../../shared/jsonrpcControlSchemas";

import {
  legacyEventEnvelope,
  nonEmptyTrimmedStringSchema,
} from "./schema.shared";

export const userConfigEventSchema = z.object({
  type: z.literal("user_config"),
  sessionId: z.string(),
  config: z.record(z.string(), z.unknown()),
}).passthrough();

export const userConfigResultEventSchema = z.object({
  type: z.literal("user_config_result"),
  sessionId: z.string(),
  ok: z.boolean(),
  message: z.string(),
  config: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const userConfigPatchSchema = z.object({
  awsBedrockProxyBaseUrl: z.string().nullable().optional(),
  openaiProxyBaseUrl: z.string().nullable().optional(),
}).strict();

export {
  providerCatalogEventSchema,
  providerAuthMethodsEventSchema,
  providerStatusEventSchema,
  providerAuthChallengeEventSchema,
  providerAuthResultEventSchema,
};

export const jsonRpcProviderRequestSchemas = {
  "cowork/provider/catalog/read": jsonRpcControlRequestSchemas["cowork/provider/catalog/read"],
  "cowork/provider/authMethods/read": jsonRpcControlRequestSchemas["cowork/provider/authMethods/read"],
  "cowork/provider/status/refresh": jsonRpcControlRequestSchemas["cowork/provider/status/refresh"],
  "cowork/provider/auth/authorize": jsonRpcControlRequestSchemas["cowork/provider/auth/authorize"],
  "cowork/provider/auth/logout": jsonRpcControlRequestSchemas["cowork/provider/auth/logout"],
  "cowork/provider/auth/callback": jsonRpcControlRequestSchemas["cowork/provider/auth/callback"],
  "cowork/provider/auth/setApiKey": jsonRpcControlRequestSchemas["cowork/provider/auth/setApiKey"],
  "cowork/provider/auth/copyApiKey": jsonRpcControlRequestSchemas["cowork/provider/auth/copyApiKey"],
  "cowork/provider/userConfig/read": z.object({
    cwd: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/provider/userConfig/set": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    config: userConfigPatchSchema,
  }).strict(),
} as const;

export const jsonRpcProviderResultSchemas = {
  "cowork/provider/catalog/read": jsonRpcControlResultSchemas["cowork/provider/catalog/read"],
  "cowork/provider/authMethods/read": jsonRpcControlResultSchemas["cowork/provider/authMethods/read"],
  "cowork/provider/status/refresh": jsonRpcControlResultSchemas["cowork/provider/status/refresh"],
  "cowork/provider/auth/authorize": jsonRpcControlResultSchemas["cowork/provider/auth/authorize"],
  "cowork/provider/auth/logout": jsonRpcControlResultSchemas["cowork/provider/auth/logout"],
  "cowork/provider/auth/callback": jsonRpcControlResultSchemas["cowork/provider/auth/callback"],
  "cowork/provider/auth/setApiKey": jsonRpcControlResultSchemas["cowork/provider/auth/setApiKey"],
  "cowork/provider/auth/copyApiKey": jsonRpcControlResultSchemas["cowork/provider/auth/copyApiKey"],
  "cowork/provider/userConfig/read": legacyEventEnvelope(userConfigEventSchema),
  "cowork/provider/userConfig/set": legacyEventEnvelope(userConfigResultEventSchema),
} as const;
