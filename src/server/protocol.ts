import type {
  ApprovalRiskCode,
  AgentConfig,
  ChildModelRoutingMode,
  CommandInfo,
  HarnessContextPayload,
  MCPServerConfig,
  ObservabilityHealth,
  PluginCatalogEntry,
  PluginCatalogSnapshot,
  PluginInstallPreview,
  SkillCatalogSnapshot,
  ServerErrorCode,
  ServerErrorSource,
  SkillEntry,
  SkillInstallPreview,
  SkillInstallationEntry,
  SkillUpdateCheckResult,
  TodoItem,
} from "../types";
import type { SessionUsageSnapshot, TurnUsage } from "../session/costTracker";
import type { OpenAiCompatibleProviderOptionsByProvider } from "../shared/openaiCompatibleOptions";
import type { ProviderStatus } from "../providerStatus";
import { type ProviderAuthMethod, type ProviderAuthChallenge } from "../providers/authRegistry";
import type { ProviderCatalogEntry } from "../providers/connectionCatalog";
import type { ModelStreamPartType, ModelStreamRawFormat } from "./modelStream";
import type { PersistedSessionSummary } from "./sessionStore";
import type { SessionSnapshot } from "../shared/sessionSnapshot";
import type {
  WorkspaceFeatureFlagOverrides,
  WorkspaceFeatureFlags,
} from "../shared/featureFlags";
import type {
  SessionBackupPublicState,
  WorkspaceBackupDeltaPreview,
  WorkspaceBackupPublicEntry,
} from "./sessionBackup";
import type {
  AgentExecutionState,
  AgentMode,
  AgentReasoningEffort,
  AgentRole,
  AgentTaskType,
  PersistentAgentSummary,
  SessionKind,
} from "../shared/agents";
import type { AgentWaitMode } from "./agents/types";
export { ASK_SKIP_TOKEN } from "../shared/ask";

export type MCPServerEventSource = "workspace" | "user" | "system" | "workspace_legacy" | "user_legacy" | "plugin";
export type MCPServerAuthMode = "none" | "missing" | "api_key" | "oauth" | "oauth_pending" | "error";

// Keep the legacy websocket version string exported for docs/tests that still
// reference the pre-JSON-RPC protocol metadata.
export const WEBSOCKET_PROTOCOL_VERSION = "7.30";

export type SessionConfigPatch = {
  yolo?: boolean;
  observabilityEnabled?: boolean;
  backupsEnabled?: boolean;
  enableA2ui?: boolean;
  enableMemory?: boolean;
  memoryRequireApproval?: boolean;
  preferredChildModel?: string;
  childModelRoutingMode?: ChildModelRoutingMode;
  preferredChildModelRef?: string;
  allowedChildModelRefs?: string[];
  maxSteps?: number;
  toolOutputOverflowChars?: number | null;
  clearToolOutputOverflowChars?: boolean;
  providerOptions?: OpenAiCompatibleProviderOptionsByProvider;
  userName?: string;
  userProfile?: {
    instructions?: string;
    work?: string;
    details?: string;
  };
  featureFlags?: {
    workspace?: WorkspaceFeatureFlagOverrides;
  };
};

export type SessionConfigState = {
  yolo: boolean;
  observabilityEnabled: boolean;
  backupsEnabled: boolean;
  defaultBackupsEnabled: boolean;
  enableA2ui: boolean;
  enableMemory: boolean;
  memoryRequireApproval: boolean;
  preferredChildModel: string;
  childModelRoutingMode: ChildModelRoutingMode;
  preferredChildModelRef: string;
  allowedChildModelRefs: string[];
  maxSteps: number;
  toolOutputOverflowChars: number | null;
  defaultToolOutputOverflowChars?: number | null;
  providerOptions?: OpenAiCompatibleProviderOptionsByProvider;
  userName: string;
  userProfile: {
    instructions: string;
    work: string;
    details: string;
  };
  featureFlags: {
    workspace: WorkspaceFeatureFlags;
  };
};

