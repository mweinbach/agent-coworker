import type { ImportableItem, ImportableKind, ImportSource } from "../import";
import type { MarketplaceDetail } from "../plugins/marketplaceDetail";
import type { MarketplaceListEntry } from "../plugins/marketplaceRegistry";
import type { ProviderStatus } from "../providerStatus";
import type { ProviderAuthChallenge, ProviderAuthMethod } from "../providers/authRegistry";
import type { ProviderCatalogEntry } from "../providers/connectionCatalog";
import type { SessionUsageSnapshot, TurnUsage } from "../session/costTracker";
import type { AgentProfileSnapshot, AgentProfilesCatalog } from "../shared/agentProfiles";
import type {
  AgentExecutionState,
  AgentMode,
  AgentReasoningEffort,
  AgentRole,
  AgentTaskType,
  PersistentAgentSummary,
  SessionKind,
} from "../shared/agents";
import type { OpenAiCompatibleProviderOptionsByProvider } from "../shared/openaiCompatibleOptions";
import type { OpenAiNativeConnectorsEvent } from "../shared/openaiNativeConnectors";
import type { SessionSnapshot } from "../shared/sessionSnapshot";
import type { SkillImprovementStatusEvent } from "../skillImprovement";
import type {
  AgentConfig,
  ApprovalRiskCode,
  ChildModelRoutingMode,
  CommandInfo,
  HarnessContextPayload,
  MCPServerConfig,
  ObservabilityHealth,
  PluginCatalogEntry,
  PluginCatalogSnapshot,
  PluginInstallPreview,
  PluginUpdateCheckResult,
  SandboxDenialCategory,
  ServerErrorCode,
  ServerErrorData,
  ServerErrorSource,
  SkillCatalogSnapshot,
  SkillEntry,
  SkillInstallationEntry,
  SkillInstallPreview,
  SkillUpdateCheckResult,
  TodoItem,
  WorkspaceFeatureFlagOverrides,
  WorkspaceFeatureFlags,
} from "../types";
import type { AgentWaitMode } from "./agents/types";
import type { ModelStreamPartType, ModelStreamRawFormat } from "./modelStream";
import type {
  SessionBackupPublicState,
  WorkspaceBackupDeltaPreview,
  WorkspaceBackupPublicEntry,
} from "./sessionBackup";
import type { PersistedSessionSummary } from "./sessionStore";

export { ASK_SKIP_TOKEN } from "../shared/ask";

type MCPServerEventSource = "workspace" | "user" | "system" | "plugin";
type MCPServerAuthMode = "none" | "missing" | "api_key" | "oauth" | "oauth_pending" | "error";

// Version of the internal session event payload schema documented for JSON-RPC
// control envelopes and persisted session artifacts.
export const WEBSOCKET_PROTOCOL_VERSION = "7.42";

