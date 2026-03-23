import { z } from "zod";

import {
  legacyEventEnvelope,
  nonEmptyTrimmedStringSchema,
} from "./schema.shared";

export const workspaceBackupsEventSchema = z.object({
  type: z.literal("workspace_backups"),
  workspacePath: z.string(),
  backups: z.array(z.unknown()),
}).passthrough();

export const workspaceBackupDeltaEventSchema = z.object({
  type: z.literal("workspace_backup_delta"),
}).passthrough();

export const jsonRpcBackupsRequestSchemas = {
  "cowork/backups/workspace/read": z.object({
    cwd: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/backups/workspace/delta/read": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    targetSessionId: nonEmptyTrimmedStringSchema,
    checkpointId: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/backups/workspace/checkpoint": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    targetSessionId: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/backups/workspace/restore": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    targetSessionId: nonEmptyTrimmedStringSchema,
    checkpointId: z.string().optional(),
  }).strict(),
  "cowork/backups/workspace/deleteCheckpoint": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    targetSessionId: nonEmptyTrimmedStringSchema,
    checkpointId: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/backups/workspace/deleteEntry": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    targetSessionId: nonEmptyTrimmedStringSchema,
  }).strict(),
} as const;

export const jsonRpcBackupsResultSchemas = {
  "cowork/backups/workspace/read": legacyEventEnvelope(workspaceBackupsEventSchema),
  "cowork/backups/workspace/delta/read": legacyEventEnvelope(workspaceBackupDeltaEventSchema),
  "cowork/backups/workspace/checkpoint": legacyEventEnvelope(workspaceBackupsEventSchema),
  "cowork/backups/workspace/restore": legacyEventEnvelope(workspaceBackupsEventSchema),
  "cowork/backups/workspace/deleteCheckpoint": legacyEventEnvelope(workspaceBackupsEventSchema),
  "cowork/backups/workspace/deleteEntry": legacyEventEnvelope(workspaceBackupsEventSchema),
} as const;
