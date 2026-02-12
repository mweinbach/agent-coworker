import type { ModelMessage } from "ai";

export const PROVIDER_NAMES = [
  "google",
  "openai",
  "anthropic",
  "gemini-cli",
  "codex-cli",
  "claude-code",
] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];

export function isProviderName(v: unknown): v is ProviderName {
  return typeof v === "string" && (PROVIDER_NAMES as readonly string[]).includes(v);
}

export interface AgentConfig {
  provider: ProviderName;
  model: string;
  subAgentModel: string;

  workingDirectory: string;
  outputDirectory: string;
  uploadsDirectory: string;

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
   * Whether to enable MCP (Model Context Protocol) tool discovery/execution.
   * Defaults to true when not specified.
   */
  enableMcp?: boolean;

  /**
   * Whether local observability integration is enabled for this session/run.
   * Defaults to false when not specified.
   */
  observabilityEnabled?: boolean;

  /**
   * Optional observability endpoint and runtime settings.
   */
  observability?: ObservabilityConfig;

  /**
   * Optional harness policy flags.
   */
  harness?: HarnessConfig;
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

export type ObservabilityQueryType = "logql" | "promql" | "traceql";

export interface ObservabilityQueryApi {
  logsBaseUrl: string;
  metricsBaseUrl: string;
  tracesBaseUrl: string;
}

export interface ObservabilityConfig {
  mode: "local_docker";
  otlpHttpEndpoint: string;
  queryApi: ObservabilityQueryApi;
  defaultWindowSec: number;
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

export type HarnessSloOperator = "<" | "<=" | ">" | ">=" | "==" | "!=";

export interface HarnessSloCheck {
  id: string;
  type: "latency" | "error_rate" | "custom";
  queryType: ObservabilityQueryType;
  query: string;
  op: HarnessSloOperator;
  threshold: number;
  windowSec: number;
}

export interface ObservabilityQueryRequest {
  queryType: ObservabilityQueryType;
  query: string;
  fromMs?: number;
  toMs?: number;
  limit?: number;
}

export interface ObservabilityQueryResult {
  queryType: ObservabilityQueryType;
  query: string;
  fromMs: number;
  toMs: number;
  status: "ok" | "error";
  data: unknown;
  error?: string;
}

export interface HarnessSloCheckResult {
  id: string;
  type: HarnessSloCheck["type"];
  queryType: ObservabilityQueryType;
  query: string;
  op: HarnessSloOperator;
  threshold: number;
  windowSec: number;
  actual: number | null;
  pass: boolean;
  reason?: string;
}

export interface HarnessSloResult {
  reportOnly: boolean;
  strictMode: boolean;
  passed: boolean;
  fromMs: number;
  toMs: number;
  checks: HarnessSloCheckResult[];
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

export interface MCPServerConfig {
  name: string;
  transport: MCPServerTransport;
  required?: boolean;
  retries?: number;
}
