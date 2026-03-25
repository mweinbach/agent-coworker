import { z } from "zod";

import { GOOGLE_THINKING_LEVEL_VALUES } from "./googleThinking";
import {
  CODEX_WEB_SEARCH_BACKEND_VALUES,
  CODEX_WEB_SEARCH_CONTEXT_SIZE_VALUES,
  CODEX_WEB_SEARCH_MODE_VALUES,
  OPENAI_REASONING_EFFORT_VALUES,
  OPENAI_REASONING_SUMMARY_VALUES,
  OPENAI_TEXT_VERBOSITY_VALUES,
} from "./openaiCompatibleOptions";
import { CHILD_MODEL_ROUTING_MODES, PROVIDER_NAMES } from "../types";

const providerNameSchema = z.enum(PROVIDER_NAMES);
const childModelRoutingModeSchema = z.enum(CHILD_MODEL_ROUTING_MODES);
const nonEmptyTrimmedStringSchema = z.string().trim().min(1);
const optionalNonEmptyTrimmedStringSchema = nonEmptyTrimmedStringSchema.optional();
const anyObjectSchema = z.record(z.string(), z.unknown());
const targetScopeSchema = z.enum(["project", "global"]);
const workspaceMemoryScopeSchema = z.enum(["workspace", "user"]);

export const legacyEventEnvelope = <T extends z.ZodTypeAny>(eventSchema: T) => z.object({
  event: eventSchema,
}).strict();

export const legacyEventsEnvelope = <T extends z.ZodTypeAny>(eventSchema: T) => z.object({
  events: z.array(eventSchema),
}).strict();

const userProfileSchema = z.object({
  instructions: z.string().optional(),
  work: z.string().optional(),
  details: z.string().optional(),
}).passthrough();

const providerOptionsLocationSchema = z.object({
  country: z.string().optional(),
  region: z.string().optional(),
  city: z.string().optional(),
  timezone: z.string().optional(),
}).strict();

const providerOptionsOpenAiSchema = z.object({
  reasoningEffort: z.enum(OPENAI_REASONING_EFFORT_VALUES).optional(),
  reasoningSummary: z.enum(OPENAI_REASONING_SUMMARY_VALUES).optional(),
  textVerbosity: z.enum(OPENAI_TEXT_VERBOSITY_VALUES).optional(),
}).strict();

const providerOptionsCodexSchema = providerOptionsOpenAiSchema.extend({
  webSearchBackend: z.enum(CODEX_WEB_SEARCH_BACKEND_VALUES).optional(),
  webSearchMode: z.enum(CODEX_WEB_SEARCH_MODE_VALUES).optional(),
  webSearch: z.object({
    contextSize: z.enum(CODEX_WEB_SEARCH_CONTEXT_SIZE_VALUES).optional(),
    allowedDomains: z.array(z.string()).optional(),
    location: providerOptionsLocationSchema.optional(),
  }).strict().optional(),
}).strict();

const providerOptionsGoogleSchema = z.object({
  nativeWebSearch: z.boolean().optional(),
  thinkingConfig: z.object({
    thinkingLevel: z.enum(GOOGLE_THINKING_LEVEL_VALUES).optional(),
  }).strict().optional(),
}).strict();

const providerOptionsLmStudioSchema = z.object({
  baseUrl: z.string().optional(),
  contextLength: z.number().int().positive().optional(),
  autoLoad: z.boolean().optional(),
  reloadOnContextMismatch: z.boolean().optional(),
}).strict();

export const editableProviderOptionsSchema = z.object({
  openai: providerOptionsOpenAiSchema.optional(),
  "codex-cli": providerOptionsCodexSchema.optional(),
  google: providerOptionsGoogleSchema.optional(),
  lmstudio: providerOptionsLmStudioSchema.optional(),
}).strict();

export const configUpdatedEventSchema = z.object({
  type: z.literal("config_updated"),
  sessionId: nonEmptyTrimmedStringSchema,
  config: z.object({
    provider: z.string(),
    model: z.string(),
    workingDirectory: z.string(),
    outputDirectory: z.string().optional(),
  }).passthrough(),
}).passthrough();

export const sessionSettingsEventSchema = z.object({
  type: z.literal("session_settings"),
  sessionId: nonEmptyTrimmedStringSchema,
  enableMcp: z.boolean(),
  enableMemory: z.boolean(),
  memoryRequireApproval: z.boolean(),
}).passthrough();

