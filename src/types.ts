import { z } from "zod";

export const PROVIDER_NAMES = [
  "google",
  "openai",
  "aws-bedrock-proxy",
  "anthropic",
  "baseten",
  "together",
  "fireworks",
  "nvidia",
  "lmstudio",
  "opencode-go",
  "opencode-zen",
  "codex-cli",
] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];
const providerNameSchema = z.enum(PROVIDER_NAMES);
const LEGACY_PROVIDER_ALIASES: Record<string, ProviderName> = {
  "openai-proxy": "aws-bedrock-proxy",
};

export const CHILD_MODEL_ROUTING_MODES = [
  "same-provider",
  "cross-provider-allowlist",
] as const;

export type ChildModelRoutingMode = (typeof CHILD_MODEL_ROUTING_MODES)[number];
const childModelRoutingModeSchema = z.enum(CHILD_MODEL_ROUTING_MODES);

export type ModelMessage = {
  role: "system" | "user" | "assistant" | "tool" | (string & {});
  content: unknown;
  [key: string]: unknown;
};

export function isProviderName(v: unknown): v is ProviderName {
  return providerNameSchema.safeParse(v).success;
}

export function resolveProviderName(v: unknown): ProviderName | null {
  if (typeof v === "string") {
    const alias = LEGACY_PROVIDER_ALIASES[v.trim().toLowerCase()];
    if (alias) return alias;
  }
  const parsed = providerNameSchema.safeParse(v);
  return parsed.success ? parsed.data : null;
}

export function isChildModelRoutingMode(v: unknown): v is ChildModelRoutingMode {
  return childModelRoutingModeSchema.safeParse(v).success;
}

export function resolveChildModelRoutingMode(v: unknown): ChildModelRoutingMode | null {
  const parsed = childModelRoutingModeSchema.safeParse(v);
  return parsed.success ? parsed.data : null;
}

export const RUNTIME_NAMES = [
  "pi",
  "openai-responses",
  "google-interactions",
] as const;

export type RuntimeName = (typeof RUNTIME_NAMES)[number];
const runtimeNameSchema = z.enum(RUNTIME_NAMES);

export function resolveRuntimeName(v: unknown): RuntimeName | null {
  const parsed = runtimeNameSchema.safeParse(v);
  return parsed.success ? parsed.data : null;
}

export function defaultRuntimeNameForProvider(provider: ProviderName): RuntimeName {
  if (provider === "openai" || provider === "codex-cli") {
    return "openai-responses";
  }
  if (provider === "google") {
    return "google-interactions";
  }
  return "pi";
}

export function normalizeRuntimeNameForProvider(
  provider: ProviderName,
  runtime: RuntimeName | null | undefined,
): RuntimeName {
  if (provider === "openai" || provider === "codex-cli") {
    return "openai-responses";
  }
  if (provider === "google") {
    return "google-interactions";
  }
  if (runtime === "openai-responses" || runtime === "google-interactions") {
    return defaultRuntimeNameForProvider(provider);
  }
  return runtime ?? defaultRuntimeNameForProvider(provider);
}

export type CommandSource = "command" | "mcp" | "skill";

export interface CommandInfo {
  name: string;
  description?: string;
  source: CommandSource;
  hints: string[];
}

export interface CommandTemplateConfig {
  description?: string;
  template: string;
  source?: CommandSource;
}

export interface ModelRuntimeSettings {
  maxRetries?: number;
}

export interface UserProfile {
  instructions?: string;
  work?: string;
  details?: string;
}

export interface AgentConfig {
  provider: ProviderName;
  runtime?: RuntimeName;
  model: string;
  preferredChildModel: string;
  childModelRoutingMode?: ChildModelRoutingMode;
  preferredChildModelRef?: string;
  allowedChildModelRefs?: string[];
  toolOutputOverflowChars?: number | null;
  /**
   * Effective non-project fallback for tool overflow spilling after built-in
   * and user config layers are merged, before workspace overrides apply.
   */
  inheritedToolOutputOverflowChars?: number | null;
  /**
   * Raw workspace-scoped overrides that were explicitly present in the
   * project `.agent/config.json`, before built-in defaults were materialized.
   */
  projectConfigOverrides?: {
    toolOutputOverflowChars?: number | null;
  };

