import { z } from "zod";

import { parseMCPServersDocument } from "../mcp/configRegistry";
import { resolveProviderAuthMethod } from "../providers/authRegistry";
import { isProviderName } from "../types";

import type { ClientMessage } from "./protocol";

const recordSchema = z.record(z.string(), z.unknown());
const nonEmptyTrimmedStringSchema = z.string().trim().min(1);
const harnessContextSchema = z.object({
  runId: nonEmptyTrimmedStringSchema,
  objective: nonEmptyTrimmedStringSchema,
  acceptanceCriteria: z.array(z.string()),
  constraints: z.array(z.string()),
  taskId: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
}).passthrough();
const setConfigPayloadSchema = z.object({
  yolo: z.boolean().optional(),
  observabilityEnabled: z.boolean().optional(),
  subAgentModel: nonEmptyTrimmedStringSchema.optional(),
  maxSteps: z.number().min(1).max(1000).optional(),
}).passthrough();

function isRecordObject(v: unknown): v is Record<string, unknown> {
  return recordSchema.safeParse(v).success;
}

function isNonEmptyString(v: unknown): v is string {
  return nonEmptyTrimmedStringSchema.safeParse(v).success;
}

const MAX_MCP_API_KEY_SIZE = 100_000;

type ParseOk = { ok: true; msg: ClientMessage };
type ParseErr = { ok: false; error: string };
export type ParseResult = ParseOk | ParseErr;

const ok = (msg: ClientMessage): ParseOk => ({ ok: true, msg });
const err = (error: string): ParseErr => ({ ok: false, error });

function firstIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue?.message || "validation_failed";
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
  if (!isRecordObject(value)) return "mcp_server_upsert missing/invalid server";
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

const sessionOnlySchemas = sessionOnlyTypes.map((type) =>
  makeSchema(type, (obj) => requireSessionError(type, obj)),
);

const sessionAndSkillNameSchemas = sessionAndSkillNameTypes.map((type) =>
  makeSchema(type, (obj) => requireSessionAndFieldError(type, obj, "skillName")),
);

const sessionAndNameSchemas = sessionAndNameTypes.map((type) =>
  makeSchema(type, (obj) => requireSessionAndFieldError(type, obj, "name")),
);

const clientHelloSchema = makeSchema("client_hello", (obj) => {
  if (!isNonEmptyString(obj.client)) return "client_hello missing/invalid client";
  if (obj.version !== undefined && typeof obj.version !== "string") return "client_hello invalid version";
  return null;
});

const userMessageSchema = makeSchema("user_message", (obj) => {
  const sessionError = requireSessionError("user_message", obj);
  if (sessionError) return sessionError;
  if (typeof obj.text !== "string") return "user_message missing text";
  if (obj.clientMessageId !== undefined && typeof obj.clientMessageId !== "string") {
    return "user_message invalid clientMessageId";
  }
  return null;
});

const askResponseSchema = makeSchema("ask_response", (obj) => {
  const sessionError = requireSessionError("ask_response", obj);
  if (sessionError) return sessionError;
  if (!isNonEmptyString(obj.requestId)) return "ask_response missing requestId";
  if (typeof obj.answer !== "string") return "ask_response missing answer";
  return null;
});

const approvalResponseSchema = makeSchema("approval_response", (obj) => {
  const sessionError = requireSessionError("approval_response", obj);
  if (sessionError) return sessionError;
  if (!isNonEmptyString(obj.requestId)) return "approval_response missing requestId";
  if (typeof obj.approved !== "boolean") return "approval_response missing/invalid approved";
  return null;
});

const executeCommandSchema = makeSchema("execute_command", (obj) => {
  const sessionError = requireSessionError("execute_command", obj);
  if (sessionError) return sessionError;
  if (!isNonEmptyString(obj.name)) return "execute_command missing/invalid name";
  if (obj.arguments !== undefined && typeof obj.arguments !== "string") return "execute_command invalid arguments";
  if (obj.clientMessageId !== undefined && typeof obj.clientMessageId !== "string") {
    return "execute_command invalid clientMessageId";
  }
  return null;
});

const setModelSchema = makeSchema("set_model", (obj) => {
  const sessionError = requireSessionError("set_model", obj);
  if (sessionError) return sessionError;
  if (!isNonEmptyString(obj.model)) return "set_model missing/invalid model";
  if (obj.provider !== undefined && !isProviderName(obj.provider)) {
    return `set_model invalid provider: ${String(obj.provider)}`;
  }
  return null;
});

const providerAuthAuthorizeSchema = makeSchema("provider_auth_authorize", (obj) => {
  return requireProviderAuthError("provider_auth_authorize", obj);
});