export const sessionConfigEventSchema = z.object({
  type: z.literal("session_config"),
  sessionId: nonEmptyTrimmedStringSchema,
  config: z.object({
    yolo: z.boolean().optional(),
    observabilityEnabled: z.boolean().optional(),
    backupsEnabled: z.boolean().optional(),
    defaultBackupsEnabled: z.boolean().optional(),
    enableMemory: z.boolean().optional(),
    memoryRequireApproval: z.boolean().optional(),
    preferredChildModel: z.string().optional(),
    childModelRoutingMode: childModelRoutingModeSchema.optional(),
    preferredChildModelRef: z.string().optional(),
    allowedChildModelRefs: z.array(z.string()).optional(),
    maxSteps: z.number().int().nonnegative().optional(),
    toolOutputOverflowChars: z.number().int().nullable().optional(),
    defaultToolOutputOverflowChars: z.number().int().nullable().optional(),
    providerOptions: editableProviderOptionsSchema.optional(),
    userName: z.string().optional(),
    userProfile: userProfileSchema.optional(),
  }).passthrough(),
}).passthrough();

export const providerCatalogModelEntrySchema = z.object({
  id: nonEmptyTrimmedStringSchema,
  displayName: z.string(),
  knowledgeCutoff: z.string(),
  supportsImageInput: z.boolean(),
}).strict();

export const providerCatalogEntrySchema = z.object({
  id: providerNameSchema,
  name: z.string(),
  models: z.array(providerCatalogModelEntrySchema),
  defaultModel: z.string(),
  state: z.enum(["ready", "empty", "unreachable"]).optional(),
  message: z.string().optional(),
}).passthrough();

export const providerCatalogEventSchema = z.object({
  type: z.literal("provider_catalog"),
  sessionId: nonEmptyTrimmedStringSchema.optional(),
  all: z.array(providerCatalogEntrySchema),
  default: z.record(z.string(), z.string()),
  connected: z.array(z.string()),
}).passthrough();

export const providerAuthMethodSchema = z.object({
  id: nonEmptyTrimmedStringSchema,
  type: z.enum(["api", "oauth"]),
  label: z.string(),
  oauthMode: z.enum(["auto", "code"]).optional(),
}).passthrough();

export const providerAuthMethodsEventSchema = z.object({
  type: z.literal("provider_auth_methods"),
  sessionId: nonEmptyTrimmedStringSchema.optional(),
  methods: z.record(z.string(), z.array(providerAuthMethodSchema)),
}).passthrough();

export const providerAccountSchema = z.object({
  email: z.string().optional(),
  name: z.string().optional(),
}).passthrough();

export const providerRateLimitWindowSchema = z.object({
  usedPercent: z.number().finite(),
  windowSeconds: z.number().finite(),
  resetAfterSeconds: z.number().finite().optional(),
  resetAt: z.string().optional(),
}).passthrough();

export const providerCreditsSchema = z.object({
  hasCredits: z.boolean(),
  unlimited: z.boolean(),
  balance: z.string().optional(),
}).passthrough();

export const providerRateLimitSnapshotSchema = z.object({
  limitId: z.string().optional(),
  limitName: z.string().optional(),
  allowed: z.boolean().optional(),
  limitReached: z.boolean().optional(),
  primaryWindow: providerRateLimitWindowSchema.nullable().optional(),
  secondaryWindow: providerRateLimitWindowSchema.nullable().optional(),
  credits: providerCreditsSchema.nullable().optional(),
}).passthrough();

export const providerUsageStatusSchema = z.object({
  accountId: z.string().optional(),
  email: z.string().optional(),
  planType: z.string().optional(),
  rateLimits: z.array(providerRateLimitSnapshotSchema),
}).passthrough();

export const providerStatusEntrySchema = z.object({
  provider: providerNameSchema,
  authorized: z.boolean(),
  verified: z.boolean(),
  mode: z.enum(["missing", "error", "api_key", "oauth", "oauth_pending", "local"]),
  account: providerAccountSchema.nullable(),
  message: z.string(),
  checkedAt: z.string(),
  savedApiKeyMasks: z.record(z.string(), z.string()).optional(),
  usage: providerUsageStatusSchema.optional(),
  tokenRecoverable: z.boolean().optional(),
}).passthrough();

