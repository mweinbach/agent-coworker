import { z } from "zod";
import {
  type AgentContextMode,
  type AgentReasoningEffort,
  type AgentRole,
  type AgentTaskType,
  agentContextModeSchema,
  agentReasoningEffortSchema,
  agentRoleSchema,
  agentTaskTypeSchema,
} from "./agents";

export const AGENT_PROFILE_SCOPE_VALUES = ["global", "workspace"] as const;
export type AgentProfileScope = (typeof AGENT_PROFILE_SCOPE_VALUES)[number];

export const agentProfileScopeSchema = z.enum(AGENT_PROFILE_SCOPE_VALUES);

export const agentProfileIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, {
    message: "Use lowercase letters, numbers, dots, dashes, or underscores.",
  });

export const agentProfileStringListSchema = z.array(z.string().trim().min(1).max(160)).default([]);

export const agentProfileDefinitionSchema = z
  .object({
    version: z.literal(1).default(1),
    id: agentProfileIdSchema,
    displayName: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2_000).optional().default(""),
    enabled: z.boolean().default(true),
    baseRole: agentRoleSchema.default("default"),
    prompt: z.string().trim().max(40_000).optional().default(""),
    allowedBuiltInTools: agentProfileStringListSchema,
    allowedMcpServers: agentProfileStringListSchema,
    skillNames: agentProfileStringListSchema,
    model: z.string().trim().min(1).optional(),
    reasoningEffort: agentReasoningEffortSchema.optional(),
    defaultTaskType: agentTaskTypeSchema.optional(),
    defaultContextMode: agentContextModeSchema.optional(),
  })
  .strict();

export type AgentProfileDefinition = z.infer<typeof agentProfileDefinitionSchema>;

export const agentProfileSnapshotSchema = z
  .object({
    id: agentProfileIdSchema,
    ref: z.string().trim().min(1),
    scope: agentProfileScopeSchema,
    displayName: z.string().trim().min(1),
    description: z.string(),
    baseRole: agentRoleSchema,
    prompt: z.string(),
    allowedBuiltInTools: z.array(z.string().trim().min(1)),
    allowedMcpServers: z.array(z.string().trim().min(1)),
    skillNames: z.array(z.string().trim().min(1)),
    model: z.string().trim().min(1).optional(),
    reasoningEffort: agentReasoningEffortSchema.optional(),
    defaultTaskType: agentTaskTypeSchema.optional(),
    defaultContextMode: agentContextModeSchema.optional(),
    resolvedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type AgentProfileSnapshot = z.infer<typeof agentProfileSnapshotSchema>;

export const agentProfileCatalogEntrySchema = z
  .object({
    scope: agentProfileScopeSchema,
    path: z.string().optional(),
    builtIn: z.boolean().optional(),
    locked: z.boolean().optional(),
    effective: z.boolean(),
    shadowed: z.boolean(),
    profile: agentProfileDefinitionSchema,
  })
  .strict();

export type AgentProfileCatalogEntry = z.infer<typeof agentProfileCatalogEntrySchema>;

export const agentProfileDiagnosticSchema = z
  .object({
    scope: agentProfileScopeSchema,
    path: z.string(),
    severity: z.enum(["error", "warning"]),
    message: z.string().trim().min(1),
  })
  .strict();

export type AgentProfileDiagnostic = z.infer<typeof agentProfileDiagnosticSchema>;

export const agentProfilesCatalogSchema = z
  .object({
    profiles: z.array(agentProfileCatalogEntrySchema),
    effectiveProfiles: z.array(agentProfileCatalogEntrySchema),
    diagnostics: z.array(agentProfileDiagnosticSchema),
    roots: z.object({
      globalDir: z.string(),
      workspaceDir: z.string(),
    }),
  })
  .strict();

export type AgentProfilesCatalog = z.infer<typeof agentProfilesCatalogSchema>;

export type AgentProfileRef =
  | { kind: "bare"; id: string }
  | { kind: "scoped"; scope: AgentProfileScope; id: string };

export type AgentProfileUpsertInput = AgentProfileDefinition & {
  scope: AgentProfileScope;
};

export const agentProfileUpsertInputSchema = agentProfileDefinitionSchema.extend({
  scope: agentProfileScopeSchema,
});

export const agentProfileCopyInputSchema = z
  .object({
    sourceRef: z.string().trim().min(1),
    targetScope: agentProfileScopeSchema,
    targetId: agentProfileIdSchema.optional(),
    targetDisplayName: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export type AgentProfileCopyInput = z.infer<typeof agentProfileCopyInputSchema>;

export function normalizeAgentProfileDefinition(input: unknown): AgentProfileDefinition {
  const parsed = agentProfileDefinitionSchema.parse(input);
  return {
    ...parsed,
    allowedBuiltInTools: dedupeStrings(parsed.allowedBuiltInTools),
    allowedMcpServers: dedupeStrings(parsed.allowedMcpServers),
    skillNames: dedupeStrings(parsed.skillNames),
  };
}

export function parseAgentProfileRef(refRaw: string): AgentProfileRef {
  const ref = refRaw.trim();
  if (!ref) {
    throw new Error("profileRef must not be empty");
  }
  const scoped = /^(workspace|global):(.+)$/.exec(ref);
  if (scoped) {
    return {
      kind: "scoped",
      scope: scoped[1] as AgentProfileScope,
      id: agentProfileIdSchema.parse(scoped[2]),
    };
  }
  return {
    kind: "bare",
    id: agentProfileIdSchema.parse(ref),
  };
}

export function buildAgentProfileRef(scope: AgentProfileScope, id: string): string {
  return `${scope}:${id}`;
}

export function createAgentProfileSnapshot(
  scope: AgentProfileScope,
  profile: AgentProfileDefinition,
  resolvedAt = new Date().toISOString(),
): AgentProfileSnapshot {
  return agentProfileSnapshotSchema.parse({
    id: profile.id,
    ref: buildAgentProfileRef(scope, profile.id),
    scope,
    displayName: profile.displayName,
    description: profile.description,
    baseRole: profile.baseRole,
    prompt: profile.prompt,
    allowedBuiltInTools: profile.allowedBuiltInTools,
    allowedMcpServers: profile.allowedMcpServers,
    skillNames: profile.skillNames,
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
    ...(profile.defaultTaskType ? { defaultTaskType: profile.defaultTaskType } : {}),
    ...(profile.defaultContextMode ? { defaultContextMode: profile.defaultContextMode } : {}),
    resolvedAt,
  });
}

export function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

export type AgentProfilePromptSummary = {
  id: string;
  scope: AgentProfileScope;
  displayName: string;
  description: string;
  baseRole: AgentRole;
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
  defaultTaskType?: AgentTaskType;
  defaultContextMode?: AgentContextMode;
};
