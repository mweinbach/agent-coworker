import { z } from "zod";
import type { WorkspaceFeatureFlagOverrides } from "./shared/featureFlags";

export const PROVIDER_NAMES = [
  "google",
  "openai",
  "anthropic",
  "bedrock",
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
  workspaceAgentsDir?: string;
  userAgentsDir?: string;
  workspacePluginsDir?: string;
  userPluginsDir?: string;
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
   * Whether the A2UI (Agent-to-UI) generative-UI tool is exposed to the model
   * and associated protocol events are emitted. Defaults to true.
   */
  enableA2ui?: boolean;

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

  /**
   * Optional feature-flag overrides.
   * Workspace flags are merged across built-in, user, and project config layers.
   */
  featureFlags?: {
    workspace?: WorkspaceFeatureFlagOverrides;
  };
}

export type PluginScope = "workspace" | "user";
export type PluginDiscoveryKind = "marketplace" | "direct";

export interface SkillInterfaceMeta {
  displayName?: string;
  shortDescription?: string;
  iconSmall?: string; // data: URI (best-effort)
  iconLarge?: string; // data: URI (best-effort)
  defaultPrompt?: string;
  agents?: string[];
}

export interface PluginInterfaceMeta {
  displayName?: string;
  shortDescription?: string;
  longDescription?: string;
  developerName?: string;
  category?: string;
  capabilities?: string[];
  websiteURL?: string;
  privacyPolicyURL?: string;
  termsOfServiceURL?: string;
  defaultPrompt?: string[];
  brandColor?: string;
  composerIcon?: string;
  logo?: string;
  screenshots?: string[];
}

export interface PluginAppSummary {
  id: string;
  displayName: string;
  description?: string;
  authType?: string;
}

export interface PluginSkillSummary {
  name: string;
  rawName: string;
  description: string;
  enabled: boolean;
  rootDir: string;
  skillPath: string;
  triggers: string[];
  interface?: SkillInterfaceMeta;
}

export interface PluginCatalogEntry {
  id: string;
  name: string;
  displayName: string;
  description: string;
  scope: PluginScope;
  discoveryKind: PluginDiscoveryKind;
  enabled: boolean;
  rootDir: string;
  manifestPath: string;
  skillsPath: string;
  mcpPath?: string;
  appPath?: string;
  version?: string;
  authorName?: string;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  interface?: PluginInterfaceMeta;
  marketplace?: {
    name: string;
    displayName?: string;
    category?: string;
    installationPolicy?: string;
    authenticationPolicy?: string;
  };
  skills: PluginSkillSummary[];
  mcpServers: string[];
  apps: PluginAppSummary[];
  warnings: string[];
}

export interface PluginCatalogSnapshot {
  plugins: PluginCatalogEntry[];
  warnings: string[];
}

export type PluginInstallTargetScope = "workspace" | "user";

export type PluginSourceInputKind =
  | "github_repo"
  | "github_tree"
  | "github_blob"
  | "github_raw"
  | "github_shorthand"
  | "local_path";

export interface PluginSourceDescriptor {
  kind: PluginSourceInputKind;
  raw: string;
  displaySource: string;
  url?: string;
  repo?: string;
  ref?: string;
  subdir?: string;
  refPath?: string;
  localPath?: string;
}

export interface PluginInstallPreviewCandidate {
  pluginId: string;
  displayName: string;
  description: string;
  relativeRootPath: string;
  conflictsWithPluginId?: string;
  conflictsWithScope?: PluginScope;
  wouldBePrimary: boolean;
  shadowedPluginIds: string[];
  diagnostics: SkillInstallationDiagnostic[];
}

export interface PluginInstallPreview {
  source: PluginSourceDescriptor;
  targetScope: PluginInstallTargetScope;
  candidates: PluginInstallPreviewCandidate[];
  warnings: string[];
}

export interface SkillPluginOwner {
  pluginId: string;
  name: string;
  displayName: string;
  scope: PluginScope;
  discoveryKind: PluginDiscoveryKind;
  rootDir: string;
}

export interface SkillEntry {
  name: string;
  path: string;
  source: "project" | "user" | "global" | "built-in";
  enabled: boolean;
  triggers: string[];
  description: string;
  interface?: SkillInterfaceMeta;
  plugin?: SkillPluginOwner;
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
  interface?: SkillInterfaceMeta;
  diagnostics: SkillInstallationDiagnostic[];
  origin?: SkillInstallOrigin;
  manifest?: SkillInstallManifest;
  shadowedByInstallationId?: string;
  shadowedByScope?: SkillScope;
  installedAt?: string;
  updatedAt?: string;
  fileModifiedAt?: string;
  plugin?: SkillPluginOwner;
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
