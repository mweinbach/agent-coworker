import { z } from "zod";

import {
  jsonRpcControlRequestSchemas,
  jsonRpcControlResultSchemas,
} from "../../shared/jsonrpcControlSchemas";
import { PROVIDER_NAMES } from "../../types";

const conversationImportSourceSchema = z.enum(["codex", "claude-code", "cowork"]);
const conversationSourceRequestSchema = z
  .object({
    source: conversationImportSourceSchema,
    path: z.string().trim().min(1).optional(),
  })
  .strict();
const conversationWarningSchema = z
  .object({
    code: z.enum([
      "missing_cwd",
      "missing_workspace",
      "unsupported_model",
      "truncated",
      "reasoning_redacted",
      "tool_protocol_redacted",
      "parse_partial",
    ]),
    message: z.string(),
  })
  .strict();
const conversationWorkspaceMappingSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("matched"),
      workspaceId: z.string(),
      workspacePath: z.string(),
    })
    .strict(),
  z
    .object({
      status: z.literal("create"),
      workspacePath: z.string(),
      name: z.string(),
    })
    .strict(),
  z
    .object({
      status: z.literal("missing"),
      originalPath: z.string().nullable(),
      reason: z.enum(["path_missing", "no_cwd"]),
    })
    .strict(),
]);
const workspaceMappingInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("existing"),
      workspaceId: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("fallback"),
      workspaceId: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("create"),
      path: z.string().trim().min(1),
      name: z.string().trim().min(1).optional(),
    })
    .strict(),
]);
const selectedConversationSchema = z
  .object({
    source: conversationImportSourceSchema,
    fingerprint: z.string().trim().min(1),
  })
  .strict();

export const jsonRpcImportRequestSchemas = {
  "cowork/import/list": jsonRpcControlRequestSchemas["cowork/import/list"],
  "cowork/import/plugin": jsonRpcControlRequestSchemas["cowork/import/plugin"],
  "cowork/import/skill": jsonRpcControlRequestSchemas["cowork/import/skill"],
  "cowork/conversationImport/sources/list": z
    .object({
      sources: z.array(conversationSourceRequestSchema).optional(),
    })
    .strict()
    .optional()
    .default({}),
  "cowork/conversationImport/preview": z
    .object({
      sources: z.array(conversationSourceRequestSchema).optional(),
      limit: z.number().int().positive().max(1000).optional(),
      includeArchived: z.boolean().optional(),
    })
    .strict()
    .optional()
    .default({}),
  "cowork/conversationImport/import": z
    .object({
      sources: z.array(conversationSourceRequestSchema).optional(),
      selected: z.array(selectedConversationSchema).min(1),
      mappings: z.record(z.string(), workspaceMappingInputSchema).optional(),
      provider: z.enum(PROVIDER_NAMES).optional(),
      model: z.string().trim().min(1).optional(),
      includeArchived: z.boolean().optional(),
    })
    .strict(),
} as const;

const sourceCandidateSchema = z
  .object({
    source: conversationImportSourceSchema,
    id: z.string(),
    path: z.string(),
    available: z.boolean(),
    conversationCount: z.number().int().nonnegative().optional(),
    warning: z.string().optional(),
  })
  .strict();
const conversationPreviewItemSchema = z
  .object({
    source: conversationImportSourceSchema,
    sourceId: z.string(),
    sourcePath: z.string().nullable(),
    fingerprint: z.string(),
    title: z.string(),
    cwd: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    originalProvider: z.string().nullable(),
    originalModel: z.string().nullable(),
    messageCount: z.number().int().nonnegative(),
    toolCount: z.number().int().nonnegative(),
    warnings: z.array(conversationWarningSchema),
    mapping: conversationWorkspaceMappingSchema,
    alreadyImportedThreadId: z.string().nullable(),
  })
  .strict();

export const jsonRpcImportResultSchemas = {
  "cowork/import/list": jsonRpcControlResultSchemas["cowork/import/list"],
  "cowork/import/plugin": jsonRpcControlResultSchemas["cowork/import/plugin"],
  "cowork/import/skill": jsonRpcControlResultSchemas["cowork/import/skill"],
  "cowork/conversationImport/sources/list": z
    .object({
      sources: z.array(sourceCandidateSchema),
    })
    .strict(),
  "cowork/conversationImport/preview": z
    .object({
      conversations: z.array(conversationPreviewItemSchema),
    })
    .strict(),
  "cowork/conversationImport/import": z
    .object({
      imported: z.array(
        z
          .object({
            source: conversationImportSourceSchema,
            fingerprint: z.string(),
            threadId: z.string(),
            workspaceId: z.string().nullable(),
            workspacePath: z.string(),
            title: z.string(),
          })
          .strict(),
      ),
      skipped: z.array(
        z
          .object({
            source: conversationImportSourceSchema,
            fingerprint: z.string(),
            existingThreadId: z.string(),
            reason: z.literal("already_imported"),
          })
          .strict(),
      ),
      failed: z.array(
        z
          .object({
            source: conversationImportSourceSchema,
            fingerprint: z.string(),
            message: z.string(),
          })
          .strict(),
      ),
      createdWorkspaces: z.array(
        z
          .object({
            workspaceId: z.string(),
            path: z.string(),
            name: z.string(),
          })
          .strict(),
      ),
    })
    .strict(),
} as const;
