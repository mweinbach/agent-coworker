import { z } from "zod";

import {
  anyObjectSchema,
  legacyEventEnvelope,
  nonEmptyTrimmedStringSchema,
} from "./schema.shared";

export const mcpServersEventSchema = z.object({
  type: z.literal("mcp_servers"),
  servers: z.array(z.unknown()),
  files: z.array(z.unknown()),
}).passthrough();

export const mcpValidationEventSchema = z.object({
  type: z.literal("mcp_server_validation"),
}).passthrough();

export const mcpAuthChallengeEventSchema = z.object({
  type: z.literal("mcp_server_auth_challenge"),
}).passthrough();

export const mcpAuthResultEventSchema = z.object({
  type: z.literal("mcp_server_auth_result"),
}).passthrough();

export const jsonRpcMcpRequestSchemas = {
  "cowork/mcp/servers/read": z.object({
    cwd: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/mcp/server/upsert": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    server: anyObjectSchema,
    previousName: z.string().optional(),
  }).strict(),
  "cowork/mcp/server/delete": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    name: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/mcp/server/validate": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    name: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/mcp/server/auth/authorize": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    name: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/mcp/server/auth/callback": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    name: nonEmptyTrimmedStringSchema,
    code: z.string().optional(),
  }).strict(),
  "cowork/mcp/server/auth/setApiKey": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    name: nonEmptyTrimmedStringSchema,
    apiKey: z.string(),
  }).strict(),
  "cowork/mcp/legacy/migrate": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    scope: z.enum(["workspace", "user"]),
  }).strict(),
} as const;

export const jsonRpcMcpResultSchemas = {
  "cowork/mcp/servers/read": legacyEventEnvelope(mcpServersEventSchema),
  "cowork/mcp/server/upsert": legacyEventEnvelope(mcpServersEventSchema),
  "cowork/mcp/server/delete": legacyEventEnvelope(mcpServersEventSchema),
  "cowork/mcp/server/validate": legacyEventEnvelope(mcpValidationEventSchema),
  "cowork/mcp/server/auth/authorize": legacyEventEnvelope(z.union([
    mcpAuthChallengeEventSchema,
    mcpAuthResultEventSchema,
  ])),
  "cowork/mcp/server/auth/callback": legacyEventEnvelope(mcpAuthResultEventSchema),
  "cowork/mcp/server/auth/setApiKey": legacyEventEnvelope(mcpAuthResultEventSchema),
  "cowork/mcp/legacy/migrate": legacyEventEnvelope(mcpServersEventSchema),
} as const;