export type SessionConfigPatch = {
  yolo?: boolean;
  observabilityEnabled?: boolean;
  backupsEnabled?: boolean;
  enableMemory?: boolean;
  memoryRequireApproval?: boolean;
  advancedMemory?: boolean;
  memoryGenerationModel?: string;
  clearMemoryGenerationModel?: boolean;
  skillImprovementEnabled?: boolean;
  skillImprovementModel?: string;
  clearSkillImprovementModel?: boolean;
  skillImprovementScope?: AgentConfig["skillImprovementScope"];
  skillImprovementExcludedSkills?: string[];
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

type SessionConfigState = {
  yolo: boolean;
  observabilityEnabled: boolean;
  backupsEnabled: boolean;
  defaultBackupsEnabled: boolean;
  enableMemory: boolean;
  memoryRequireApproval: boolean;
  advancedMemory: boolean;
  memoryGenerationModel?: string;
  skillImprovementEnabled: boolean;
  skillImprovementModel?: string;
  skillImprovementScope: NonNullable<AgentConfig["skillImprovementScope"]>;
  skillImprovementExcludedSkills: string[];
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
  featureFlags?: {
    workspace?: WorkspaceFeatureFlags;
  };
};

export type SessionEvent =
  | {
      type: "server_hello";
      sessionId: string;
      protocolVersion?: string;
      capabilities?: {
        modelStreamChunk: "v1";
      };
      config: Pick<AgentConfig, "provider" | "model" | "workingDirectory"> & {
        outputDirectory?: string;
      };
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
      profile?: AgentProfileSnapshot;
      requestedModel?: string;
      effectiveModel?: string;
      requestedReasoningEffort?: AgentReasoningEffort;
      effectiveReasoningEffort?: AgentReasoningEffort;
      executionState?: AgentExecutionState;
      lastMessagePreview?: string;
    }
  | {
      type: "session_settings";
      sessionId: string;
      enableMcp: boolean;
      enableMemory: boolean;
      memoryRequireApproval: boolean;
    }
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
      profile?: AgentProfileSnapshot;
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
  | {
      type: "agent_profiles_catalog";
      sessionId: string;
      catalog: AgentProfilesCatalog;
    }
  | OpenAiNativeConnectorsEvent
  | {
      type: "provider_catalog";
      sessionId: string;
      all: ProviderCatalogEntry[];
      default: Record<string, string>;
      connected: string[];
    }
  | {
      type: "provider_auth_methods";
      sessionId: string;
      methods: Record<string, ProviderAuthMethod[]>;
    }
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
      steerRequestId?: string;
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
      /**
       * Human-readable reason the command was blocked (sandbox escalations only).
       * Safe to surface verbatim; never includes raw command output.
       */
      detail?: string;
      /** Sandbox-denial classification, when the approval is a sandbox escalation. */
      category?: SandboxDenialCategory;
    }
  | {
      type: "config_updated";
      sessionId: string;
      config: Pick<AgentConfig, "provider" | "model" | "workingDirectory"> & {
        outputDirectory?: string;
        uploadsDirectory?: string;
      };
    }
  | { type: "tools"; sessionId: string; tools: Array<{ name: string; description: string }> }
  | {
      type: "memory_list";
      sessionId: string;
      memories: Array<{
        id: string;
        scope: "workspace" | "user";
        content: string;
        createdAt: string;
        updatedAt: string;
      }>;
    }
  | {
      type: "advanced_memory_list";
      sessionId: string;
      folder: string;
      folders: string[];
      memories: Array<{
        slug: string;
        name: string;
        description: string;
        type: string;
        originSessionId?: string;
        body: string;
        updatedAt: string;
      }>;
    }
  | SkillImprovementStatusEvent
  | { type: "commands"; sessionId: string; commands: CommandInfo[] }
  | { type: "skills_list"; sessionId: string; skills: SkillEntry[] }
  | { type: "skill_content"; sessionId: string; skill: SkillEntry; content: string }
  | {
      type: "skills_catalog";
      sessionId: string;
      catalog: SkillCatalogSnapshot;
      availableSkillsPartial?: boolean;
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
      /** True when `availablePlugins` only reflects the local installed catalog and should not clear cached marketplace rows. */
      availablePluginsPartial?: boolean;
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
      type: "plugin_update_check";
      sessionId: string;
      result: PluginUpdateCheckResult;
    }
  | {
      type: "marketplaces_list";
      sessionId: string;
      marketplaces: MarketplaceListEntry[];
    }
  | {
      type: "marketplace_detail";
      sessionId: string;
      detail: MarketplaceDetail;
    }
  | {
      type: "import_list";
      sessionId: string;
      source: ImportSource;
      kind: ImportableKind;
      homeExists: boolean;
      items: ImportableItem[];
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
      config: {
        provider: "langfuse";
        baseUrl: string;
        otelEndpoint: string;
        tracingEnvironment?: string;
        release?: string;
        hasPublicKey: boolean;
        hasSecretKey: boolean;
        configured: boolean;
      } | null;
    }
  | {
      type: "harness_context";
      sessionId: string;
      context: (HarnessContextPayload & { updatedAt: string }) | null;
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
  | {
      type: "error";
      sessionId: string;
      message: string;
      code: ServerErrorCode;
      source: ServerErrorSource;
      data?: ServerErrorData;
      steerRequestId?: string;
    }
  | { type: "pong"; sessionId: string };
