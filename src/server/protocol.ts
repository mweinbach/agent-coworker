import { isProviderName } from "../types";
import type {
  AgentConfig,
  HarnessContextPayload,
  HarnessSloCheck,
  HarnessSloOperator,
  ObservabilityQueryRequest,
  ObservabilityQueryType,
  SkillEntry,
  TodoItem,
} from "../types";
import type { ProviderStatus } from "../providerStatus";
import type { SessionBackupPublicState } from "./sessionBackup";

export type ClientMessage =
  | { type: "client_hello"; client: "tui" | "cli" | string; version?: string }
  | { type: "user_message"; sessionId: string; text: string; clientMessageId?: string }
  | { type: "ask_response"; sessionId: string; requestId: string; answer: string }
  | { type: "approval_response"; sessionId: string; requestId: string; approved: boolean }
  | { type: "connect_provider"; sessionId: string; provider: AgentConfig["provider"]; apiKey?: string }
  | { type: "set_model"; sessionId: string; model: string; provider?: AgentConfig["provider"] }
  | { type: "refresh_provider_status"; sessionId: string }
  | { type: "list_tools"; sessionId: string }
  | { type: "list_skills"; sessionId: string }
  | { type: "read_skill"; sessionId: string; skillName: string }
  | { type: "disable_skill"; sessionId: string; skillName: string }
  | { type: "enable_skill"; sessionId: string; skillName: string }
  | { type: "delete_skill"; sessionId: string; skillName: string }
  | { type: "set_enable_mcp"; sessionId: string; enableMcp: boolean }
  | { type: "cancel"; sessionId: string }
  | { type: "ping" }
  | { type: "session_backup_get"; sessionId: string }
  | { type: "session_backup_checkpoint"; sessionId: string }
  | { type: "session_backup_restore"; sessionId: string; checkpointId?: string }
  | { type: "session_backup_delete_checkpoint"; sessionId: string; checkpointId: string }
  | { type: "harness_context_get"; sessionId: string }
  | { type: "harness_context_set"; sessionId: string; context: HarnessContextPayload }
  | { type: "observability_query"; sessionId: string; query: ObservabilityQueryRequest }
  | { type: "harness_slo_evaluate"; sessionId: string; checks: HarnessSloCheck[] }
  | { type: "reset"; sessionId: string };

export type ServerEvent =
  | {
      type: "server_hello";
      sessionId: string;
      protocolVersion?: string;
      config: Pick<AgentConfig, "provider" | "model" | "workingDirectory" | "outputDirectory">;
    }
  | { type: "session_settings"; sessionId: string; enableMcp: boolean }
  | { type: "provider_status"; sessionId: string; providers: ProviderStatus[] }
  | { type: "session_busy"; sessionId: string; busy: boolean }
  | { type: "user_message"; sessionId: string; text: string; clientMessageId?: string }
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
    }
  | {
      type: "config_updated";
      sessionId: string;
      config: Pick<AgentConfig, "provider" | "model" | "workingDirectory" | "outputDirectory">;
    }
  | { type: "tools"; sessionId: string; tools: string[] }
  | { type: "skills_list"; sessionId: string; skills: SkillEntry[] }
  | { type: "skill_content"; sessionId: string; skill: SkillEntry; content: string }
  | {
      type: "session_backup_state";
      sessionId: string;
      reason: "requested" | "auto_checkpoint" | "manual_checkpoint" | "restore" | "delete";
      backup: SessionBackupPublicState;
    }
  | { type: "observability_status"; sessionId: string; enabled: boolean; observability?: AgentConfig["observability"] }
  | { type: "harness_context"; sessionId: string; context: (HarnessContextPayload & { updatedAt: string }) | null }
  | {
      type: "observability_query_result";
      sessionId: string;
      result: {
        queryType: ObservabilityQueryType;
        query: string;
        fromMs: number;
        toMs: number;
        status: "ok" | "error";
        data: unknown;
        error?: string;
      };
    }
  | {
      type: "harness_slo_result";
      sessionId: string;
      result: {
        reportOnly: boolean;
        strictMode: boolean;
        passed: boolean;
        fromMs: number;
        toMs: number;
        checks: Array<{
          id: string;
          type: "latency" | "error_rate" | "custom";
          queryType: ObservabilityQueryType;
          query: string;
          op: HarnessSloOperator;
          threshold: number;
          windowSec: number;
          actual: number | null;
          pass: boolean;
          reason?: string;
        }>;
      };
    }
  | { type: "error"; sessionId: string; message: string; code?: string; source?: string }
  | { type: "pong"; sessionId: "" };

