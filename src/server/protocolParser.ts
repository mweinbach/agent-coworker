import { z } from "zod";

import { parseMCPServersDocument } from "../mcp/configRegistry";
import { resolveProviderAuthMethod } from "../providers/authRegistry";
import { isProviderName } from "../types";

import type { ClientMessage } from "./protocol";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

const MAX_MCP_API_KEY_SIZE = 100_000;

type ParseOk = { ok: true; msg: ClientMessage };
type ParseErr = { ok: false; error: string };
export type ParseResult = ParseOk | ParseErr;

const ok = (obj: Record<string, unknown>): ParseOk => ({ ok: true, msg: obj as ClientMessage });
const err = (error: string): ParseErr => ({ ok: false, error });

function firstIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue?.message || "validation_failed";
}

function validateWithSchema(schema: z.ZodTypeAny, obj: Record<string, unknown>): ParseResult {
  const parsed = schema.safeParse(obj);
  if (!parsed.success) return err(firstIssueMessage(parsed.error));
  return ok(obj);
}

function requireSessionError(type: string, obj: Record<string, unknown>): string | null {
  if (!isNonEmptyString(obj.sessionId)) return `${type} missing sessionId`;
  return null;
}

function requireSessionAndFieldError(
  type: string,
  obj: Record<string, unknown>,
  field: string,
  label?: string,
): string | null {
  const sessionError = requireSessionError(type, obj);
  if (sessionError) return sessionError;
  if (!isNonEmptyString(obj[field])) return `${type} missing/invalid ${label ?? field}`;
  return null;
}

function requireProviderAuthError(type: string, obj: Record<string, unknown>): string | null {
  const sessionError = requireSessionError(type, obj);
  if (sessionError) return sessionError;
  if (!isProviderName(obj.provider)) return `${type} missing/invalid provider`;
  if (!isNonEmptyString(obj.methodId)) return `${type} missing/invalid methodId`;
  if (!resolveProviderAuthMethod(obj.provider, obj.methodId)) return `${type} unknown methodId`;
  return null;
}

function makeSchema(
  type: string,
  validate: (obj: Record<string, unknown>) => string | null,
): z.ZodTypeAny {
  return z.object({ type: z.literal(type) }).passthrough().superRefine((value, ctx) => {
    const validationError = validate(value as Record<string, unknown>);
    if (!validationError) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: validationError,
    });
  });
}

function validateMcpServerPayload(value: unknown): string | null {
  if (!isPlainObject(value)) return "mcp_server_upsert missing/invalid server";
  try {
    parseMCPServersDocument(JSON.stringify({ servers: [value] }));
    return null;
  } catch (error) {
    return `mcp_server_upsert invalid server: ${String(error)}`;
  }
}

const sessionOnlyTypes = [
  "ping",
  "cancel",
  "session_close",
  "reset",
  "list_tools",
  "list_commands",
  "list_skills",
  "list_sessions",
  "refresh_provider_status",
  "provider_catalog_get",
  "provider_auth_methods_get",
  "mcp_servers_get",
  "harness_context_get",
  "session_backup_get",
  "session_backup_checkpoint",
] as const;

const sessionAndSkillNameTypes = [
  "read_skill",
  "disable_skill",
  "enable_skill",
  "delete_skill",
] as const;

const sessionAndNameTypes = [
  "mcp_server_delete",
  "mcp_server_validate",
  "mcp_server_auth_authorize",
] as const;

const clientMessageSchemas = new Map<string, z.ZodTypeAny>();

for (const type of sessionOnlyTypes) {
  clientMessageSchemas.set(type, makeSchema(type, (obj) => requireSessionError(type, obj)));
}

for (const type of sessionAndSkillNameTypes) {
  clientMessageSchemas.set(type, makeSchema(type, (obj) => requireSessionAndFieldError(type, obj, "skillName")));
}

for (const type of sessionAndNameTypes) {
  clientMessageSchemas.set(type, makeSchema(type, (obj) => requireSessionAndFieldError(type, obj, "name")));
}

clientMessageSchemas.set("client_hello", makeSchema("client_hello", (obj) => {
  if (!isNonEmptyString(obj.client)) return "client_hello missing/invalid client";
  if (obj.version !== undefined && typeof obj.version !== "string") return "client_hello invalid version";
  return null;
}));

clientMessageSchemas.set("user_message", makeSchema("user_message", (obj) => {
  const sessionError = requireSessionError("user_message", obj);
  if (sessionError) return sessionError;
  if (typeof obj.text !== "string") return "user_message missing text";
  if (obj.clientMessageId !== undefined && typeof obj.clientMessageId !== "string") {
    return "user_message invalid clientMessageId";
  }
  return null;
}));