export const providerStatusEventSchema = z.object({
  type: z.literal("provider_status"),
  sessionId: nonEmptyTrimmedStringSchema.optional(),
  providers: z.array(providerStatusEntrySchema),
}).passthrough();

export const providerAuthChallengeSchema = z.object({
  method: z.enum(["auto", "code"]),
  instructions: z.string(),
  url: z.string().optional(),
  command: z.string().optional(),
}).passthrough();

export const providerAuthChallengeEventSchema = z.object({
  type: z.literal("provider_auth_challenge"),
  sessionId: nonEmptyTrimmedStringSchema.optional(),
  provider: providerNameSchema,
  methodId: nonEmptyTrimmedStringSchema,
  challenge: providerAuthChallengeSchema,
}).passthrough();

export const providerAuthResultEventSchema = z.object({
  type: z.literal("provider_auth_result"),
  sessionId: nonEmptyTrimmedStringSchema.optional(),
  provider: providerNameSchema,
  methodId: nonEmptyTrimmedStringSchema,
  ok: z.boolean(),
  mode: z.enum(["api_key", "oauth", "oauth_pending"]).optional(),
  message: z.string(),
}).passthrough();

export const mcpServerTransportSchema = z.union([
  z.object({
    type: z.literal("stdio"),
    command: nonEmptyTrimmedStringSchema,
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
  }).strict(),
  z.object({
    type: z.union([z.literal("http"), z.literal("sse")]),
    url: nonEmptyTrimmedStringSchema,
    headers: z.record(z.string(), z.string()).optional(),
  }).strict(),
]);

export const mcpServerAuthConfigSchema = z.union([
  z.object({
    type: z.literal("none"),
  }).strict(),
  z.object({
    type: z.literal("api_key"),
    headerName: z.string().optional(),
    prefix: z.string().optional(),
    keyId: z.string().optional(),
  }).strict(),
  z.object({
    type: z.literal("oauth"),
    scope: z.string().optional(),
    resource: z.string().optional(),
    oauthMode: z.enum(["auto", "code"]).optional(),
  }).strict(),
]);

export const mcpServerConfigSchema = z.object({
  name: nonEmptyTrimmedStringSchema,
  transport: mcpServerTransportSchema,
  required: z.boolean().optional(),
  retries: z.number().int().nonnegative().optional(),
  auth: mcpServerAuthConfigSchema.optional(),
}).passthrough();

export const mcpServerEventSourceSchema = z.enum([
  "workspace",
  "user",
  "system",
  "workspace_legacy",
  "user_legacy",
]);

export const mcpServerAuthModeSchema = z.enum([
  "none",
  "missing",
  "api_key",
  "oauth",
  "oauth_pending",
  "error",
]);

export const mcpServersEventSchema = z.object({
  type: z.literal("mcp_servers"),
  sessionId: nonEmptyTrimmedStringSchema.optional(),
  servers: z.array(mcpServerConfigSchema.extend({
    source: mcpServerEventSourceSchema,
    inherited: z.boolean(),
    authMode: mcpServerAuthModeSchema,
    authScope: z.enum(["workspace", "user"]),
    authMessage: z.string(),
  }).passthrough()),
  legacy: z.object({
    workspace: z.object({
      path: z.string(),
      exists: z.boolean(),
    }).strict(),
    user: z.object({
      path: z.string(),
      exists: z.boolean(),
    }).strict(),
  }).strict(),
  files: z.array(z.object({
    source: mcpServerEventSourceSchema,
    path: z.string(),
    exists: z.boolean(),
    editable: z.boolean(),
    legacy: z.boolean(),
    parseError: z.string().optional(),
    serverCount: z.number().int().nonnegative(),
  }).strict()),
  warnings: z.array(z.string()).optional(),
}).passthrough();

export const mcpValidationEventSchema = z.object({
  type: z.literal("mcp_server_validation"),
  sessionId: nonEmptyTrimmedStringSchema.optional(),
  name: nonEmptyTrimmedStringSchema,
  ok: z.boolean(),
  mode: mcpServerAuthModeSchema,
  message: z.string(),
  toolCount: z.number().int().nonnegative().optional(),
  tools: z.array(z.object({
    name: nonEmptyTrimmedStringSchema,
    description: z.string().optional(),
  }).strict()).optional(),
  latencyMs: z.number().nonnegative().optional(),
}).passthrough();

