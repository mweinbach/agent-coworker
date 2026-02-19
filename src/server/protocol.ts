import { isProviderName } from "../types";
import type {
  ApprovalRiskCode,
  AgentConfig,
  CommandInfo,
  HarnessContextPayload,
  ObservabilityHealth,
  ServerErrorCode,
  ServerErrorSource,
  SkillEntry,
  TodoItem,
} from "../types";
import type { ProviderStatus } from "../providerStatus";
import { resolveProviderAuthMethod, type ProviderAuthMethod, type ProviderAuthChallenge } from "../providers/authRegistry";
import type { ProviderCatalogEntry } from "../providers/connectionCatalog";
import type { ModelStreamPartType } from "./modelStream";
import type { SessionBackupPublicState } from "./sessionBackup";

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
  | { type: "cancel"; sessionId: string }
  | { type: "ping"; sessionId: string }
  | { type: "session_backup_get"; sessionId: string }
  | { type: "session_backup_checkpoint"; sessionId: string }
  | { type: "session_backup_restore"; sessionId: string; checkpointId?: string }
  | { type: "session_backup_delete_checkpoint"; sessionId: string; checkpointId: string }
  | { type: "harness_context_get"; sessionId: string }
  | { type: "harness_context_set"; sessionId: string; context: HarnessContextPayload }
  | { type: "reset"; sessionId: string };

export type ServerEvent =
  | {
      type: "server_hello";
      sessionId: string;
      protocolVersion?: string;
      capabilities?: {
        modelStreamChunk: "v1";
      };
      config: Pick<AgentConfig, "provider" | "model" | "workingDirectory" | "outputDirectory">;
    }
  | { type: "session_settings"; sessionId: string; enableMcp: boolean }
  | {
      type: "session_info";
      sessionId: string;
      title: string;
      titleSource: "default" | "model" | "heuristic";
      titleModel: string | null;
      createdAt: string;
      updatedAt: string;
      provider: AgentConfig["provider"];
      model: string;
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
  | { type: "session_busy"; sessionId: string; busy: boolean }
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
      config: Pick<AgentConfig, "provider" | "model" | "workingDirectory" | "outputDirectory">;
    }
  | { type: "tools"; sessionId: string; tools: string[] }
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
  | { type: "error"; sessionId: string; message: string; code: ServerErrorCode; source: ServerErrorSource }
  | { type: "pong"; sessionId: string };

export const WEBSOCKET_PROTOCOL_VERSION = "4.0";

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
  "cancel",
  "ping",
  "session_backup_get",
  "session_backup_checkpoint",
  "session_backup_restore",
  "session_backup_delete_checkpoint",
  "harness_context_get",
  "harness_context_set",
  "reset",
] as const;