clientMessageSchemas.set("ask_response", makeSchema("ask_response", (obj) => {
  const sessionError = requireSessionError("ask_response", obj);
  if (sessionError) return sessionError;
  if (!isNonEmptyString(obj.requestId)) return "ask_response missing requestId";
  if (typeof obj.answer !== "string") return "ask_response missing answer";
  return null;
}));

clientMessageSchemas.set("approval_response", makeSchema("approval_response", (obj) => {
  const sessionError = requireSessionError("approval_response", obj);
  if (sessionError) return sessionError;
  if (!isNonEmptyString(obj.requestId)) return "approval_response missing requestId";
  if (typeof obj.approved !== "boolean") return "approval_response missing/invalid approved";
  return null;
}));

clientMessageSchemas.set("execute_command", makeSchema("execute_command", (obj) => {
  const sessionError = requireSessionError("execute_command", obj);
  if (sessionError) return sessionError;
  if (!isNonEmptyString(obj.name)) return "execute_command missing/invalid name";
  if (obj.arguments !== undefined && typeof obj.arguments !== "string") return "execute_command invalid arguments";
  if (obj.clientMessageId !== undefined && typeof obj.clientMessageId !== "string") {
    return "execute_command invalid clientMessageId";
  }
  return null;
}));

clientMessageSchemas.set("set_model", makeSchema("set_model", (obj) => {
  const sessionError = requireSessionError("set_model", obj);
  if (sessionError) return sessionError;
  if (!isNonEmptyString(obj.model)) return "set_model missing/invalid model";
  if (obj.provider !== undefined && !isProviderName(obj.provider)) {
    return `set_model invalid provider: ${String(obj.provider)}`;
  }
  return null;
}));

clientMessageSchemas.set("provider_auth_authorize", makeSchema("provider_auth_authorize", (obj) => {
  return requireProviderAuthError("provider_auth_authorize", obj);
}));

clientMessageSchemas.set("provider_auth_callback", makeSchema("provider_auth_callback", (obj) => {
  const authError = requireProviderAuthError("provider_auth_callback", obj);
  if (authError) return authError;
  if (obj.code !== undefined && typeof obj.code !== "string") return "provider_auth_callback invalid code";
  return null;
}));

clientMessageSchemas.set("provider_auth_set_api_key", makeSchema("provider_auth_set_api_key", (obj) => {
  const authError = requireProviderAuthError("provider_auth_set_api_key", obj);
  if (authError) return authError;
  if (!isNonEmptyString(obj.apiKey)) return "provider_auth_set_api_key missing/invalid apiKey";
  return null;
}));

clientMessageSchemas.set("set_enable_mcp", makeSchema("set_enable_mcp", (obj) => {
  const sessionError = requireSessionError("set_enable_mcp", obj);
  if (sessionError) return sessionError;
  if (typeof obj.enableMcp !== "boolean") return "set_enable_mcp missing/invalid enableMcp";
  return null;
}));

clientMessageSchemas.set("mcp_server_upsert", makeSchema("mcp_server_upsert", (obj) => {
  const sessionError = requireSessionError("mcp_server_upsert", obj);
  if (sessionError) return sessionError;
  const validationError = validateMcpServerPayload(obj.server);
  if (validationError) return validationError;
  if (obj.previousName !== undefined && !isNonEmptyString(obj.previousName)) {
    return "mcp_server_upsert invalid previousName";
  }
  return null;
}));

clientMessageSchemas.set("mcp_server_auth_callback", makeSchema("mcp_server_auth_callback", (obj) => {
  const fieldError = requireSessionAndFieldError("mcp_server_auth_callback", obj, "name");
  if (fieldError) return fieldError;
  if (obj.code !== undefined && typeof obj.code !== "string") return "mcp_server_auth_callback invalid code";
  return null;
}));

clientMessageSchemas.set("mcp_server_auth_set_api_key", makeSchema("mcp_server_auth_set_api_key", (obj) => {
  const sessionError = requireSessionError("mcp_server_auth_set_api_key", obj);
  if (sessionError) return sessionError;
  if (!isNonEmptyString(obj.name)) return "mcp_server_auth_set_api_key missing/invalid name";
  if (!isNonEmptyString(obj.apiKey)) return "mcp_server_auth_set_api_key missing/invalid apiKey";
  if (typeof obj.apiKey === "string" && obj.apiKey.length > MAX_MCP_API_KEY_SIZE) {
    return "mcp_server_auth_set_api_key apiKey exceeds max size 100000";
  }
  return null;
}));

clientMessageSchemas.set("mcp_servers_migrate_legacy", makeSchema("mcp_servers_migrate_legacy", (obj) => {
  const sessionError = requireSessionError("mcp_servers_migrate_legacy", obj);
  if (sessionError) return sessionError;
  if (obj.scope !== "workspace" && obj.scope !== "user") {
    return "mcp_servers_migrate_legacy missing/invalid scope";
  }
  return null;
}));