export const mcpAuthChallengeEventSchema = z.object({
  type: z.literal("mcp_server_auth_challenge"),
  sessionId: nonEmptyTrimmedStringSchema.optional(),
  name: nonEmptyTrimmedStringSchema,
  challenge: z.object({
    method: z.enum(["auto", "code"]),
    instructions: z.string(),
    url: z.string().optional(),
    expiresAt: z.string().optional(),
  }).passthrough(),
}).passthrough();

export const mcpAuthResultEventSchema = z.object({
  type: z.literal("mcp_server_auth_result"),
  sessionId: nonEmptyTrimmedStringSchema.optional(),
  name: nonEmptyTrimmedStringSchema,
  ok: z.boolean(),
  mode: mcpServerAuthModeSchema.optional(),
  message: z.string(),
}).passthrough();

export const memoryEntrySchema = z.object({
  id: nonEmptyTrimmedStringSchema,
  scope: workspaceMemoryScopeSchema,
  content: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).passthrough();

export const memoryListEventSchema = z.object({
  type: z.literal("memory_list"),
  sessionId: nonEmptyTrimmedStringSchema.optional(),
  memories: z.array(memoryEntrySchema),
}).passthrough();

const skillSourceSchema = z.enum(["project", "user", "global", "built-in"]);
const skillInstallStateSchema = z.enum(["effective", "shadowed", "disabled", "invalid"]);
const skillInstallOriginKindSchema = z.enum(["github", "skills.sh", "local", "manual", "bootstrap", "unknown"]);
const skillDescriptionSourceSchema = z.enum(["frontmatter", "directory", "unknown"]);
const skillDiagnosticSeveritySchema = z.enum(["info", "warning", "error"]);

const skillInterfaceSchema = z.object({
  displayName: z.string().optional(),
  shortDescription: z.string().optional(),
  iconSmall: z.string().optional(),
  iconLarge: z.string().optional(),
  defaultPrompt: z.string().optional(),
  agents: z.array(z.string()).optional(),
}).passthrough();

export const skillEntrySchema = z.object({
  name: nonEmptyTrimmedStringSchema,
  path: z.string(),
  source: skillSourceSchema,
  enabled: z.boolean(),
  triggers: z.array(z.string()),
  description: z.string(),
  interface: skillInterfaceSchema.optional(),
}).passthrough();

const skillInstallOriginSchema = z.object({
  kind: skillInstallOriginKindSchema,
  url: z.string().optional(),
  repo: z.string().optional(),
  ref: z.string().optional(),
  subdir: z.string().optional(),
  sourcePath: z.string().optional(),
  sourceHash: z.string().optional(),
}).passthrough();

const skillInstallManifestSchema = z.object({
  version: z.literal(1),
  installationId: nonEmptyTrimmedStringSchema,
  installedAt: z.string(),
  updatedAt: z.string(),
  origin: skillInstallOriginSchema.optional(),
}).passthrough();

const skillInstallationDiagnosticSchema = z.object({
  code: z.string(),
  severity: skillDiagnosticSeveritySchema,
  message: z.string(),
}).strict();

const skillScopeDescriptorSchema = z.object({
  scope: skillSourceSchema,
  skillsDir: z.string(),
  disabledSkillsDir: z.string().optional(),
  writable: z.boolean(),
  readable: z.boolean(),
}).strict();

export const skillInstallationEntrySchema = z.object({
  installationId: nonEmptyTrimmedStringSchema,
  name: nonEmptyTrimmedStringSchema,
  description: z.string(),
  scope: skillSourceSchema,
  enabled: z.boolean(),
  writable: z.boolean(),
  managed: z.boolean(),
  effective: z.boolean(),
  state: skillInstallStateSchema,
  rootDir: z.string(),
  skillPath: z.string().nullable(),
  manifestPath: z.string().optional(),
  path: z.string(),
  triggers: z.array(z.string()),
  descriptionSource: skillDescriptionSourceSchema,
  interface: skillInterfaceSchema.optional(),
  diagnostics: z.array(skillInstallationDiagnosticSchema),
  origin: skillInstallOriginSchema.optional(),
  manifest: skillInstallManifestSchema.optional(),
  shadowedByInstallationId: z.string().optional(),
  shadowedByScope: skillSourceSchema.optional(),
  installedAt: z.string().optional(),
  updatedAt: z.string().optional(),
  fileModifiedAt: z.string().optional(),
}).passthrough();

export const skillCatalogSnapshotSchema = z.object({
  scopes: z.array(skillScopeDescriptorSchema),
  effectiveSkills: z.array(skillInstallationEntrySchema),
  installations: z.array(skillInstallationEntrySchema),
}).strict();

const skillSourceDescriptorSchema = z.object({
  kind: z.enum([
    "skills.sh",
    "github_repo",
    "github_tree",
    "github_blob",
    "github_raw",
    "github_shorthand",
    "local_path",
  ]),
  raw: z.string(),
  displaySource: z.string(),
  url: z.string().optional(),
  repo: z.string().optional(),
  ref: z.string().optional(),
  subdir: z.string().optional(),
  refPath: z.string().optional(),
  localPath: z.string().optional(),
  requestedSkillName: z.string().optional(),
}).passthrough();

const skillInstallPreviewCandidateSchema = z.object({
  name: nonEmptyTrimmedStringSchema,
  description: z.string(),
  relativeRootPath: z.string(),
  conflictsWithInstallationId: z.string().optional(),
  conflictsWithScope: skillSourceSchema.optional(),
  wouldBeEffective: z.boolean(),
  shadowedInstallationIds: z.array(z.string()),
  diagnostics: z.array(skillInstallationDiagnosticSchema),
}).strict();

export const skillInstallPreviewSchema = z.object({
  source: skillSourceDescriptorSchema,
  targetScope: targetScopeSchema,
  candidates: z.array(skillInstallPreviewCandidateSchema),
  warnings: z.array(z.string()),
}).strict();

export const skillUpdateCheckResultSchema = z.object({
  installationId: nonEmptyTrimmedStringSchema,
  canUpdate: z.boolean(),
  reason: z.string().optional(),
  preview: skillInstallPreviewSchema.optional(),
}).strict();

export const skillsListEventSchema = z.object({
  type: z.literal("skills_list"),
  sessionId: nonEmptyTrimmedStringSchema.optional(),
  skills: z.array(skillEntrySchema),
}).passthrough();

export const skillsCatalogEventSchema = z.object({
  type: z.literal("skills_catalog"),
  sessionId: nonEmptyTrimmedStringSchema.optional(),
  catalog: skillCatalogSnapshotSchema,
  mutationBlocked: z.boolean(),
  clearedMutationPendingKeys: z.array(z.string()).optional(),
  mutationBlockedReason: z.string().optional(),
}).passthrough();

export const skillContentEventSchema = z.object({
  type: z.literal("skill_content"),
  sessionId: nonEmptyTrimmedStringSchema.optional(),
  skill: skillEntrySchema,
  content: z.string(),
}).passthrough();

export const skillInstallationEventSchema = z.object({
  type: z.literal("skill_installation"),
  sessionId: nonEmptyTrimmedStringSchema.optional(),
  installation: skillInstallationEntrySchema.nullable(),
  content: z.string().nullable().optional(),
}).passthrough();

export const skillInstallPreviewEventSchema = z.object({
  type: z.literal("skill_install_preview"),
  sessionId: nonEmptyTrimmedStringSchema.optional(),
  preview: skillInstallPreviewSchema,
  fromUserPreviewRequest: z.boolean().optional(),
}).passthrough();

export const skillInstallUpdateCheckEventSchema = z.object({
  type: z.literal("skill_installation_update_check"),
  sessionId: nonEmptyTrimmedStringSchema.optional(),
  result: skillUpdateCheckResultSchema,
}).passthrough();

export const sessionBackupPublicCheckpointSchema = z.object({
  id: nonEmptyTrimmedStringSchema,
  index: z.number().int().positive(),
  createdAt: z.string(),
  trigger: z.enum(["initial", "auto", "manual"]),
  changed: z.boolean(),
  patchBytes: z.number().int().nonnegative(),
}).strict();

export const workspaceBackupEntrySchema = z.object({
  targetSessionId: nonEmptyTrimmedStringSchema,
  title: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  lifecycle: z.enum(["active", "closed", "deleted"]),
  status: z.enum(["initializing", "ready", "disabled", "failed"]),
  workingDirectory: z.string(),
  backupDirectory: z.string().nullable(),
  originalSnapshotKind: z.enum(["pending", "directory", "tar_gz"]),
  originalSnapshotBytes: z.number().int().nonnegative().nullable(),
  checkpointBytesTotal: z.number().int().nonnegative().nullable(),
  totalBytes: z.number().int().nonnegative().nullable(),
  checkpoints: z.array(sessionBackupPublicCheckpointSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().optional(),
  failureReason: z.string().optional(),
}).passthrough();

export const workspaceBackupsEventSchema = z.object({
  type: z.literal("workspace_backups"),
  sessionId: nonEmptyTrimmedStringSchema.optional(),
  workspacePath: z.string(),
  backups: z.array(workspaceBackupEntrySchema),
}).passthrough();

export const workspaceBackupDeltaFileSchema = z.object({
  path: z.string(),
  change: z.enum(["added", "modified", "deleted"]),
  kind: z.enum(["file", "directory", "symlink"]),
}).strict();

export const workspaceBackupDeltaEventSchema = z.object({
  type: z.literal("workspace_backup_delta"),
  sessionId: nonEmptyTrimmedStringSchema.optional(),
  targetSessionId: nonEmptyTrimmedStringSchema,
  checkpointId: nonEmptyTrimmedStringSchema,
  baselineLabel: z.string(),
  currentLabel: z.string(),
  counts: z.object({
    added: z.number().int().nonnegative(),
    modified: z.number().int().nonnegative(),
    deleted: z.number().int().nonnegative(),
  }).strict(),
  files: z.array(workspaceBackupDeltaFileSchema),
  truncated: z.boolean(),
}).passthrough();

export const providerCatalogReadRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
}).strict();

