import { z } from "zod";

import {
  legacyEventEnvelope,
  nonEmptyTrimmedStringSchema,
  targetScopeSchema,
} from "./schema.shared";

export const skillsCatalogEventSchema = z.object({
  type: z.literal("skills_catalog"),
}).passthrough();

export const skillsListEventSchema = z.object({
  type: z.literal("skills_list"),
  skills: z.array(z.unknown()),
}).passthrough();

export const skillContentEventSchema = z.object({
  type: z.literal("skill_content"),
}).passthrough();

export const skillInstallationEventSchema = z.object({
  type: z.literal("skill_installation"),
}).passthrough();

export const skillInstallPreviewEventSchema = z.object({
  type: z.literal("skill_install_preview"),
}).passthrough();

export const skillInstallUpdateCheckEventSchema = z.object({
  type: z.literal("skill_installation_update_check"),
}).passthrough();

export const jsonRpcSkillsRequestSchemas = {
  "cowork/skills/catalog/read": z.object({
    cwd: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/skills/list": z.object({
    cwd: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/skills/read": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    skillName: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/skills/disable": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    skillName: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/skills/enable": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    skillName: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/skills/delete": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    skillName: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/skills/installation/read": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    installationId: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/skills/install/preview": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    sourceInput: z.string(),
    targetScope: targetScopeSchema,
  }).strict(),
  "cowork/skills/install": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    sourceInput: z.string(),
    targetScope: targetScopeSchema,
  }).strict(),
  "cowork/skills/installation/enable": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    installationId: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/skills/installation/disable": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    installationId: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/skills/installation/delete": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    installationId: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/skills/installation/update": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    installationId: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/skills/installation/copy": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    installationId: nonEmptyTrimmedStringSchema,
    targetScope: targetScopeSchema,
  }).strict(),
  "cowork/skills/installation/checkUpdate": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    installationId: nonEmptyTrimmedStringSchema,
  }).strict(),
} as const;

export const jsonRpcSkillsResultSchemas = {
  "cowork/skills/catalog/read": legacyEventEnvelope(skillsCatalogEventSchema),
  "cowork/skills/list": legacyEventEnvelope(skillsListEventSchema),
  "cowork/skills/read": legacyEventEnvelope(skillContentEventSchema),
  "cowork/skills/disable": legacyEventEnvelope(skillsListEventSchema),
  "cowork/skills/enable": legacyEventEnvelope(skillsListEventSchema),
  "cowork/skills/delete": legacyEventEnvelope(skillsListEventSchema),
  "cowork/skills/installation/read": legacyEventEnvelope(skillInstallationEventSchema),
  "cowork/skills/install/preview": legacyEventEnvelope(skillInstallPreviewEventSchema),
  "cowork/skills/install": legacyEventEnvelope(skillsCatalogEventSchema),
  "cowork/skills/installation/enable": legacyEventEnvelope(skillsCatalogEventSchema),
  "cowork/skills/installation/disable": legacyEventEnvelope(skillsCatalogEventSchema),
  "cowork/skills/installation/delete": legacyEventEnvelope(skillsCatalogEventSchema),
  "cowork/skills/installation/update": legacyEventEnvelope(skillsCatalogEventSchema),
  "cowork/skills/installation/copy": legacyEventEnvelope(skillsCatalogEventSchema),
  "cowork/skills/installation/checkUpdate": legacyEventEnvelope(skillInstallUpdateCheckEventSchema),
} as const;