  workingDirectory: string;
  outputDirectory?: string;
  uploadsDirectory?: string;

  userName: string;
  userProfile?: UserProfile;
  knowledgeCutoff: string;

  projectAgentDir: string;
  userAgentDir: string;
  builtInDir: string;
  builtInConfigDir: string;

  skillsDirs: string[];
  memoryDirs: string[];
  configDirs: string[];

  /**
   * Optional provider-specific options forwarded to runtime model calls.
   */
  providerOptions?: Record<string, any>;

  /**
   * Optional base URL for AWS Bedrock Proxy discovery and auth validation.
   */
  awsBedrockProxyBaseUrl?: string;
  /**
   * @deprecated Legacy alias accepted while migrating from openai-proxy.
   */
  openaiProxyBaseUrl?: string;

  /**
   * Optional runtime controls for model calls.
   */
  modelSettings?: ModelRuntimeSettings;

  /**
   * Whether to enable MCP (Model Context Protocol) tool discovery/execution.
   * Defaults to true when not specified.
   */
  enableMcp?: boolean;

  /**
   * Whether memory tool + prompt memory injection are enabled.
   * Defaults to true when not specified.
   */
  enableMemory?: boolean;

  /**
   * Whether model-requested memory writes require explicit user approval.
   * Defaults to false when not specified.
   */
  memoryRequireApproval?: boolean;

  /**
   * Whether to include raw model stream chunks in emitted stream events.
   * Defaults to true when not specified.
   */
  includeRawChunks?: boolean;

  /**
   * Whether workspace/session backups are enabled.
   * Defaults to true when not specified.
   */
  backupsEnabled?: boolean;

  /**
   * Whether Langfuse observability integration is enabled for this session/run.
   * Defaults to false when not specified.
   */
  observabilityEnabled?: boolean;

  /**
   * Optional Langfuse observability endpoint and runtime settings.
   */
  observability?: ObservabilityConfig;

  /**
   * Optional harness policy flags.
   */
  harness?: HarnessConfig;

  /**
   * Optional command templates exposed to slash command execution.
   * Keys are command names and values include template and metadata.
   */
  command?: Record<string, CommandTemplateConfig>;
}

export interface SkillEntry {
  name: string;
  path: string;
  source: "project" | "user" | "global" | "built-in";
  enabled: boolean;
  triggers: string[];
  description: string;
  interface?: {
    displayName?: string;
    shortDescription?: string;
    iconSmall?: string; // data: URI (best-effort)
    iconLarge?: string; // data: URI (best-effort)
    defaultPrompt?: string;
    agents?: string[];
  };
}

export type SkillScope = SkillEntry["source"];

export type SkillMutationTargetScope = "project" | "global";

export type SkillInstallState = "effective" | "shadowed" | "disabled" | "invalid";

export type SkillInstallOriginKind = "github" | "skills.sh" | "local" | "manual" | "bootstrap" | "unknown";

export interface SkillInstallOrigin {
  kind: SkillInstallOriginKind;
  url?: string;
  repo?: string;
  ref?: string;
  subdir?: string;
  sourcePath?: string;
  sourceHash?: string;
}

export interface SkillInstallManifest {
  version: 1;
  installationId: string;
  installedAt: string;
  updatedAt: string;
  origin?: SkillInstallOrigin;
}

export type SkillInstallationDiagnosticSeverity = "info" | "warning" | "error";

export interface SkillInstallationDiagnostic {
  code: string;
  severity: SkillInstallationDiagnosticSeverity;
  message: string;
}

export interface SkillScopeDescriptor {
  scope: SkillScope;
  skillsDir: string;
  disabledSkillsDir?: string;
  writable: boolean;
  readable: boolean;
}

export interface SkillInstallationEntry {
  installationId: string;
  name: string;
  description: string;
  scope: SkillScope;
  enabled: boolean;
  writable: boolean;
  managed: boolean;
  effective: boolean;
  state: SkillInstallState;
  rootDir: string;
  skillPath: string | null;
  manifestPath?: string;
  path: string;
  triggers: string[];
  descriptionSource: "frontmatter" | "directory" | "unknown";
  interface?: SkillEntry["interface"];
  diagnostics: SkillInstallationDiagnostic[];
  origin?: SkillInstallOrigin;
  manifest?: SkillInstallManifest;
  shadowedByInstallationId?: string;
  shadowedByScope?: SkillScope;
  installedAt?: string;
  updatedAt?: string;
  fileModifiedAt?: string;
}