export type ServerEvent =
  | {
    type: "server_hello";
    sessionId: string;
    protocolVersion?: string;
    capabilities?: {
      modelStreamChunk: "v1";
    };
    config: Pick<AgentConfig, "provider" | "model" | "workingDirectory"> & { outputDirectory?: string };
    isResume?: boolean;
    resumedFromStorage?: boolean;
    busy?: boolean;
    turnId?: string;
    messageCount?: number;
    hasPendingAsk?: boolean;
    hasPendingApproval?: boolean;
    sessionKind?: SessionKind;
    parentSessionId?: string;
    role?: AgentRole;
    mode?: AgentMode;
    depth?: number;
    nickname?: string;
    taskType?: AgentTaskType;
    targetPaths?: string[];
    requestedModel?: string;
    effectiveModel?: string;
    requestedReasoningEffort?: AgentReasoningEffort;
    effectiveReasoningEffort?: AgentReasoningEffort;
    executionState?: AgentExecutionState;
    lastMessagePreview?: string;
  }
  | { type: "session_settings"; sessionId: string; enableMcp: boolean; enableMemory: boolean; memoryRequireApproval: boolean }
  | {
    type: "session_info";
    sessionId: string;
    title: string;
    titleSource: "default" | "model" | "heuristic" | "manual";
    titleModel: string | null;
    createdAt: string;
    updatedAt: string;
    provider: AgentConfig["provider"];
    model: string;
    sessionKind?: SessionKind;
    parentSessionId?: string;
    role?: AgentRole;
    mode?: AgentMode;
    depth?: number;
    nickname?: string;
    taskType?: AgentTaskType;
    targetPaths?: string[];
    requestedModel?: string;
    effectiveModel?: string;
    requestedReasoningEffort?: AgentReasoningEffort;
    effectiveReasoningEffort?: AgentReasoningEffort;
    executionState?: AgentExecutionState;
    lastMessagePreview?: string;
  }
  | {
    type: "mcp_servers";
    sessionId: string;
    servers: Array<
      MCPServerConfig & {
        source: MCPServerEventSource;
        inherited: boolean;
        pluginId?: string;
        pluginName?: string;
        pluginDisplayName?: string;
        pluginScope?: "workspace" | "user";
        authMode: MCPServerAuthMode;
        authScope: "workspace" | "user";
        authMessage: string;
      }
    >;
    legacy: {
      workspace: { path: string; exists: boolean };
      user: { path: string; exists: boolean };
    };
    files: Array<{
      source: MCPServerEventSource;
      path: string;
      exists: boolean;
      editable: boolean;
      legacy: boolean;
      pluginId?: string;
      pluginName?: string;
      pluginDisplayName?: string;
      pluginScope?: "workspace" | "user";
      parseError?: string;
      serverCount: number;
    }>;
    warnings?: string[];
  }
  | {
    type: "mcp_server_validation";
    sessionId: string;
    name: string;
    ok: boolean;
    mode: MCPServerAuthMode;
    message: string;
    toolCount?: number;
    tools?: { name: string; description?: string }[];
    latencyMs?: number;
  }
  | {
    type: "mcp_server_auth_challenge";
    sessionId: string;
    name: string;
    challenge: {
      method: "auto" | "code";
      instructions: string;
      url?: string;
      expiresAt?: string;
    };
  }
  | {
    type: "mcp_server_auth_result";
    sessionId: string;
    name: string;
    ok: boolean;
    mode?: MCPServerAuthMode;
    message: string;
  }
  | { type: "provider_catalog"; sessionId: string; all: ProviderCatalogEntry[]; default: Record<string, string>; connected: string[] }
  | { type: "provider_auth_methods"; sessionId: string; methods: Record<string, ProviderAuthMethod[]> }
  | {
    type: "provider_auth_challenge";
    sessionId: string;
    provider: AgentConfig["provider"];
    methodId: string;
    challenge: ProviderAuthChallenge;
  }
  | {
    type: "provider_auth_result";
    sessionId: string;
    provider: AgentConfig["provider"];
    methodId: string;
    ok: boolean;
    mode?: "api_key" | "oauth" | "oauth_pending" | "credentials";
    message: string;
  }
  | { type: "provider_status"; sessionId: string; providers: ProviderStatus[] }
  | {
    type: "session_busy";
    sessionId: string;
    busy: boolean;
    turnId?: string;
    cause?: "user_message" | "command";
    outcome?: "completed" | "cancelled" | "error";
  }
  | {
    type: "steer_accepted";
    sessionId: string;
    turnId: string;
    text: string;
    clientMessageId?: string;
  }
  | { type: "user_message"; sessionId: string; text: string; clientMessageId?: string }
  | {
    type: "model_stream_chunk";
    sessionId: string;
    turnId: string;
    index: number;
    provider: AgentConfig["provider"];
    model: string;
    normalizerVersion?: number;
    partType: ModelStreamPartType;
    part: Record<string, unknown>;
    rawPart?: unknown;
  }
  | {
    type: "model_stream_raw";
    sessionId: string;
    turnId: string;
    index: number;
    provider: AgentConfig["provider"];
    model: string;
    format: ModelStreamRawFormat;
    normalizerVersion: number;
    event: Record<string, unknown>;
  }
  | { type: "assistant_message"; sessionId: string; text: string }
  | { type: "reasoning"; sessionId: string; kind: "reasoning" | "summary"; text: string }
  | { type: "log"; sessionId: string; line: string }
  | { type: "todos"; sessionId: string; todos: TodoItem[] }
  | { type: "reset_done"; sessionId: string }
  | { type: "ask"; sessionId: string; requestId: string; question: string; options?: string[] }
  | {
    type: "approval";
    sessionId: string;
    requestId: string;
    command: string;
    dangerous: boolean;
    reasonCode: ApprovalRiskCode;
  }
  | {
    type: "config_updated";
    sessionId: string;
    config: Pick<AgentConfig, "provider" | "model" | "workingDirectory"> & { outputDirectory?: string };
  }
  | { type: "tools"; sessionId: string; tools: Array<{ name: string; description: string }> }
  | { type: "memory_list"; sessionId: string; memories: Array<{ id: string; scope: "workspace" | "user"; content: string; createdAt: string; updatedAt: string }> }
  | { type: "commands"; sessionId: string; commands: CommandInfo[] }
  | { type: "skills_list"; sessionId: string; skills: SkillEntry[] }
  | { type: "skill_content"; sessionId: string; skill: SkillEntry; content: string }
  | {
    type: "skills_catalog";
    sessionId: string;
    catalog: SkillCatalogSnapshot;
    mutationBlocked: boolean;
    clearedMutationPendingKeys?: string[];
    mutationBlockedReason?: string;
  }
  | {
    type: "skill_installation";
    sessionId: string;
    installation: SkillInstallationEntry | null;
    content?: string | null;
  }
  | {
    type: "skill_install_preview";
    sessionId: string;
    preview: SkillInstallPreview;
    /** When false, emitted after install/update; do not clear an in-flight user preview. Omitted = legacy (treat as true). */
    fromUserPreviewRequest?: boolean;
  }
  | {
    type: "skill_installation_update_check";
    sessionId: string;
    result: SkillUpdateCheckResult;
  }
  | {
    type: "plugins_catalog";
    sessionId: string;
    catalog: PluginCatalogSnapshot;
    clearedMutationPendingKeys?: string[];
  }
  | {
    type: "plugin_detail";
    sessionId: string;
    plugin: PluginCatalogEntry | null;
  }
  | {
    type: "plugin_install_preview";
    sessionId: string;
    preview: PluginInstallPreview;
    fromUserPreviewRequest?: boolean;
  }
  | {
    type: "session_backup_state";
    sessionId: string;
    reason: "requested" | "auto_checkpoint" | "manual_checkpoint" | "restore" | "delete";
    backup: SessionBackupPublicState;
  }
  | {
    type: "workspace_backups";
    sessionId: string;
    workspacePath: string;
    backups: WorkspaceBackupPublicEntry[];
  }
  | ({
    type: "workspace_backup_delta";
    sessionId: string;
  } & WorkspaceBackupDeltaPreview)
  | {
    type: "observability_status";
    sessionId: string;
    enabled: boolean;
    health: ObservabilityHealth;
    config:
    | {
      provider: "langfuse";
      baseUrl: string;
      otelEndpoint: string;
      tracingEnvironment?: string;
      release?: string;
      hasPublicKey: boolean;
      hasSecretKey: boolean;
      configured: boolean;
    }
    | null;
  }
  | { type: "harness_context"; sessionId: string; context: (HarnessContextPayload & { updatedAt: string }) | null }
  | {
    type: "a2ui_surface";
    sessionId: string;
    surfaceId: string;
    catalogId: string;
    version: "v0.9";
    revision: number;
    deleted: boolean;
    theme?: Record<string, unknown>;
    root?: Record<string, unknown>;
    dataModel?: unknown;
    updatedAt: string;
    /** Envelope kind that produced this revision — useful for human-readable history. */
    changeKind?: "createSurface" | "updateComponents" | "updateDataModel" | "deleteSurface";
    /** Free-form explanation supplied by the agent on the tool call. */
    reason?: string;
    /** Ids grouping revisions that came from the same tool call — lets clients coalesce. */
    toolCallId?: string;
  }
  | {
    type: "turn_usage";
    sessionId: string;
    turnId: string;
    usage: TurnUsage;
  }
  | {
    type: "session_usage";
    sessionId: string;
    usage: SessionUsageSnapshot | null;
  }
  | {
    type: "budget_warning";
    sessionId: string;
    currentCostUsd: number;
    thresholdUsd: number;
    message: string;
  }
  | {
    type: "budget_exceeded";
    sessionId: string;
    currentCostUsd: number;
    thresholdUsd: number;
    message: string;
  }
  | {
    type: "messages";
    sessionId: string;
    messages: unknown[];
    total: number;
    offset: number;
    limit: number;
  }
  | { type: "sessions"; sessionId: string; sessions: PersistedSessionSummary[] }
  | {
    type: "session_snapshot";
    sessionId: string;
    targetSessionId: string;
    snapshot: SessionSnapshot;
  }
  | { type: "agent_spawned"; sessionId: string; agent: PersistentAgentSummary }
  | { type: "agent_list"; sessionId: string; agents: PersistentAgentSummary[] }
  | { type: "agent_status"; sessionId: string; agent: PersistentAgentSummary }
  | {
    type: "agent_wait_result";
    sessionId: string;
    agentIds: string[];
    timedOut: boolean;
    mode: AgentWaitMode;
    agents: PersistentAgentSummary[];
    readyAgentIds: string[];
  }
  | { type: "session_deleted"; sessionId: string; targetSessionId: string }
  | {
    type: "session_config";
    sessionId: string;
    config: SessionConfigState;
  }
  | { type: "file_uploaded"; sessionId: string; filename: string; path: string }
  | { type: "error"; sessionId: string; message: string; code: ServerErrorCode; source: ServerErrorSource }
  | { type: "pong"; sessionId: string };
