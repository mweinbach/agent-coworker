import { z } from "zod";

export const PROVIDER_NAMES = [
  "google",
  "openai",
  "anthropic",
  "bedrock",
  "baseten",
  "together",
  "fireworks",
  "firepass",
  "nvidia",
  "lmstudio",
  "opencode-go",
  "opencode-zen",
  "codex-cli",
  "antigravity",
] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];
const providerNameSchema = z.enum(PROVIDER_NAMES);

export const CHILD_MODEL_ROUTING_MODES = ["same-provider", "cross-provider-allowlist"] as const;

export type ChildModelRoutingMode = (typeof CHILD_MODEL_ROUTING_MODES)[number];
const childModelRoutingModeSchema = z.enum(CHILD_MODEL_ROUTING_MODES);

export type ModelMessage = {
  role: "system" | "user" | "assistant" | "tool" | (string & {});
  content: unknown;
  [key: string]: unknown;
};

/**
 * A skill or plugin the user explicitly referenced ("@-mentioned") when sending
 * a turn. A `skill` reference is hard-forced (its SKILL.md body is injected as a
 * synthetic skill tool call+result so it is guaranteed loaded and persists in
 * history); a `plugin` reference is soft awareness (a turn-scoped system block
 * biases the model toward the plugin's bundled skills).
 */
export type TurnReference = {
  kind: "skill" | "plugin";
  name: string;
};

/**
 * A plugin the user referenced on a turn, resolved against the plugin catalog.
 * Rendered into a turn-scoped system block by `renderReferencedPluginsSection`
 * to bias the model toward the plugin's bundled skills.
 */