export const WEBSOCKET_PROTOCOL_VERSION = "1.0";

export const CLIENT_MESSAGE_TYPES = [
  "client_hello",
  "user_message",
  "ask_response",
  "approval_response",
  "connect_provider",
  "set_model",
  "refresh_provider_status",
  "list_tools",
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
  "observability_query",
  "harness_slo_evaluate",
  "reset",
] as const;

export const SERVER_EVENT_TYPES = [
  "server_hello",
  "session_settings",
  "provider_status",
  "session_busy",
  "user_message",
  "assistant_message",
  "reasoning",
  "log",
  "todos",
  "reset_done",
  "ask",
  "approval",
  "config_updated",
  "tools",
  "skills_list",
  "skill_content",
  "session_backup_state",
  "observability_status",
  "harness_context",
  "observability_query_result",
  "harness_slo_result",
  "error",
  "pong",
] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isQueryType(v: unknown): v is ObservabilityQueryType {
  return v === "logql" || v === "promql" || v === "traceql";
}

function isSloOperator(v: unknown): v is HarnessSloOperator {
  return v === "<" || v === "<=" || v === ">" || v === ">=" || v === "==" || v === "!=";
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
    case "ping":
      return { ok: true, msg: obj };
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
    case "observability_query": {
      if (!isNonEmptyString(obj.sessionId)) return { ok: false, error: "observability_query missing sessionId" };
      if (!isPlainObject(obj.query)) return { ok: false, error: "observability_query missing/invalid query" };
      if (!isQueryType(obj.query.queryType)) return { ok: false, error: "observability_query invalid query.queryType" };
      if (!isNonEmptyString(obj.query.query)) return { ok: false, error: "observability_query invalid query.query" };
      if (obj.query.fromMs !== undefined && (typeof obj.query.fromMs !== "number" || !Number.isFinite(obj.query.fromMs))) {
        return { ok: false, error: "observability_query invalid query.fromMs" };
      }
      if (obj.query.toMs !== undefined && (typeof obj.query.toMs !== "number" || !Number.isFinite(obj.query.toMs))) {
        return { ok: false, error: "observability_query invalid query.toMs" };
      }
      if (
        obj.query.limit !== undefined &&
        (typeof obj.query.limit !== "number" ||
          !Number.isInteger(obj.query.limit) ||
          obj.query.limit <= 0)
      ) {
        return { ok: false, error: "observability_query invalid query.limit" };
      }
      return { ok: true, msg: obj as ClientMessage };
    }
    case "harness_slo_evaluate": {
      if (!isNonEmptyString(obj.sessionId)) return { ok: false, error: "harness_slo_evaluate missing sessionId" };
      if (!Array.isArray(obj.checks) || obj.checks.length === 0) {
        return { ok: false, error: "harness_slo_evaluate missing/invalid checks" };
      }
      for (const check of obj.checks) {
        if (!isPlainObject(check)) return { ok: false, error: "harness_slo_evaluate invalid check object" };
        if (!isNonEmptyString(check.id)) return { ok: false, error: "harness_slo_evaluate invalid check.id" };
        if (check.type !== "latency" && check.type !== "error_rate" && check.type !== "custom") {
          return { ok: false, error: "harness_slo_evaluate invalid check.type" };
        }
        if (!isQueryType(check.queryType)) return { ok: false, error: "harness_slo_evaluate invalid check.queryType" };
        if (!isNonEmptyString(check.query)) return { ok: false, error: "harness_slo_evaluate invalid check.query" };
        if (!isSloOperator(check.op)) return { ok: false, error: "harness_slo_evaluate invalid check.op" };
        if (typeof check.threshold !== "number" || !Number.isFinite(check.threshold)) {
          return { ok: false, error: "harness_slo_evaluate invalid check.threshold" };
        }
        if (typeof check.windowSec !== "number" || !Number.isFinite(check.windowSec) || check.windowSec <= 0) {
          return { ok: false, error: "harness_slo_evaluate invalid check.windowSec" };
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
    case "connect_provider": {
      if (!isNonEmptyString(obj.sessionId)) return { ok: false, error: "connect_provider missing sessionId" };
      if (!isProviderName(obj.provider)) return { ok: false, error: "connect_provider missing/invalid provider" };
      if (obj.apiKey !== undefined && typeof obj.apiKey !== "string") {
        return { ok: false, error: "connect_provider invalid apiKey" };
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
