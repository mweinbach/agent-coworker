import { z } from "zod";

import {
  legacyEventEnvelope,
  nonEmptyTrimmedStringSchema,
} from "./schema.shared";

export const providerCatalogEventSchema = z.object({
  type: z.literal("provider_catalog"),
  all: z.array(z.unknown()),
  default: z.record(z.string(), z.string()),
  connected: z.array(z.string()),
}).passthrough();

export const providerAuthMethodsEventSchema = z.object({
  type: z.literal("provider_auth_methods"),
  methods: z.record(z.string(), z.array(z.unknown())),
}).passthrough();

export const providerStatusEventSchema = z.object({
  type: z.literal("provider_status"),
  providers: z.array(z.unknown()),
}).passthrough();

export const providerAuthChallengeEventSchema = z.object({
  type: z.literal("provider_auth_challenge"),
}).passthrough();

export const providerAuthResultEventSchema = z.object({
  type: z.literal("provider_auth_result"),
}).passthrough();

export const jsonRpcProviderRequestSchemas = {
  "cowork/provider/catalog/read": z.object({
    cwd: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/provider/authMethods/read": z.object({
    cwd: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/provider/status/refresh": z.object({
    cwd: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/provider/auth/authorize": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    provider: nonEmptyTrimmedStringSchema,
    methodId: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/provider/auth/logout": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    provider: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/provider/auth/callback": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    provider: nonEmptyTrimmedStringSchema,
    methodId: nonEmptyTrimmedStringSchema,
    code: z.string().optional(),
  }).strict(),
  "cowork/provider/auth/setApiKey": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    provider: nonEmptyTrimmedStringSchema,
    methodId: nonEmptyTrimmedStringSchema,
    apiKey: z.string(),
  }).strict(),
  "cowork/provider/auth/copyApiKey": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    provider: nonEmptyTrimmedStringSchema,
    sourceProvider: nonEmptyTrimmedStringSchema,
  }).strict(),
} as const;

export const jsonRpcProviderResultSchemas = {
  "cowork/provider/catalog/read": legacyEventEnvelope(providerCatalogEventSchema),
  "cowork/provider/authMethods/read": legacyEventEnvelope(providerAuthMethodsEventSchema),
  "cowork/provider/status/refresh": legacyEventEnvelope(providerStatusEventSchema),
  "cowork/provider/auth/authorize": legacyEventEnvelope(z.union([
    providerAuthChallengeEventSchema,
    providerAuthResultEventSchema,
  ])),
  "cowork/provider/auth/logout": legacyEventEnvelope(providerAuthResultEventSchema),
  "cowork/provider/auth/callback": legacyEventEnvelope(providerAuthResultEventSchema),
  "cowork/provider/auth/setApiKey": legacyEventEnvelope(providerAuthResultEventSchema),
  "cowork/provider/auth/copyApiKey": legacyEventEnvelope(providerAuthResultEventSchema),
} as const;
