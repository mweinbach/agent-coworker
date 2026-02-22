import type { ModelMessage } from "ai";
import { z } from "zod";

export const PROVIDER_NAMES = [
  "google",
  "openai",
  "anthropic",
  "codex-cli",
] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];
const providerNameSchema = z.enum(PROVIDER_NAMES);

export function isProviderName(v: unknown): v is ProviderName {
  return providerNameSchema.safeParse(v).success;
}

export function resolveProviderName(v: unknown): ProviderName | null {
  const parsed = providerNameSchema.safeParse(v);
  return parsed.success ? parsed.data : null;
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

export interface AgentConfig {
  provider: ProviderName;
  model: string;
  subAgentModel: string;

  workingDirectory: string;
  outputDirectory?: string;
  uploadsDirectory?: string;

  userName: string;
  knowledgeCutoff: string;

  projectAgentDir: string;
  userAgentDir: string;
  builtInDir: string;
  builtInConfigDir: string;

  skillsDirs: string[];
  memoryDirs: string[];
  configDirs: string[];

  /**
   * Optional AI SDK providerOptions to pass through to model calls.
   * This lets us tune reasoning/thinking behavior per provider without hardcoding it in every call site.
   */
  providerOptions?: Record<string, any>;

  /**
   * Optional runtime controls for model calls.
   * These map to AI SDK call settings such as maxRetries.
   */
  modelSettings?: ModelRuntimeSettings;

  /**
   * Whether to enable MCP (Model Context Protocol) tool discovery/execution.
   * Defaults to true when not specified.
   */
  enableMcp?: boolean;

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
