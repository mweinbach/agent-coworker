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

/** Validates sessionId only — used by message types that carry no extra fields. */
function requireSession(obj: Record<string, unknown>): ParseResult {
  if (!isNonEmptyString(obj.sessionId)) return err(`${obj.type} missing sessionId`);
  return ok(obj);
}

/** Validates sessionId + a required non-empty string field. */
function requireSessionAndField(obj: Record<string, unknown>, field: string, label?: string): ParseResult {
  if (!isNonEmptyString(obj.sessionId)) return err(`${obj.type} missing sessionId`);
  if (!isNonEmptyString(obj[field])) return err(`${obj.type} missing/invalid ${label ?? field}`);
  return ok(obj);
}

/** Validates sessionId + provider + methodId (with auth method resolution). */
function requireProviderAuth(obj: Record<string, unknown>): ParseErr | null {
  if (!isNonEmptyString(obj.sessionId)) return err(`${obj.type} missing sessionId`);
  if (!isProviderName(obj.provider)) return err(`${obj.type} missing/invalid provider`);
  if (!isNonEmptyString(obj.methodId)) return err(`${obj.type} missing/invalid methodId`);
  if (!resolveProviderAuthMethod(obj.provider, obj.methodId)) return err(`${obj.type} unknown methodId`);
  return null;
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

  switch (obj.type) {
    case "client_hello": {
      if (!isNonEmptyString(obj.client)) return err("client_hello missing/invalid client");
      if (obj.version !== undefined && typeof obj.version !== "string") return err("client_hello invalid version");
      return ok(obj);
    }

    // Session-only types (no extra fields beyond sessionId)
    case "ping":
    case "cancel":
    case "session_close":
    case "reset":
    case "list_tools":
    case "list_commands":
    case "list_skills":
    case "list_sessions":
    case "refresh_provider_status":
    case "provider_catalog_get":
    case "provider_auth_methods_get":
    case "mcp_servers_get":
    case "harness_context_get":
    case "session_backup_get":
    case "session_backup_checkpoint":
      return requireSession(obj);

    // Session + skillName types
    case "read_skill":
    case "disable_skill":
    case "enable_skill":
    case "delete_skill":
      return requireSessionAndField(obj, "skillName");

    // Session + name types (MCP server name)
    case "mcp_server_delete":
    case "mcp_server_validate":
    case "mcp_server_auth_authorize":
      return requireSessionAndField(obj, "name");

    case "user_message": {
      if (!isNonEmptyString(obj.sessionId)) return err("user_message missing sessionId");
      if (typeof obj.text !== "string") return err("user_message missing text");
      if (obj.clientMessageId !== undefined && typeof obj.clientMessageId !== "string") {
        return err("user_message invalid clientMessageId");
      }
      return ok(obj);
    }
    case "ask_response": {
      if (!isNonEmptyString(obj.sessionId)) return err("ask_response missing sessionId");
      if (!isNonEmptyString(obj.requestId)) return err("ask_response missing requestId");
      if (typeof obj.answer !== "string") return err("ask_response missing answer");
      return ok(obj);
    }
    case "approval_response": {
      if (!isNonEmptyString(obj.sessionId)) return err("approval_response missing sessionId");
      if (!isNonEmptyString(obj.requestId)) return err("approval_response missing requestId");
      if (typeof obj.approved !== "boolean") return err("approval_response missing/invalid approved");
      return ok(obj);
    }
    case "execute_command": {
      if (!isNonEmptyString(obj.sessionId)) return err("execute_command missing sessionId");
      if (!isNonEmptyString(obj.name)) return err("execute_command missing/invalid name");
      if (obj.arguments !== undefined && typeof obj.arguments !== "string") return err("execute_command invalid arguments");
      if (obj.clientMessageId !== undefined && typeof obj.clientMessageId !== "string") {
        return err("execute_command invalid clientMessageId");
      }
      return ok(obj);
    }
    case "set_model": {
      if (!isNonEmptyString(obj.sessionId)) return err("set_model missing sessionId");
      if (!isNonEmptyString(obj.model)) return err("set_model missing/invalid model");
      if (obj.provider !== undefined && !isProviderName(obj.provider)) {
        return err(`set_model invalid provider: ${String(obj.provider)}`);
      }
      return ok(obj);
    }

    case "provider_auth_authorize": {
      const authErr = requireProviderAuth(obj);
      if (authErr) return authErr;
      return ok(obj);
    }
    case "provider_auth_callback": {
      const authErr = requireProviderAuth(obj);
      if (authErr) return authErr;
      if (obj.code !== undefined && typeof obj.code !== "string") return err("provider_auth_callback invalid code");
      return ok(obj);
    }
    case "provider_auth_set_api_key": {
      const authErr = requireProviderAuth(obj);
      if (authErr) return authErr;
      if (!isNonEmptyString(obj.apiKey)) return err("provider_auth_set_api_key missing/invalid apiKey");
      return ok(obj);
    }

    case "set_enable_mcp": {
      if (!isNonEmptyString(obj.sessionId)) return err("set_enable_mcp missing sessionId");
      if (typeof obj.enableMcp !== "boolean") return err("set_enable_mcp missing/invalid enableMcp");
      return ok(obj);
    }
    case "mcp_server_upsert": {
      if (!isNonEmptyString(obj.sessionId)) return err("mcp_server_upsert missing sessionId");
      const validationError = validateMcpServerPayload(obj.server);
      if (validationError) return err(validationError);
      if (obj.previousName !== undefined && !isNonEmptyString(obj.previousName)) {
        return err("mcp_server_upsert invalid previousName");
      }
      return ok(obj);
    }
    case "mcp_server_auth_callback": {
      if (!isNonEmptyString(obj.sessionId)) return err("mcp_server_auth_callback missing sessionId");
      if (!isNonEmptyString(obj.name)) return err("mcp_server_auth_callback missing/invalid name");
      if (obj.code !== undefined && typeof obj.code !== "string") return err("mcp_server_auth_callback invalid code");
      return ok(obj);
    }
    case "mcp_server_auth_set_api_key": {
      if (!isNonEmptyString(obj.sessionId)) return err("mcp_server_auth_set_api_key missing sessionId");
      if (!isNonEmptyString(obj.name)) return err("mcp_server_auth_set_api_key missing/invalid name");
      if (!isNonEmptyString(obj.apiKey)) return err("mcp_server_auth_set_api_key missing/invalid apiKey");
      if (typeof obj.apiKey === "string" && obj.apiKey.length > MAX_MCP_API_KEY_SIZE) {
        return err("mcp_server_auth_set_api_key apiKey exceeds max size 100000");
      }
      return ok(obj);
    }
    case "mcp_servers_migrate_legacy": {
      if (!isNonEmptyString(obj.sessionId)) return err("mcp_servers_migrate_legacy missing sessionId");
      if (obj.scope !== "workspace" && obj.scope !== "user") {
        return err("mcp_servers_migrate_legacy missing/invalid scope");
      }
      return ok(obj);
    }
    case "harness_context_set": {
      if (!isNonEmptyString(obj.sessionId)) return err("harness_context_set missing sessionId");
      if (!isPlainObject(obj.context)) return err("harness_context_set missing/invalid context");
      const ctx = obj.context;
      if (!isNonEmptyString(ctx.runId)) return err("harness_context_set invalid context.runId");
      if (!isNonEmptyString(ctx.objective)) return err("harness_context_set invalid context.objective");
      if (!Array.isArray(ctx.acceptanceCriteria) || !ctx.acceptanceCriteria.every((x: unknown) => typeof x === "string")) {
        return err("harness_context_set invalid context.acceptanceCriteria");
      }
      if (!Array.isArray(ctx.constraints) || !ctx.constraints.every((x: unknown) => typeof x === "string")) {
        return err("harness_context_set invalid context.constraints");
      }
      if (ctx.taskId !== undefined && typeof ctx.taskId !== "string") {
        return err("harness_context_set invalid context.taskId");
      }
      if (ctx.metadata !== undefined) {
        if (!isPlainObject(ctx.metadata)) return err("harness_context_set invalid context.metadata");
        for (const v of Object.values(ctx.metadata)) {
          if (typeof v !== "string") return err("harness_context_set invalid context.metadata values");
        }
      }
      return ok(obj);
    }
    case "session_backup_restore": {
      if (!isNonEmptyString(obj.sessionId)) return err("session_backup_restore missing sessionId");
      if (obj.checkpointId !== undefined && !isNonEmptyString(obj.checkpointId)) {
        return err("session_backup_restore invalid checkpointId");
      }
      return ok(obj);
    }
    case "session_backup_delete_checkpoint": {
      if (!isNonEmptyString(obj.sessionId)) return err("session_backup_delete_checkpoint missing sessionId");
      if (!isNonEmptyString(obj.checkpointId)) return err("session_backup_delete_checkpoint missing checkpointId");
      return ok(obj);
    }
    case "get_messages": {
      if (!isNonEmptyString(obj.sessionId)) return err("get_messages missing sessionId");
      if (obj.offset !== undefined && (typeof obj.offset !== "number" || obj.offset < 0)) {
        return err("get_messages invalid offset");
      }
      if (obj.limit !== undefined && (typeof obj.limit !== "number" || obj.limit < 1)) {
        return err("get_messages invalid limit");
      }
      return ok(obj);
    }
    case "set_session_title":
      return requireSessionAndField(obj, "title");
    case "delete_session":
      return requireSessionAndField(obj, "targetSessionId");
    case "set_config": {
      if (!isNonEmptyString(obj.sessionId)) return err("set_config missing sessionId");
      if (!isPlainObject(obj.config)) return err("set_config missing/invalid config");
      const cfg = obj.config as Record<string, unknown>;
      if (cfg.yolo !== undefined && typeof cfg.yolo !== "boolean") return err("set_config config.yolo must be boolean");
      if (cfg.observabilityEnabled !== undefined && typeof cfg.observabilityEnabled !== "boolean") {
        return err("set_config config.observabilityEnabled must be boolean");
      }
      if (cfg.subAgentModel !== undefined && !isNonEmptyString(cfg.subAgentModel)) {
        return err("set_config config.subAgentModel must be non-empty string");
      }
      if (cfg.maxSteps !== undefined && (typeof cfg.maxSteps !== "number" || cfg.maxSteps < 1 || cfg.maxSteps > 1000)) {
        return err("set_config config.maxSteps must be number 1-1000");
      }
      return ok(obj);
    }
    case "upload_file": {
      if (!isNonEmptyString(obj.sessionId)) return err("upload_file missing sessionId");
      if (!isNonEmptyString(obj.filename)) return err("upload_file missing/invalid filename");
      if (typeof obj.contentBase64 !== "string") return err("upload_file missing/invalid contentBase64");
      return ok(obj);
    }
    default:
      return err(`Unknown type: ${String(obj.type)}`);
  }
}