export const providerAuthMethodsReadRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
}).strict();

export const providerStatusRefreshRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
}).strict();

export const providerAuthAuthorizeRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
  provider: providerNameSchema,
  methodId: nonEmptyTrimmedStringSchema,
}).strict();

export const providerAuthLogoutRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
  provider: providerNameSchema,
}).strict();

export const providerAuthCallbackRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
  provider: providerNameSchema,
  methodId: nonEmptyTrimmedStringSchema,
  code: z.string().optional(),
}).strict();

export const providerAuthSetApiKeyRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
  provider: providerNameSchema,
  methodId: nonEmptyTrimmedStringSchema,
  apiKey: z.string(),
}).strict();

export const providerAuthCopyApiKeyRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
  provider: providerNameSchema,
  sourceProvider: providerNameSchema,
}).strict();

export const mcpServersReadRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
}).strict();

export const mcpServerUpsertRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
  server: mcpServerConfigSchema,
  previousName: z.string().optional(),
}).strict();

export const mcpServerDeleteRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
  name: nonEmptyTrimmedStringSchema,
}).strict();

export const mcpServerValidateRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
  name: nonEmptyTrimmedStringSchema,
}).strict();

export const mcpServerAuthAuthorizeRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
  name: nonEmptyTrimmedStringSchema,
}).strict();

export const mcpServerAuthCallbackRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
  name: nonEmptyTrimmedStringSchema,
  code: z.string().optional(),
}).strict();

export const mcpServerAuthSetApiKeyRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
  name: nonEmptyTrimmedStringSchema,
  apiKey: z.string(),
}).strict();

export const mcpLegacyMigrateRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
  scope: z.enum(["workspace", "user"]),
}).strict();

export const skillsCatalogReadRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
}).strict();

export const skillsListRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
}).strict();

export const skillsReadRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
  skillName: nonEmptyTrimmedStringSchema,
}).strict();

export const skillsMutationRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
  skillName: nonEmptyTrimmedStringSchema,
}).strict();

export const skillInstallationReadRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
  installationId: nonEmptyTrimmedStringSchema,
}).strict();

export const skillsInstallPreviewRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
  sourceInput: z.string(),
  targetScope: targetScopeSchema,
}).strict();

export const skillsInstallRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
  sourceInput: z.string(),
  targetScope: targetScopeSchema,
}).strict();

export const skillInstallationMutationRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
  installationId: nonEmptyTrimmedStringSchema,
}).strict();

export const skillInstallationCopyRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
  installationId: nonEmptyTrimmedStringSchema,
  targetScope: targetScopeSchema,
}).strict();

export const memoryListRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
  scope: workspaceMemoryScopeSchema.optional(),
}).strict();