export const SERVER_EVENT_TYPES = [
  "server_hello",
  "session_settings",
  "session_info",
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
  "error",
  "pong",
] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export function safeParseClientMessage(raw: string): { ok: true; msg: ClientMessage } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Invalid JSON" };
  }

  if (!isPlainObject(parsed)) return { ok: false, error: "Expected object" };
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.type !== "string") return { ok: false, error: "Missing type" };

  switch (obj.type) {
    case "client_hello": {
      if (!isNonEmptyString(obj.client)) return { ok: false, error: "client_hello missing/invalid client" };
      if (obj.version !== undefined && typeof obj.version !== "string") {
        return { ok: false, error: "client_hello invalid version" };
      }
      return { ok: true, msg: obj as ClientMessage };
    }
    case "ping": {
      if (!isNonEmptyString(obj.sessionId)) return { ok: false, error: "ping missing sessionId" };
      return { ok: true, msg: obj as ClientMessage };
    }
    case "user_message": {
      if (!isNonEmptyString(obj.sessionId)) return { ok: false, error: "user_message missing sessionId" };
      if (typeof obj.text !== "string") return { ok: false, error: "user_message missing text" };
      if (obj.clientMessageId !== undefined && typeof obj.clientMessageId !== "string") {
        return { ok: false, error: "user_message invalid clientMessageId" };
      }
      return { ok: true, msg: obj as ClientMessage };
    }
    case "ask_response": {
      if (!isNonEmptyString(obj.sessionId)) return { ok: false, error: "ask_response missing sessionId" };
      if (!isNonEmptyString(obj.requestId)) return { ok: false, error: "ask_response missing requestId" };
      if (typeof obj.answer !== "string") return { ok: false, error: "ask_response missing answer" };
      return { ok: true, msg: obj as ClientMessage };
    }
    case "approval_response": {
      if (!isNonEmptyString(obj.sessionId)) return { ok: false, error: "approval_response missing sessionId" };
      if (!isNonEmptyString(obj.requestId)) return { ok: false, error: "approval_response missing requestId" };
      if (typeof obj.approved !== "boolean") return { ok: false, error: "approval_response missing/invalid approved" };
      return { ok: true, msg: obj as ClientMessage };
    }
    case "list_tools": {
      if (!isNonEmptyString(obj.sessionId)) return { ok: false, error: "list_tools missing sessionId" };
      return { ok: true, msg: obj as ClientMessage };
    }
    case "list_commands": {
      if (!isNonEmptyString(obj.sessionId)) return { ok: false, error: "list_commands missing sessionId" };
      return { ok: true, msg: obj as ClientMessage };
    }
    case "execute_command": {
      if (!isNonEmptyString(obj.sessionId)) return { ok: false, error: "execute_command missing sessionId" };
      if (!isNonEmptyString(obj.name)) return { ok: false, error: "execute_command missing/invalid name" };
      if (obj.arguments !== undefined && typeof obj.arguments !== "string") {
        return { ok: false, error: "execute_command invalid arguments" };
      }
      if (obj.clientMessageId !== undefined && typeof obj.clientMessageId !== "string") {
        return { ok: false, error: "execute_command invalid clientMessageId" };
      }
      return { ok: true, msg: obj as ClientMessage };
    }
    case "cancel": {
      if (!isNonEmptyString(obj.sessionId)) return { ok: false, error: "cancel missing sessionId" };
      return { ok: true, msg: obj as ClientMessage };
    }
    case "reset": {
      if (!isNonEmptyString(obj.sessionId)) return { ok: false, error: "reset missing sessionId" };
      return { ok: true, msg: obj as ClientMessage };
    }
    case "refresh_provider_status": {
      if (!isNonEmptyString(obj.sessionId)) return { ok: false, error: "refresh_provider_status missing sessionId" };
      return { ok: true, msg: obj as ClientMessage };
    }
    case "provider_catalog_get": {
      if (!isNonEmptyString(obj.sessionId)) return { ok: false, error: "provider_catalog_get missing sessionId" };
      return { ok: true, msg: obj as ClientMessage };
    }
    case "provider_auth_methods_get": {
      if (!isNonEmptyString(obj.sessionId)) return { ok: false, error: "provider_auth_methods_get missing sessionId" };
      return { ok: true, msg: obj as ClientMessage };
    }
    case "provider_auth_authorize": {
      if (!isNonEmptyString(obj.sessionId)) return { ok: false, error: "provider_auth_authorize missing sessionId" };
      if (!isProviderName(obj.provider)) {
        return { ok: false, error: "provider_auth_authorize missing/invalid provider" };
      }
      if (!isNonEmptyString(obj.methodId)) {
        return { ok: false, error: "provider_auth_authorize missing/invalid methodId" };
      }
      if (!resolveProviderAuthMethod(obj.provider, obj.methodId)) {
        return { ok: false, error: "provider_auth_authorize unknown methodId" };
      }
      return { ok: true, msg: obj as ClientMessage };
    }
    case "provider_auth_callback": {
      if (!isNonEmptyString(obj.sessionId)) return { ok: false, error: "provider_auth_callback missing sessionId" };
      if (!isProviderName(obj.provider)) {
        return { ok: false, error: "provider_auth_callback missing/invalid provider" };
      }
      if (!isNonEmptyString(obj.methodId)) {
        return { ok: false, error: "provider_auth_callback missing/invalid methodId" };
      }
      if (!resolveProviderAuthMethod(obj.provider, obj.methodId)) {
        return { ok: false, error: "provider_auth_callback unknown methodId" };
      }
      if (obj.code !== undefined && typeof obj.code !== "string") {
        return { ok: false, error: "provider_auth_callback invalid code" };
      }
      return { ok: true, msg: obj as ClientMessage };
    }
    case "provider_auth_set_api_key": {
      if (!isNonEmptyString(obj.sessionId)) {
        return { ok: false, error: "provider_auth_set_api_key missing sessionId" };
      }
      if (!isProviderName(obj.provider)) {
        return { ok: false, error: "provider_auth_set_api_key missing/invalid provider" };
      }
      if (!isNonEmptyString(obj.methodId)) {
        return { ok: false, error: "provider_auth_set_api_key missing/invalid methodId" };
      }
      if (!resolveProviderAuthMethod(obj.provider, obj.methodId)) {
        return { ok: false, error: "provider_auth_set_api_key unknown methodId" };
      }
      if (!isNonEmptyString(obj.apiKey)) {
        return { ok: false, error: "provider_auth_set_api_key missing/invalid apiKey" };
      }
      return { ok: true, msg: obj as ClientMessage };
    }
    case "list_skills": {
      if (!isNonEmptyString(obj.sessionId)) return { ok: false, error: "list_skills missing sessionId" };
      return { ok: true, msg: obj as ClientMessage };
    }
    case "read_skill": {
      if (!isNonEmptyString(obj.sessionId)) return { ok: false, error: "read_skill missing sessionId" };
      if (!isNonEmptyString(obj.skillName)) return { ok: false, error: "read_skill missing/invalid skillName" };
      return { ok: true, msg: obj as ClientMessage };
    }
    case "disable_skill": {
      if (!isNonEmptyString(obj.sessionId)) return { ok: false, error: "disable_skill missing sessionId" };
      if (!isNonEmptyString(obj.skillName)) return { ok: false, error: "disable_skill missing/invalid skillName" };
      return { ok: true, msg: obj as ClientMessage };
    }
    case "enable_skill": {
      if (!isNonEmptyString(obj.sessionId)) return { ok: false, error: "enable_skill missing sessionId" };
      if (!isNonEmptyString(obj.skillName)) return { ok: false, error: "enable_skill missing/invalid skillName" };
      return { ok: true, msg: obj as ClientMessage };
    }
    case "delete_skill": {
      if (!isNonEmptyString(obj.sessionId)) return { ok: false, error: "delete_skill missing sessionId" };
      if (!isNonEmptyString(obj.skillName)) return { ok: false, error: "delete_skill missing/invalid skillName" };
      return { ok: true, msg: obj as ClientMessage };
    }
    case "set_enable_mcp": {
      if (!isNonEmptyString(obj.sessionId)) return { ok: false, error: "set_enable_mcp missing sessionId" };
      if (typeof obj.enableMcp !== "boolean") {
        return { ok: false, error: "set_enable_mcp missing/invalid enableMcp" };
      }
      return { ok: true, msg: obj as ClientMessage };
    }
    case "harness_context_get": {
      if (!isNonEmptyString(obj.sessionId)) return { ok: false, error: "harness_context_get missing sessionId" };
      return { ok: true, msg: obj as ClientMessage };
    }
    case "harness_context_set": {
      if (!isNonEmptyString(obj.sessionId)) return { ok: false, error: "harness_context_set missing sessionId" };
      if (!isPlainObject(obj.context)) return { ok: false, error: "harness_context_set missing/invalid context" };
      if (!isNonEmptyString(obj.context.runId)) {
        return { ok: false, error: "harness_context_set invalid context.runId" };
      }
      if (!isNonEmptyString(obj.context.objective)) {
        return { ok: false, error: "harness_context_set invalid context.objective" };
      }
      if (!Array.isArray(obj.context.acceptanceCriteria) || !obj.context.acceptanceCriteria.every((x: unknown) => typeof x === "string")) {
        return { ok: false, error: "harness_context_set invalid context.acceptanceCriteria" };
      }
      if (!Array.isArray(obj.context.constraints) || !obj.context.constraints.every((x: unknown) => typeof x === "string")) {
        return { ok: false, error: "harness_context_set invalid context.constraints" };
      }
      if (obj.context.taskId !== undefined && typeof obj.context.taskId !== "string") {
        return { ok: false, error: "harness_context_set invalid context.taskId" };
      }
      if (obj.context.metadata !== undefined) {
        if (!isPlainObject(obj.context.metadata)) {
          return { ok: false, error: "harness_context_set invalid context.metadata" };
        }
        for (const v of Object.values(obj.context.metadata)) {
          if (typeof v !== "string") {
            return { ok: false, error: "harness_context_set invalid context.metadata values" };
          }
        }
      }
      return { ok: true, msg: obj as ClientMessage };
    }
    case "session_backup_get": {
      if (!isNonEmptyString(obj.sessionId)) return { ok: false, error: "session_backup_get missing sessionId" };
      return { ok: true, msg: obj as ClientMessage };
    }
    case "session_backup_checkpoint": {
      if (!isNonEmptyString(obj.sessionId)) {
        return { ok: false, error: "session_backup_checkpoint missing sessionId" };
      }
      return { ok: true, msg: obj as ClientMessage };
    }
    case "session_backup_restore": {
      if (!isNonEmptyString(obj.sessionId)) return { ok: false, error: "session_backup_restore missing sessionId" };
      if (obj.checkpointId !== undefined && !isNonEmptyString(obj.checkpointId)) {
        return { ok: false, error: "session_backup_restore invalid checkpointId" };
      }
      return { ok: true, msg: obj as ClientMessage };
    }
    case "session_backup_delete_checkpoint": {
      if (!isNonEmptyString(obj.sessionId)) {
        return { ok: false, error: "session_backup_delete_checkpoint missing sessionId" };
      }
      if (!isNonEmptyString(obj.checkpointId)) {
        return { ok: false, error: "session_backup_delete_checkpoint missing checkpointId" };
      }
      return { ok: true, msg: obj as ClientMessage };
    }
    case "set_model": {
      if (!isNonEmptyString(obj.sessionId)) return { ok: false, error: "set_model missing sessionId" };
      if (!isNonEmptyString(obj.model)) return { ok: false, error: "set_model missing/invalid model" };
      if (obj.provider !== undefined && !isProviderName(obj.provider)) {
        return { ok: false, error: `set_model invalid provider: ${String(obj.provider)}` };
      }
      return { ok: true, msg: obj as ClientMessage };
    }
    default:
      return { ok: false, error: `Unknown type: ${String(obj.type)}` };
  }
}