const providerAuthCallbackSchema = makeSchema("provider_auth_callback", (obj) => {
  const authError = requireProviderAuthError("provider_auth_callback", obj);
  if (authError) return authError;
  if (obj.code !== undefined && typeof obj.code !== "string") return "provider_auth_callback invalid code";
  return null;
});

const providerAuthSetApiKeySchema = makeSchema("provider_auth_set_api_key", (obj) => {
  const authError = requireProviderAuthError("provider_auth_set_api_key", obj);
  if (authError) return authError;
  if (!isNonEmptyString(obj.apiKey)) return "provider_auth_set_api_key missing/invalid apiKey";
  return null;
});

const setEnableMcpSchema = makeSchema("set_enable_mcp", (obj) => {
  const sessionError = requireSessionError("set_enable_mcp", obj);
  if (sessionError) return sessionError;
  if (typeof obj.enableMcp !== "boolean") return "set_enable_mcp missing/invalid enableMcp";
  return null;
});

const mcpServerUpsertSchema = makeSchema("mcp_server_upsert", (obj) => {
  const sessionError = requireSessionError("mcp_server_upsert", obj);
  if (sessionError) return sessionError;
  const validationError = validateMcpServerPayload(obj.server);
  if (validationError) return validationError;
  if (obj.previousName !== undefined && !isNonEmptyString(obj.previousName)) {
    return "mcp_server_upsert invalid previousName";
  }
  return null;
});

const mcpServerAuthCallbackSchema = makeSchema("mcp_server_auth_callback", (obj) => {
  const fieldError = requireSessionAndFieldError("mcp_server_auth_callback", obj, "name");
  if (fieldError) return fieldError;
  if (obj.code !== undefined && typeof obj.code !== "string") return "mcp_server_auth_callback invalid code";
  return null;
});

const mcpServerAuthSetApiKeySchema = makeSchema("mcp_server_auth_set_api_key", (obj) => {
  const sessionError = requireSessionError("mcp_server_auth_set_api_key", obj);
  if (sessionError) return sessionError;
  if (!isNonEmptyString(obj.name)) return "mcp_server_auth_set_api_key missing/invalid name";
  if (!isNonEmptyString(obj.apiKey)) return "mcp_server_auth_set_api_key missing/invalid apiKey";
  if (typeof obj.apiKey === "string" && obj.apiKey.length > MAX_MCP_API_KEY_SIZE) {
    return "mcp_server_auth_set_api_key apiKey exceeds max size 100000";
  }
  return null;
});

const mcpServersMigrateLegacySchema = makeSchema("mcp_servers_migrate_legacy", (obj) => {
  const sessionError = requireSessionError("mcp_servers_migrate_legacy", obj);
  if (sessionError) return sessionError;
  if (obj.scope !== "workspace" && obj.scope !== "user") {
    return "mcp_servers_migrate_legacy missing/invalid scope";
  }
  return null;
});

const harnessContextSetSchema = makeSchema("harness_context_set", (obj) => {
  const sessionError = requireSessionError("harness_context_set", obj);
  if (sessionError) return sessionError;
  if (!isRecordObject(obj.context)) return "harness_context_set missing/invalid context";

  const parsed = harnessContextSchema.safeParse(obj.context);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path ?? [];
    const root = String(path[0] ?? "");
    if (root === "runId") return "harness_context_set invalid context.runId";
    if (root === "objective") return "harness_context_set invalid context.objective";
    if (root === "acceptanceCriteria") return "harness_context_set invalid context.acceptanceCriteria";
    if (root === "constraints") return "harness_context_set invalid context.constraints";
    if (root === "taskId") return "harness_context_set invalid context.taskId";
    if (root === "metadata") {
      return path.length > 1
        ? "harness_context_set invalid context.metadata values"
        : "harness_context_set invalid context.metadata";
    }
    return "harness_context_set missing/invalid context";
  }
  return null;
});

const sessionBackupRestoreSchema = makeSchema("session_backup_restore", (obj) => {
  const sessionError = requireSessionError("session_backup_restore", obj);
  if (sessionError) return sessionError;
  if (obj.checkpointId !== undefined && !isNonEmptyString(obj.checkpointId)) {
    return "session_backup_restore invalid checkpointId";
  }
  return null;
});

const sessionBackupDeleteCheckpointSchema = makeSchema("session_backup_delete_checkpoint", (obj) => {
  const sessionError = requireSessionError("session_backup_delete_checkpoint", obj);
  if (sessionError) return sessionError;
  if (!isNonEmptyString(obj.checkpointId)) return "session_backup_delete_checkpoint missing checkpointId";
  return null;
});