export const memoryUpsertRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
  scope: workspaceMemoryScopeSchema,
  id: z.string().optional(),
  content: z.string(),
}).strict();

export const memoryDeleteRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
  scope: workspaceMemoryScopeSchema,
  id: nonEmptyTrimmedStringSchema,
}).strict();

export const workspaceBackupsReadRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
}).strict();

export const workspaceBackupsDeltaReadRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
  targetSessionId: nonEmptyTrimmedStringSchema,
  checkpointId: nonEmptyTrimmedStringSchema,
}).strict();

export const workspaceBackupsCheckpointRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
  targetSessionId: nonEmptyTrimmedStringSchema,
}).strict();

export const workspaceBackupsRestoreRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
  targetSessionId: nonEmptyTrimmedStringSchema,
  checkpointId: z.string().optional(),
}).strict();

export const workspaceBackupsDeleteCheckpointRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
  targetSessionId: nonEmptyTrimmedStringSchema,
  checkpointId: nonEmptyTrimmedStringSchema,
}).strict();

export const workspaceBackupsDeleteEntryRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
  targetSessionId: nonEmptyTrimmedStringSchema,
}).strict();

export const sessionStateReadRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
}).strict();

export const sessionDefaultsApplyRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
  threadId: optionalNonEmptyTrimmedStringSchema,
  provider: providerNameSchema.optional(),
  model: optionalNonEmptyTrimmedStringSchema,
  enableMcp: z.boolean().optional(),
  config: z.object({
    backupsEnabled: z.boolean().optional(),
    toolOutputOverflowChars: z.number().int().nullable().optional(),
    clearToolOutputOverflowChars: z.boolean().optional(),
    preferredChildModel: z.string().optional(),
    childModelRoutingMode: childModelRoutingModeSchema.optional(),
    preferredChildModelRef: z.string().optional(),
    allowedChildModelRefs: z.array(z.string()).optional(),
    providerOptions: editableProviderOptionsSchema.optional(),
    userName: z.string().optional(),
    userProfile: userProfileSchema.optional(),
  }).passthrough().optional(),
}).strict();

export const jsonRpcControlRequestSchemas = {
  "cowork/provider/catalog/read": providerCatalogReadRequestSchema,
  "cowork/provider/authMethods/read": providerAuthMethodsReadRequestSchema,
  "cowork/provider/status/refresh": providerStatusRefreshRequestSchema,
  "cowork/provider/auth/authorize": providerAuthAuthorizeRequestSchema,
  "cowork/provider/auth/logout": providerAuthLogoutRequestSchema,
  "cowork/provider/auth/callback": providerAuthCallbackRequestSchema,
  "cowork/provider/auth/setApiKey": providerAuthSetApiKeyRequestSchema,
  "cowork/provider/auth/copyApiKey": providerAuthCopyApiKeyRequestSchema,
  "cowork/mcp/servers/read": mcpServersReadRequestSchema,
  "cowork/mcp/server/upsert": mcpServerUpsertRequestSchema,
  "cowork/mcp/server/delete": mcpServerDeleteRequestSchema,
  "cowork/mcp/server/validate": mcpServerValidateRequestSchema,
  "cowork/mcp/server/auth/authorize": mcpServerAuthAuthorizeRequestSchema,
  "cowork/mcp/server/auth/callback": mcpServerAuthCallbackRequestSchema,
  "cowork/mcp/server/auth/setApiKey": mcpServerAuthSetApiKeyRequestSchema,
  "cowork/mcp/legacy/migrate": mcpLegacyMigrateRequestSchema,
  "cowork/skills/catalog/read": skillsCatalogReadRequestSchema,
  "cowork/skills/list": skillsListRequestSchema,
  "cowork/skills/read": skillsReadRequestSchema,
  "cowork/skills/disable": skillsMutationRequestSchema,
  "cowork/skills/enable": skillsMutationRequestSchema,
  "cowork/skills/delete": skillsMutationRequestSchema,
  "cowork/skills/installation/read": skillInstallationReadRequestSchema,
  "cowork/skills/install/preview": skillsInstallPreviewRequestSchema,
  "cowork/skills/install": skillsInstallRequestSchema,
  "cowork/skills/installation/enable": skillInstallationMutationRequestSchema,
  "cowork/skills/installation/disable": skillInstallationMutationRequestSchema,
  "cowork/skills/installation/delete": skillInstallationMutationRequestSchema,
  "cowork/skills/installation/update": skillInstallationMutationRequestSchema,
  "cowork/skills/installation/copy": skillInstallationCopyRequestSchema,
  "cowork/skills/installation/checkUpdate": skillInstallationMutationRequestSchema,
  "cowork/memory/list": memoryListRequestSchema,
  "cowork/memory/upsert": memoryUpsertRequestSchema,
  "cowork/memory/delete": memoryDeleteRequestSchema,
  "cowork/backups/workspace/read": workspaceBackupsReadRequestSchema,
  "cowork/backups/workspace/delta/read": workspaceBackupsDeltaReadRequestSchema,
  "cowork/backups/workspace/checkpoint": workspaceBackupsCheckpointRequestSchema,
  "cowork/backups/workspace/restore": workspaceBackupsRestoreRequestSchema,
  "cowork/backups/workspace/deleteCheckpoint": workspaceBackupsDeleteCheckpointRequestSchema,
  "cowork/backups/workspace/deleteEntry": workspaceBackupsDeleteEntryRequestSchema,
  "cowork/session/state/read": sessionStateReadRequestSchema,
  "cowork/session/defaults/apply": sessionDefaultsApplyRequestSchema,
} as const;

