import type {
  ApprovalRiskCode,
  AgentConfig,
  CommandInfo,
  HarnessContextPayload,
  MCPServerConfig,
  ObservabilityHealth,
  ServerErrorCode,
  ServerErrorSource,
  SkillEntry,
  TodoItem,
} from "../types";
import type { ProviderStatus } from "../providerStatus";
import { type ProviderAuthMethod, type ProviderAuthChallenge } from "../providers/authRegistry";
import type { ProviderCatalogEntry } from "../providers/connectionCatalog";
import type { ModelStreamPartType } from "./modelStream";
import type { SessionBackupPublicState } from "./sessionBackup";
import type { PersistedSessionSummary } from "./sessionDb";
export { ASK_SKIP_TOKEN } from "../shared/ask";

export type MCPServerEventSource = "workspace" | "user" | "system" | "workspace_legacy" | "user_legacy";
export type MCPServerAuthMode = "none" | "missing" | "api_key" | "oauth" | "oauth_pending" | "error";

export type ClientMessage =
  | { type: "client_hello"; client: "tui" | "cli" | string; version?: string }
  | { type: "user_message"; sessionId: string; text: string; clientMessageId?: string }
  | { type: "ask_response"; sessionId: string; requestId: string; answer: string }
  | { type: "approval_response"; sessionId: string; requestId: string; approved: boolean }
  | { type: "set_model"; sessionId: string; model: string; provider?: AgentConfig["provider"] }
  | { type: "refresh_provider_status"; sessionId: string }
  | { type: "provider_catalog_get"; sessionId: string }
  | { type: "provider_auth_methods_get"; sessionId: string }
  | { type: "provider_auth_authorize"; sessionId: string; provider: AgentConfig["provider"]; methodId: string }
  | {
      type: "provider_auth_callback";
      sessionId: string;
      provider: AgentConfig["provider"];
      methodId: string;
      code?: string;
    }
  | {
      type: "provider_auth_set_api_key";
      sessionId: string;
      provider: AgentConfig["provider"];
      methodId: string;
      apiKey: string;
    }
  | { type: "list_tools"; sessionId: string }
  | { type: "list_commands"; sessionId: string }
  | {
      type: "execute_command";
      sessionId: string;
      name: string;
      arguments?: string;
      clientMessageId?: string;
    }
  | { type: "list_skills"; sessionId: string }
  | { type: "read_skill"; sessionId: string; skillName: string }
  | { type: "disable_skill"; sessionId: string; skillName: string }
  | { type: "enable_skill"; sessionId: string; skillName: string }
  | { type: "delete_skill"; sessionId: string; skillName: string }
  | { type: "set_enable_mcp"; sessionId: string; enableMcp: boolean }
  | { type: "mcp_servers_get"; sessionId: string }
  | { type: "mcp_server_upsert"; sessionId: string; server: MCPServerConfig; previousName?: string }
  | { type: "mcp_server_delete"; sessionId: string; name: string }
  | { type: "mcp_server_validate"; sessionId: string; name: string }
  | { type: "mcp_server_auth_authorize"; sessionId: string; name: string }
  | { type: "mcp_server_auth_callback"; sessionId: string; name: string; code?: string }
  | { type: "mcp_server_auth_set_api_key"; sessionId: string; name: string; apiKey: string }
  | { type: "mcp_servers_migrate_legacy"; sessionId: string; scope: "workspace" | "user" }
  | { type: "cancel"; sessionId: string }
  | { type: "session_close"; sessionId: string }
  | { type: "ping"; sessionId: string }
  | { type: "session_backup_get"; sessionId: string }
  | { type: "session_backup_checkpoint"; sessionId: string }
  | { type: "session_backup_restore"; sessionId: string; checkpointId?: string }
  | { type: "session_backup_delete_checkpoint"; sessionId: string; checkpointId: string }
  | { type: "harness_context_get"; sessionId: string }
  | { type: "harness_context_set"; sessionId: string; context: HarnessContextPayload }
  | { type: "reset"; sessionId: string }
  | { type: "get_messages"; sessionId: string; offset?: number; limit?: number }
  | { type: "set_session_title"; sessionId: string; title: string }
  | { type: "list_sessions"; sessionId: string }
  | { type: "delete_session"; sessionId: string; targetSessionId: string }
  | {
      type: "set_config";
      sessionId: string;
      config: {
        yolo?: boolean;
        observabilityEnabled?: boolean;
        subAgentModel?: string;
        maxSteps?: number;
      };
    }
  | { type: "upload_file"; sessionId: string; filename: string; contentBase64: string };

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
      messageCount?: number;
      hasPendingAsk?: boolean;
      hasPendingApproval?: boolean;
    }
  | { type: "session_settings"; sessionId: string; enableMcp: boolean }
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
    }
  | {
      type: "mcp_servers";
      sessionId: string;
      servers: Array<
        MCPServerConfig & {
          source: MCPServerEventSource;
          inherited: boolean;
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
      mode?: "api_key" | "oauth" | "oauth_pending";
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
  | { type: "user_message"; sessionId: string; text: string; clientMessageId?: string }
  | {
      type: "model_stream_chunk";
      sessionId: string;
      turnId: string;
      index: number;
      provider: AgentConfig["provider"];
      model: string;
      partType: ModelStreamPartType;
      part: Record<string, unknown>;
      rawPart?: unknown;
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
  | { type: "commands"; sessionId: string; commands: CommandInfo[] }
  | { type: "skills_list"; sessionId: string; skills: SkillEntry[] }
  | { type: "skill_content"; sessionId: string; skill: SkillEntry; content: string }
  | {
      type: "session_backup_state";
      sessionId: string;
      reason: "requested" | "auto_checkpoint" | "manual_checkpoint" | "restore" | "delete";
      backup: SessionBackupPublicState;
    }
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
      type: "turn_usage";
      sessionId: string;
      turnId: string;
      usage: { promptTokens: number; completionTokens: number; totalTokens: number };
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
  | { type: "session_deleted"; sessionId: string; targetSessionId: string }
  | {
      type: "session_config";
      sessionId: string;
      config: {
        yolo: boolean;
        observabilityEnabled: boolean;
        subAgentModel: string;
        maxSteps: number;
      };
    }
  | { type: "file_uploaded"; sessionId: string; filename: string; path: string }
  | { type: "error"; sessionId: string; message: string; code: ServerErrorCode; source: ServerErrorSource }
  | { type: "pong"; sessionId: string };

export const WEBSOCKET_PROTOCOL_VERSION = "7.0";

export const CLIENT_MESSAGE_TYPES = [
  "client_hello",
  "user_message",
  "ask_response",
  "approval_response",
  "set_model",
  "refresh_provider_status",
  "provider_catalog_get",
  "provider_auth_methods_get",
  "provider_auth_authorize",
  "provider_auth_callback",
  "provider_auth_set_api_key",
  "list_tools",
  "list_commands",
  "execute_command",
  "list_skills",
  "read_skill",
  "disable_skill",
  "enable_skill",
  "delete_skill",
  "set_enable_mcp",
  "mcp_servers_get",
  "mcp_server_upsert",
  "mcp_server_delete",
  "mcp_server_validate",
  "mcp_server_auth_authorize",
  "mcp_server_auth_callback",
  "mcp_server_auth_set_api_key",
  "mcp_servers_migrate_legacy",
  "cancel",
  "session_close",
  "ping",
  "session_backup_get",
  "session_backup_checkpoint",
  "session_backup_restore",
  "session_backup_delete_checkpoint",
  "harness_context_get",
  "harness_context_set",
  "reset",
  "get_messages",
  "set_session_title",
  "list_sessions",
  "delete_session",
  "set_config",
  "upload_file",
] as const;

export const SERVER_EVENT_TYPES = [
  "server_hello",
  "session_settings",
  "session_info",
  "mcp_servers",
  "mcp_server_validation",
  "mcp_server_auth_challenge",
  "mcp_server_auth_result",
  "provider_catalog",
  "provider_auth_methods",
  "provider_auth_challenge",
  "provider_auth_result",
  "provider_status",
  "session_busy",
  "user_message",
  "model_stream_chunk",
  "assistant_message",
  "reasoning",
  "log",
  "todos",
  "reset_done",
  "ask",
  "approval",
  "config_updated",
  "tools",
  "commands",
  "skills_list",
  "skill_content",
  "session_backup_state",
  "observability_status",
  "harness_context",
  "turn_usage",
  "messages",
  "sessions",
  "session_deleted",
  "session_config",
  "file_uploaded",
  "error",
  "pong",
] as const;


export { safeParseClientMessage } from "./protocolParser";
export {
  safeJsonParse as safeParseServerEventJson,
  safeParseServerEvent,
} from "./protocolEventParser";