clientMessageSchemas.set("harness_context_set", makeSchema("harness_context_set", (obj) => {
  const sessionError = requireSessionError("harness_context_set", obj);
  if (sessionError) return sessionError;
  if (!isPlainObject(obj.context)) return "harness_context_set missing/invalid context";

  const ctx = obj.context;
  if (!isNonEmptyString(ctx.runId)) return "harness_context_set invalid context.runId";
  if (!isNonEmptyString(ctx.objective)) return "harness_context_set invalid context.objective";
  if (!Array.isArray(ctx.acceptanceCriteria) || !ctx.acceptanceCriteria.every((x: unknown) => typeof x === "string")) {
    return "harness_context_set invalid context.acceptanceCriteria";
  }
  if (!Array.isArray(ctx.constraints) || !ctx.constraints.every((x: unknown) => typeof x === "string")) {
    return "harness_context_set invalid context.constraints";
  }
  if (ctx.taskId !== undefined && typeof ctx.taskId !== "string") {
    return "harness_context_set invalid context.taskId";
  }
  if (ctx.metadata !== undefined) {
    if (!isPlainObject(ctx.metadata)) return "harness_context_set invalid context.metadata";
    for (const value of Object.values(ctx.metadata)) {
      if (typeof value !== "string") return "harness_context_set invalid context.metadata values";
    }
  }

  return null;
}));

clientMessageSchemas.set("session_backup_restore", makeSchema("session_backup_restore", (obj) => {
  const sessionError = requireSessionError("session_backup_restore", obj);
  if (sessionError) return sessionError;
  if (obj.checkpointId !== undefined && !isNonEmptyString(obj.checkpointId)) {
    return "session_backup_restore invalid checkpointId";
  }
  return null;
}));

clientMessageSchemas.set("session_backup_delete_checkpoint", makeSchema("session_backup_delete_checkpoint", (obj) => {
  const sessionError = requireSessionError("session_backup_delete_checkpoint", obj);
  if (sessionError) return sessionError;
  if (!isNonEmptyString(obj.checkpointId)) return "session_backup_delete_checkpoint missing checkpointId";
  return null;
}));

clientMessageSchemas.set("get_messages", makeSchema("get_messages", (obj) => {
  const sessionError = requireSessionError("get_messages", obj);
  if (sessionError) return sessionError;
  if (obj.offset !== undefined && (typeof obj.offset !== "number" || obj.offset < 0)) {
    return "get_messages invalid offset";
  }
  if (obj.limit !== undefined && (typeof obj.limit !== "number" || obj.limit < 1)) {
    return "get_messages invalid limit";
  }
  return null;
}));

clientMessageSchemas.set("set_session_title", makeSchema("set_session_title", (obj) => {
  return requireSessionAndFieldError("set_session_title", obj, "title");
}));

clientMessageSchemas.set("delete_session", makeSchema("delete_session", (obj) => {
  return requireSessionAndFieldError("delete_session", obj, "targetSessionId");
}));

clientMessageSchemas.set("set_config", makeSchema("set_config", (obj) => {
  const sessionError = requireSessionError("set_config", obj);
  if (sessionError) return sessionError;
  if (!isPlainObject(obj.config)) return "set_config missing/invalid config";

  const cfg = obj.config as Record<string, unknown>;
  if (cfg.yolo !== undefined && typeof cfg.yolo !== "boolean") return "set_config config.yolo must be boolean";
  if (cfg.observabilityEnabled !== undefined && typeof cfg.observabilityEnabled !== "boolean") {
    return "set_config config.observabilityEnabled must be boolean";
  }
  if (cfg.subAgentModel !== undefined && !isNonEmptyString(cfg.subAgentModel)) {
    return "set_config config.subAgentModel must be non-empty string";
  }
  if (cfg.maxSteps !== undefined && (typeof cfg.maxSteps !== "number" || cfg.maxSteps < 1 || cfg.maxSteps > 1000)) {
    return "set_config config.maxSteps must be number 1-1000";
  }
  return null;
}));

clientMessageSchemas.set("upload_file", makeSchema("upload_file", (obj) => {
  const sessionError = requireSessionError("upload_file", obj);
  if (sessionError) return sessionError;
  if (!isNonEmptyString(obj.filename)) return "upload_file missing/invalid filename";
  if (typeof obj.contentBase64 !== "string") return "upload_file missing/invalid contentBase64";
  return null;
}));

export function safeParseClientMessage(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return err("Invalid JSON");
  }

  if (!isPlainObject(parsed)) return err("Expected object");
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.type !== "string") return err("Missing type");

  const schema = clientMessageSchemas.get(obj.type);
  if (!schema) return err(`Unknown type: ${String(obj.type)}`);
  return validateWithSchema(schema, obj);
}