export const jsonRpcControlResultSchemas = {
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
  "cowork/memory/list": legacyEventEnvelope(memoryListEventSchema),
  "cowork/memory/upsert": legacyEventEnvelope(memoryListEventSchema),
  "cowork/memory/delete": legacyEventEnvelope(memoryListEventSchema),
  "cowork/backups/workspace/read": legacyEventEnvelope(workspaceBackupsEventSchema),
  "cowork/backups/workspace/delta/read": legacyEventEnvelope(workspaceBackupDeltaEventSchema),
  "cowork/backups/workspace/checkpoint": legacyEventEnvelope(workspaceBackupsEventSchema),
  "cowork/backups/workspace/restore": legacyEventEnvelope(workspaceBackupsEventSchema),
  "cowork/backups/workspace/deleteCheckpoint": legacyEventEnvelope(workspaceBackupsEventSchema),
  "cowork/backups/workspace/deleteEntry": legacyEventEnvelope(workspaceBackupsEventSchema),
  "cowork/session/state/read": legacyEventsEnvelope(z.union([
    configUpdatedEventSchema,
    sessionSettingsEventSchema,
    sessionConfigEventSchema,
  ])),
  "cowork/session/defaults/apply": legacyEventEnvelope(sessionConfigEventSchema),
} as const;

export type JsonRpcControlRequestMethod = keyof typeof jsonRpcControlRequestSchemas;
export type JsonRpcControlResultMethod = keyof typeof jsonRpcControlResultSchemas;
export type JsonRpcControlRequest<M extends JsonRpcControlRequestMethod> = z.input<(typeof jsonRpcControlRequestSchemas)[M]>;
export type JsonRpcControlResult<M extends JsonRpcControlResultMethod> = z.output<(typeof jsonRpcControlResultSchemas)[M]>;

export type ProviderCatalogEntry = z.infer<typeof providerCatalogEntrySchema>;
export type ProviderAuthMethod = z.infer<typeof providerAuthMethodSchema>;
export type ProviderStatusEntry = z.infer<typeof providerStatusEntrySchema>;
export type McpServerEntry = z.infer<typeof mcpServersEventSchema.shape.servers.element>;
export type McpServerValidation = z.infer<typeof mcpValidationEventSchema>;
export type SkillEntry = z.infer<typeof skillEntrySchema>;
export type SkillInstallationEntry = z.infer<typeof skillInstallationEntrySchema>;
export type SkillCatalogSnapshot = z.infer<typeof skillCatalogSnapshotSchema>;
export type SkillInstallPreview = z.infer<typeof skillInstallPreviewSchema>;
export type SkillUpdateCheckResult = z.infer<typeof skillUpdateCheckResultSchema>;
export type MemoryEntry = z.infer<typeof memoryEntrySchema>;
export type WorkspaceBackupEntry = z.infer<typeof workspaceBackupEntrySchema>;
export type WorkspaceControlStateEvents = z.infer<typeof jsonRpcControlResultSchemas["cowork/session/state/read"]>;