export type ReferencedPluginContext = {
  name: string;
  displayName: string;
  skillNames: string[];
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

const RUNTIME_NAMES = [
  "pi",
  "openai-responses",
  "google-interactions",
  "codex-app-server",
  "antigravity",
] as const;

export type RuntimeName = (typeof RUNTIME_NAMES)[number];
const runtimeNameSchema = z.enum(RUNTIME_NAMES);

export function resolveRuntimeName(v: unknown): RuntimeName | null {
  const parsed = runtimeNameSchema.safeParse(v);
  return parsed.success ? parsed.data : null;
}

export function defaultRuntimeNameForProvider(provider: ProviderName): RuntimeName {
  if (provider === "codex-cli") {
    return "codex-app-server";
  }
  if (provider === "openai") {
    return "openai-responses";
  }
  if (provider === "google") {
    return "google-interactions";
  }
  if (provider === "antigravity") {
    return "antigravity";
  }
  return "pi";
}

export function normalizeRuntimeNameForProvider(
  provider: ProviderName,
  runtime: RuntimeName | null | undefined,
): RuntimeName {
  if (provider === "codex-cli") {
    return "codex-app-server";
  }
  if (provider === "openai") {
    return "openai-responses";
  }
  if (provider === "google") {
    return "google-interactions";
  }
  if (provider === "antigravity") {
    return "antigravity";
  }
  if (
    runtime === "openai-responses" ||
    runtime === "google-interactions" ||
    runtime === "codex-app-server" ||
    runtime === "antigravity"
  ) {
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

interface ModelRuntimeSettings {
  maxRetries?: number;
}

interface UserProfile {
  instructions?: string;
  work?: string;
  details?: string;
}

export type WorkspaceFeatureFlagOverrides = {
  a2ui?: boolean;
  openAiNativeConnectors?: boolean;
};

export type WorkspaceFeatureFlags = {
  a2ui?: boolean;
  openAiNativeConnectors?: boolean;
};

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
   * project `.cowork/config.json`, before built-in defaults were materialized.
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

  projectCoworkDir: string;
  userCoworkDir: string;
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

  /** Internal experiment gates resolved from environment. Not persisted. */
  experimentalFeatures?: {
    a2ui?: boolean;
    openAiNativeConnectors?: boolean;
  };

  /**
   * Experimental A2UI (Agent-to-UI) generative-UI opt-in. Only honored when
   * COWORK_EXPERIMENTAL_A2UI=1.
   */
  enableA2ui?: boolean;

  /**
   * Whether workspace/session backups are enabled.
   * Defaults to false when not specified.
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

interface InstalledPluginSkillSummary {
  name: string;
  rawName: string;
  description: string;
  enabled: boolean;
  rootDir: string;
  skillPath: string;
  triggers: string[];
  interface?: SkillInterfaceMeta;
}

export interface PluginMarketplaceMetadata {
  name: string;
  displayName?: string;
  category?: string;
  installationPolicy?: string;
  authenticationPolicy?: string;
}

interface PluginCatalogEntryBase {
  id: string;
  name: string;
  displayName: string;
  description: string;
  scope: PluginScope;
  discoveryKind: PluginDiscoveryKind;
  interface?: PluginInterfaceMeta;
  marketplace?: PluginMarketplaceMetadata;
  warnings: string[];
}

export interface InstalledPluginCatalogEntry extends PluginCatalogEntryBase {
  installed: true;
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
  installSource?: string;
  skills: InstalledPluginSkillSummary[];
  mcpServers: string[];
  apps: PluginAppSummary[];
}

export interface MarketplacePluginCatalogEntry extends PluginCatalogEntryBase {
  installed: false;
  discoveryKind: "marketplace";
  scope: "user";
  enabled: false;
  marketplace: PluginMarketplaceMetadata;
  installSource: string;
}

export type PluginCatalogEntry = InstalledPluginCatalogEntry | MarketplacePluginCatalogEntry;

export function isInstalledPluginCatalogEntry(
  plugin: PluginCatalogEntry,
): plugin is InstalledPluginCatalogEntry {
  return plugin.installed === true;
}

export interface PluginCatalogSnapshot {
  plugins: InstalledPluginCatalogEntry[];
  availablePlugins: MarketplacePluginCatalogEntry[];
  warnings: string[];
}

export type PluginInstallTargetScope = "workspace" | "user";

type PluginSourceInputKind =
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

type SkillInstallState = "effective" | "shadowed" | "disabled" | "invalid";

type SkillInstallOriginKind = "github" | "skills.sh" | "local" | "manual" | "bootstrap" | "unknown";

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

type SkillInstallationDiagnosticSeverity = "info" | "warning" | "error";

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

export interface SkillMarketplaceMetadata {
  name: string;
  displayName?: string;
  category?: string;
  installationPolicy?: string;
  authenticationPolicy?: string;
}

/**
 * A standalone skill offered by the marketplace but not yet installed. Mirrors
 * MarketplacePluginCatalogEntry: `installed: false`, carries an `installSource`
 * (a GitHub tree URL) that the existing skill install route consumes.
 */
export interface MarketplaceSkillCatalogEntry {
  id: string;
  name: string;
  displayName: string;
  description: string;
  category: string;
  installed: false;
  enabled: false;
  discoveryKind: "marketplace";
  scope: "user";
  marketplace: SkillMarketplaceMetadata;
  installSource: string;
  interface?: SkillInterfaceMeta;
  warnings: string[];
}

export interface SkillCatalogSnapshot {
  scopes: SkillScopeDescriptor[];
  effectiveSkills: SkillInstallationEntry[];
  installations: SkillInstallationEntry[];
  availableSkills: MarketplaceSkillCatalogEntry[];
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

type ObservabilityHealthStatus = "disabled" | "ready" | "degraded";

export interface ObservabilityHealth {
  status: ObservabilityHealthStatus;
  reason: string;
  message?: string;
  updatedAt: string;
}

interface HarnessConfig {
  reportOnly: boolean;
  strictMode: boolean;
}

interface HarnessContextMetadata {
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

type MCPServerTransport =
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
  enabled?: boolean;
  required?: boolean;
  retries?: number;
  auth?: MCPServerAuthConfig;
}