export interface SkillCatalogSnapshot {
  scopes: SkillScopeDescriptor[];
  effectiveSkills: SkillInstallationEntry[];
  installations: SkillInstallationEntry[];
}

export type SkillSourceInputKind =
  | "skills.sh"
  | "github_repo"
  | "github_tree"
  | "github_blob"
  | "github_raw"
  | "github_shorthand"
  | "local_path";

export interface SkillSourceDescriptor {
  kind: SkillSourceInputKind;
  raw: string;
  displaySource: string;
  url?: string;
  repo?: string;
  ref?: string;
  subdir?: string;
  refPath?: string;
  localPath?: string;
  requestedSkillName?: string;
}

export interface SkillInstallPreviewCandidate {
  name: string;
  description: string;
  relativeRootPath: string;
  conflictsWithInstallationId?: string;
  conflictsWithScope?: SkillScope;
  wouldBeEffective: boolean;
  shadowedInstallationIds: string[];
  diagnostics: SkillInstallationDiagnostic[];
}

export interface SkillInstallPreview {
  source: SkillSourceDescriptor;
  targetScope: SkillMutationTargetScope;
  candidates: SkillInstallPreviewCandidate[];
  warnings: string[];
}

export interface SkillUpdateCheckResult {
  installationId: string;
  canUpdate: boolean;
  reason?: string;
  preview?: SkillInstallPreview;
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

export const APPROVAL_RISK_CODES = [
  "safe_auto_approved",
  "matches_dangerous_pattern",
  "contains_shell_control_operator",
  "requires_manual_review",
  "file_read_command_requires_review",
  "outside_allowed_scope",
] as const;

export type ApprovalRiskCode = (typeof APPROVAL_RISK_CODES)[number];

export const SERVER_ERROR_SOURCES = [
  "protocol",
  "session",
  "tool",
  "provider",
  "backup",
  "observability",
  "permissions",
] as const;

export type ServerErrorSource = (typeof SERVER_ERROR_SOURCES)[number];

export const SERVER_ERROR_CODES = [
  "invalid_json",
  "invalid_payload",
  "missing_type",
  "unknown_type",
  "unknown_session",
  "busy",
  "validation_failed",
  "permission_denied",
  "provider_error",
  "backup_error",
  "observability_error",
  "internal_error",
] as const;

export type ServerErrorCode = (typeof SERVER_ERROR_CODES)[number];

export interface ObservabilityConfig {
  provider: "langfuse";
  baseUrl: string;
  otelEndpoint: string;
  publicKey?: string;
  secretKey?: string;
  tracingEnvironment?: string;
  release?: string;
}

export type ObservabilityHealthStatus = "disabled" | "ready" | "degraded";

export interface ObservabilityHealth {
  status: ObservabilityHealthStatus;
  reason: string;
  message?: string;
  updatedAt: string;
}

export interface HarnessConfig {
  reportOnly: boolean;
  strictMode: boolean;
}

export interface HarnessContextMetadata {
  [key: string]: string;
}

export interface HarnessContextPayload {
  runId: string;
  taskId?: string;
  objective: string;
  acceptanceCriteria: string[];
  constraints: string[];
  metadata?: HarnessContextMetadata;
}

export interface HarnessContextState extends HarnessContextPayload {
  updatedAt: string;
}

export type AgentMessages = ModelMessage[];

export type MCPServerTransport =
  | {
      type: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    }
  | { type: "http" | "sse"; url: string; headers?: Record<string, string> };

export type MCPServerAuthConfig =
  | { type: "none" }
  | {
      type: "api_key";
      headerName?: string;
      prefix?: string;
      keyId?: string;
    }
  | {
      type: "oauth";
      scope?: string;
      resource?: string;
      oauthMode?: "auto" | "code";
    };

export interface MCPServerConfig {
  name: string;
  transport: MCPServerTransport;
  required?: boolean;
  retries?: number;
  auth?: MCPServerAuthConfig;
}
