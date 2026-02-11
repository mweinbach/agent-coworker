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
  | { type: "error"; sessionId: string; message: string }
  | { type: "pong"; sessionId: "" };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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

  if (typeof parsed !== "object" || parsed === null) return { ok: false, error: "Expected object" };
  const obj = parsed as any;
  if (typeof obj.type !== "string") return { ok: false, error: "Missing type" };

  switch (obj.type) {
    case "client_hello":
    case "ping":
      return { ok: true, msg: obj };
    case "user_message":
    case "ask_response":
    case "approval_response":
    case "list_tools":
    case "cancel":
    case "reset":
      return { ok: true, msg: obj };
    case "refresh_provider_status": {
      if (typeof obj.sessionId !== "string") return { ok: false, error: "refresh_provider_status missing sessionId" };
      return { ok: true, msg: obj as ClientMessage };
    }
    case "list_skills": {
      if (typeof obj.sessionId !== "string") return { ok: false, error: "list_skills missing sessionId" };
      return { ok: true, msg: obj as ClientMessage };
    }
    case "read_skill": {
      if (typeof obj.sessionId !== "string") return { ok: false, error: "read_skill missing sessionId" };
      if (typeof obj.skillName !== "string") return { ok: false, error: "read_skill missing skillName" };
      return { ok: true, msg: obj as ClientMessage };
    }
    case "disable_skill": {
      if (typeof obj.sessionId !== "string") return { ok: false, error: "disable_skill missing sessionId" };
      if (typeof obj.skillName !== "string") return { ok: false, error: "disable_skill missing skillName" };
      return { ok: true, msg: obj as ClientMessage };
    }
    case "enable_skill": {
      if (typeof obj.sessionId !== "string") return { ok: false, error: "enable_skill missing sessionId" };
      if (typeof obj.skillName !== "string") return { ok: false, error: "enable_skill missing skillName" };
      return { ok: true, msg: obj as ClientMessage };
    }
    case "delete_skill": {
      if (typeof obj.sessionId !== "string") return { ok: false, error: "delete_skill missing sessionId" };
      if (typeof obj.skillName !== "string") return { ok: false, error: "delete_skill missing skillName" };
      return { ok: true, msg: obj as ClientMessage };
    }
    case "set_enable_mcp": {
      if (typeof obj.sessionId !== "string") return { ok: false, error: "set_enable_mcp missing sessionId" };
      if (typeof obj.enableMcp !== "boolean") {
        return { ok: false, error: "set_enable_mcp missing/invalid enableMcp" };
      }
      return { ok: true, msg: obj as ClientMessage };
    }
    case "harness_context_get": {
      if (typeof obj.sessionId !== "string") return { ok: false, error: "harness_context_get missing sessionId" };
      return { ok: true, msg: obj as ClientMessage };
    }
    case "harness_context_set": {
      if (typeof obj.sessionId !== "string") return { ok: false, error: "harness_context_set missing sessionId" };
      if (!isPlainObject(obj.context)) return { ok: false, error: "harness_context_set missing/invalid context" };
      if (typeof obj.context.runId !== "string" || !obj.context.runId.trim()) {
        return { ok: false, error: "harness_context_set invalid context.runId" };
      }
      if (typeof obj.context.objective !== "string" || !obj.context.objective.trim()) {
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
      if (typeof obj.sessionId !== "string") return { ok: false, error: "observability_query missing sessionId" };
      if (!isPlainObject(obj.query)) return { ok: false, error: "observability_query missing/invalid query" };
      if (!isQueryType(obj.query.queryType)) return { ok: false, error: "observability_query invalid query.queryType" };
      if (typeof obj.query.query !== "string") return { ok: false, error: "observability_query invalid query.query" };
      if (obj.query.fromMs !== undefined && typeof obj.query.fromMs !== "number") {
        return { ok: false, error: "observability_query invalid query.fromMs" };
      }
      if (obj.query.toMs !== undefined && typeof obj.query.toMs !== "number") {
        return { ok: false, error: "observability_query invalid query.toMs" };
      }
      if (obj.query.limit !== undefined && (typeof obj.query.limit !== "number" || !Number.isFinite(obj.query.limit))) {
        return { ok: false, error: "observability_query invalid query.limit" };
      }
      return { ok: true, msg: obj as ClientMessage };
    }
    case "harness_slo_evaluate": {
      if (typeof obj.sessionId !== "string") return { ok: false, error: "harness_slo_evaluate missing sessionId" };
      if (!Array.isArray(obj.checks)) return { ok: false, error: "harness_slo_evaluate missing/invalid checks" };
      for (const check of obj.checks) {
        if (!isPlainObject(check)) return { ok: false, error: "harness_slo_evaluate invalid check object" };
        if (typeof check.id !== "string" || !check.id.trim()) return { ok: false, error: "harness_slo_evaluate invalid check.id" };
        if (check.type !== "latency" && check.type !== "error_rate" && check.type !== "custom") {
          return { ok: false, error: "harness_slo_evaluate invalid check.type" };
        }
        if (!isQueryType(check.queryType)) return { ok: false, error: "harness_slo_evaluate invalid check.queryType" };
        if (typeof check.query !== "string") return { ok: false, error: "harness_slo_evaluate invalid check.query" };
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
      if (typeof obj.sessionId !== "string") return { ok: false, error: "session_backup_get missing sessionId" };
      return { ok: true, msg: obj as ClientMessage };
    }
    case "session_backup_checkpoint": {
      if (typeof obj.sessionId !== "string") {
        return { ok: false, error: "session_backup_checkpoint missing sessionId" };
      }
      return { ok: true, msg: obj as ClientMessage };
    }
    case "session_backup_restore": {
      if (typeof obj.sessionId !== "string") return { ok: false, error: "session_backup_restore missing sessionId" };
      if (
        obj.checkpointId !== undefined &&
        (typeof obj.checkpointId !== "string" || obj.checkpointId.trim().length === 0)
      ) {
        return { ok: false, error: "session_backup_restore invalid checkpointId" };
      }
      return { ok: true, msg: obj as ClientMessage };
    }
    case "session_backup_delete_checkpoint": {
      if (typeof obj.sessionId !== "string") {
        return { ok: false, error: "session_backup_delete_checkpoint missing sessionId" };
      }
      if (typeof obj.checkpointId !== "string" || !obj.checkpointId) {
        return { ok: false, error: "session_backup_delete_checkpoint missing checkpointId" };
      }
      return { ok: true, msg: obj as ClientMessage };
    }
    case "connect_provider": {
      if (typeof obj.sessionId !== "string") return { ok: false, error: "connect_provider missing sessionId" };
      if (!isProviderName(obj.provider)) return { ok: false, error: "connect_provider missing/invalid provider" };
      if (obj.apiKey !== undefined && typeof obj.apiKey !== "string") {
        return { ok: false, error: "connect_provider invalid apiKey" };
      }
      return { ok: true, msg: obj as ClientMessage };
    }
    case "set_model": {
      if (typeof obj.sessionId !== "string") return { ok: false, error: "set_model missing sessionId" };
      if (typeof obj.model !== "string") return { ok: false, error: "set_model missing model" };
      if (obj.provider !== undefined && !isProviderName(obj.provider)) {
        return { ok: false, error: `set_model invalid provider: ${String(obj.provider)}` };
      }
      return { ok: true, msg: obj as ClientMessage };
    }
    default:
      return { ok: false, error: `Unknown type: ${String(obj.type)}` };
  }
}