const getMessagesSchema = makeSchema("get_messages", (obj) => {
  const sessionError = requireSessionError("get_messages", obj);
  if (sessionError) return sessionError;
  if (obj.offset !== undefined && (typeof obj.offset !== "number" || obj.offset < 0)) {
    return "get_messages invalid offset";
  }
  if (obj.limit !== undefined && (typeof obj.limit !== "number" || obj.limit < 1)) {
    return "get_messages invalid limit";
  }
  return null;
});

const setSessionTitleSchema = makeSchema("set_session_title", (obj) => {
  return requireSessionAndFieldError("set_session_title", obj, "title");
});

const deleteSessionSchema = makeSchema("delete_session", (obj) => {
  return requireSessionAndFieldError("delete_session", obj, "targetSessionId");
});

const setConfigSchema = makeSchema("set_config", (obj) => {
  const sessionError = requireSessionError("set_config", obj);
  if (sessionError) return sessionError;
  if (!isRecordObject(obj.config)) return "set_config missing/invalid config";

  const parsed = setConfigPayloadSchema.safeParse(obj.config);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = String(issue?.path?.[0] ?? "");
    if (field === "yolo") return "set_config config.yolo must be boolean";
    if (field === "observabilityEnabled") return "set_config config.observabilityEnabled must be boolean";
    if (field === "subAgentModel") return "set_config config.subAgentModel must be non-empty string";
    if (field === "maxSteps") return "set_config config.maxSteps must be number 1-1000";
    return "set_config missing/invalid config";
  }
  return null;
});

const uploadFileSchema = makeSchema("upload_file", (obj) => {
  const sessionError = requireSessionError("upload_file", obj);
  if (sessionError) return sessionError;
  if (!isNonEmptyString(obj.filename)) return "upload_file missing/invalid filename";
  if (typeof obj.contentBase64 !== "string") return "upload_file missing/invalid contentBase64";
  return null;
});

const knownClientMessageTypes = new Set<string>([
  ...sessionOnlyTypes,
  ...sessionAndSkillNameTypes,
  ...sessionAndNameTypes,
  "client_hello",
  "user_message",
  "ask_response",
  "approval_response",
  "execute_command",
  "set_model",
  "provider_auth_authorize",
  "provider_auth_callback",
  "provider_auth_set_api_key",
  "set_enable_mcp",
  "mcp_server_upsert",
  "mcp_server_auth_callback",
  "mcp_server_auth_set_api_key",
  "mcp_servers_migrate_legacy",
  "harness_context_set",
  "session_backup_restore",
  "session_backup_delete_checkpoint",
  "get_messages",
  "set_session_title",
  "delete_session",
  "set_config",
  "upload_file",
]);

const clientMessageSchemaOptions = [
  ...sessionOnlySchemas,
  ...sessionAndSkillNameSchemas,
  ...sessionAndNameSchemas,
  clientHelloSchema,
  userMessageSchema,
  askResponseSchema,
  approvalResponseSchema,
  executeCommandSchema,
  setModelSchema,
  providerAuthAuthorizeSchema,
  providerAuthCallbackSchema,
  providerAuthSetApiKeySchema,
  setEnableMcpSchema,
  mcpServerUpsertSchema,
  mcpServerAuthCallbackSchema,
  mcpServerAuthSetApiKeySchema,
  mcpServersMigrateLegacySchema,
  harnessContextSetSchema,
  sessionBackupRestoreSchema,
  sessionBackupDeleteCheckpointSchema,
  getMessagesSchema,
  setSessionTitleSchema,
  deleteSessionSchema,
  setConfigSchema,
  uploadFileSchema,
] as unknown as [
  z.ZodDiscriminatedUnionOption<"type">,
  ...z.ZodDiscriminatedUnionOption<"type">[],
];

const clientMessageSchema = z.discriminatedUnion("type", clientMessageSchemaOptions);

export function safeParseClientMessage(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return err("Invalid JSON");
  }

  const parsedObject = recordSchema.safeParse(parsed);
  if (!parsedObject.success) return err("Expected object");

  const obj = parsedObject.data;
  if (typeof obj.type !== "string") return err("Missing type");
  if (!knownClientMessageTypes.has(obj.type)) return err(`Unknown type: ${String(obj.type)}`);

  const parsedMessage = clientMessageSchema.safeParse(obj);
  if (!parsedMessage.success) return err(firstIssueMessage(parsedMessage.error));
  return ok(parsedMessage.data as ClientMessage);
}
