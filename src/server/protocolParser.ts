import { z } from "zod";

import { parseMCPServersDocument } from "../mcp/configRegistry";
import { resolveProviderAuthMethod } from "../providers/authRegistry";
import { isProviderName } from "../types";

import type { ClientMessage } from "./protocol";

const recordSchema = z.record(z.string(), z.unknown());
const nonEmptyTrimmedStringSchema = z.string().refine((value) => value.trim().length > 0);
const harnessContextRootErrorMessages: Record<string, string> = {
  runId: "harness_context_set invalid context.runId",
  objective: "harness_context_set invalid context.objective",
  acceptanceCriteria: "harness_context_set invalid context.acceptanceCriteria",
  constraints: "harness_context_set invalid context.constraints",
  taskId: "harness_context_set invalid context.taskId",
  metadata: "harness_context_set invalid context.metadata",
};
const setConfigFieldErrorMessages: Record<string, string> = {
  yolo: "set_config config.yolo must be boolean",
  observabilityEnabled: "set_config config.observabilityEnabled must be boolean",
  subAgentModel: "set_config config.subAgentModel must be non-empty string",
  maxSteps: "set_config config.maxSteps must be number 1-1000",
};

function requiredString(message: string): z.ZodType<string> {
  return z.string({ error: message });
}

function optionalString(message: string): z.ZodOptional<z.ZodType<string>> {
  return z.string({ error: message }).optional();
}

function requiredNonEmptyTrimmedString(message: string): z.ZodType<string> {
  return z.string({ error: message }).refine((value) => value.trim().length > 0, { error: message });
}

function optionalNonEmptyTrimmedString(message: string): z.ZodOptional<z.ZodType<string>> {
  return z.string({ error: message }).refine((value) => value.trim().length > 0, { error: message }).optional();
}

function requiredBoolean(message: string): z.ZodType<boolean> {
  return z.boolean({ error: message });
}

function optionalNumberAtLeast(message: string, min: number): z.ZodOptional<z.ZodType<number>> {
  return z.number({ error: message }).finite({ error: message }).min(min, { error: message }).optional();
}

function requiredSessionId(type: string): z.ZodType<string> {
  return requiredNonEmptyTrimmedString(`${type} missing sessionId`);
}

const harnessContextSchema = z.object({
  runId: z.string().trim().min(1),
  objective: z.string().trim().min(1),
  acceptanceCriteria: z.array(z.string()),
  constraints: z.array(z.string()),
  taskId: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
}).passthrough();

const setConfigPayloadSchema = z.object({
  yolo: z.boolean().optional(),
  observabilityEnabled: z.boolean().optional(),
  subAgentModel: z.string().trim().min(1).optional(),
  maxSteps: z.number().min(1).max(1000).optional(),
}).passthrough();

const MAX_MCP_API_KEY_SIZE = 100_000;

type ParseOk = { ok: true; msg: ClientMessage };
type ParseErr = { ok: false; error: string };
export type ParseResult = ParseOk | ParseErr;

const ok = (msg: ClientMessage): ParseOk => ({ ok: true, msg });
const err = (error: string): ParseErr => ({ ok: false, error });

function firstIssueMessage(error: z.ZodError, rawType?: string): string {
  const issue = error.issues[0];
  if (
    issue?.code === "invalid_union"
    && issue.path.length === 1
    && issue.path[0] === "type"
    && typeof rawType === "string"
  ) {
    return `Unknown type: ${rawType}`;
  }
  return issue?.message || "validation_failed";
}

function validateMcpServerPayload(value: unknown): string | null {
  if (!recordSchema.safeParse(value).success) return "mcp_server_upsert missing/invalid server";
  try {
    parseMCPServersDocument(JSON.stringify({ servers: [value] }));
    return null;
  } catch (parseError) {
    return `mcp_server_upsert invalid server: ${String(parseError)}`;
  }
}

function validateProviderAuthTarget(
  ctx: z.RefinementCtx,
  value: { provider: unknown; methodId: unknown },
  messagePrefix: "provider_auth_authorize" | "provider_auth_callback" | "provider_auth_set_api_key",
): boolean {
  if (!isProviderName(value.provider)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["provider"],
      message: `${messagePrefix} missing/invalid provider`,
    });
    return false;
  }

  const parsedMethodId = nonEmptyTrimmedStringSchema.safeParse(value.methodId);
  if (!parsedMethodId.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["methodId"],
      message: `${messagePrefix} missing/invalid methodId`,
    });
    return false;
  }

  if (!resolveProviderAuthMethod(value.provider, parsedMethodId.data)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["methodId"],
      message: `${messagePrefix} unknown methodId`,
    });
    return false;
  }

  return true;
}

function schemaWithType<TType extends string>(
  type: TType,
  shape: z.ZodRawShape,
): z.ZodObject<{ type: z.ZodLiteral<TType> } & z.ZodRawShape, "passthrough"> {
  return z.object({
    type: z.literal(type),
    ...shape,
  }).passthrough();
}

function sessionOnlySchema<TType extends string>(type: TType): z.ZodObject<{ type: z.ZodLiteral<TType> } & z.ZodRawShape, "passthrough"> {
  return schemaWithType(type, {
    sessionId: requiredSessionId(type),
  });
}

function sessionAndFieldSchema<TType extends string>(
  type: TType,
  field: string,
  label?: string,
): z.ZodObject<{ type: z.ZodLiteral<TType> } & z.ZodRawShape, "passthrough"> {
  const shape: z.ZodRawShape = {
    sessionId: requiredSessionId(type),
  };
  shape[field] = requiredNonEmptyTrimmedString(`${type} missing/invalid ${label ?? field}`);
  return schemaWithType(type, shape);
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

const sessionOnlySchemas = Object.fromEntries(
  sessionOnlyTypes.map((type) => [type, sessionOnlySchema(type)]),
) as Record<(typeof sessionOnlyTypes)[number], z.ZodTypeAny>;

const sessionAndSkillNameSchemas = Object.fromEntries(
  sessionAndSkillNameTypes.map((type) => [type, sessionAndFieldSchema(type, "skillName")]),
) as Record<(typeof sessionAndSkillNameTypes)[number], z.ZodTypeAny>;

const sessionAndNameSchemas = Object.fromEntries(
  sessionAndNameTypes.map((type) => [type, sessionAndFieldSchema(type, "name")]),
) as Record<(typeof sessionAndNameTypes)[number], z.ZodTypeAny>;

const clientHelloSchema = schemaWithType("client_hello", {
  client: requiredNonEmptyTrimmedString("client_hello missing/invalid client"),
  version: optionalString("client_hello invalid version"),
});

const userMessageSchema = schemaWithType("user_message", {
  sessionId: requiredSessionId("user_message"),
  text: requiredString("user_message missing text"),
  clientMessageId: optionalString("user_message invalid clientMessageId"),
});

const askResponseSchema = schemaWithType("ask_response", {
  sessionId: requiredSessionId("ask_response"),
  requestId: requiredNonEmptyTrimmedString("ask_response missing requestId"),
  answer: requiredString("ask_response missing answer"),
});

const approvalResponseSchema = schemaWithType("approval_response", {
  sessionId: requiredSessionId("approval_response"),
  requestId: requiredNonEmptyTrimmedString("approval_response missing requestId"),
  approved: requiredBoolean("approval_response missing/invalid approved"),
});

const executeCommandSchema = schemaWithType("execute_command", {
  sessionId: requiredSessionId("execute_command"),
  name: requiredNonEmptyTrimmedString("execute_command missing/invalid name"),
  arguments: optionalString("execute_command invalid arguments"),
  clientMessageId: optionalString("execute_command invalid clientMessageId"),
});

const setModelSchema = schemaWithType("set_model", {
  sessionId: requiredSessionId("set_model"),
  model: requiredNonEmptyTrimmedString("set_model missing/invalid model"),
  provider: z.unknown().optional(),
}).superRefine((value, ctx) => {
  if (value.provider !== undefined && !isProviderName(value.provider)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["provider"],
      message: `set_model invalid provider: ${String(value.provider)}`,
    });
  }
});

const providerAuthAuthorizeSchema = schemaWithType("provider_auth_authorize", {
  sessionId: requiredSessionId("provider_auth_authorize"),
  provider: z.unknown(),
  methodId: z.unknown(),
}).superRefine((value, ctx) => {
  validateProviderAuthTarget(ctx, value, "provider_auth_authorize");
});

const providerAuthCallbackSchema = schemaWithType("provider_auth_callback", {
  sessionId: requiredSessionId("provider_auth_callback"),
  provider: z.unknown(),
  methodId: z.unknown(),
  code: z.unknown().optional(),
}).superRefine((value, ctx) => {
  if (!validateProviderAuthTarget(ctx, value, "provider_auth_callback")) return;

  if (value.code !== undefined && typeof value.code !== "string") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["code"],
      message: "provider_auth_callback invalid code",
    });
  }
});

const providerAuthSetApiKeySchema = schemaWithType("provider_auth_set_api_key", {
  sessionId: requiredSessionId("provider_auth_set_api_key"),
  provider: z.unknown(),
  methodId: z.unknown(),
  apiKey: z.unknown(),
}).superRefine((value, ctx) => {
  if (!validateProviderAuthTarget(ctx, value, "provider_auth_set_api_key")) return;

  if (!nonEmptyTrimmedStringSchema.safeParse(value.apiKey).success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["apiKey"],
      message: "provider_auth_set_api_key missing/invalid apiKey",
    });
  }
});

const setEnableMcpSchema = schemaWithType("set_enable_mcp", {
  sessionId: requiredSessionId("set_enable_mcp"),
  enableMcp: requiredBoolean("set_enable_mcp missing/invalid enableMcp"),
});

const mcpServerUpsertSchema = schemaWithType("mcp_server_upsert", {
  sessionId: requiredSessionId("mcp_server_upsert"),
  server: z.unknown(),
  previousName: z.unknown().optional(),
}).superRefine((value, ctx) => {
  const serverError = validateMcpServerPayload(value.server);
  if (serverError) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["server"],
      message: serverError,
    });
    return;
  }

  if (value.previousName !== undefined && !nonEmptyTrimmedStringSchema.safeParse(value.previousName).success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["previousName"],
      message: "mcp_server_upsert invalid previousName",
    });
  }
});

const mcpServerAuthCallbackSchema = schemaWithType("mcp_server_auth_callback", {
  sessionId: requiredSessionId("mcp_server_auth_callback"),
  name: requiredNonEmptyTrimmedString("mcp_server_auth_callback missing/invalid name"),
  code: optionalString("mcp_server_auth_callback invalid code"),
});

const mcpServerAuthSetApiKeySchema = schemaWithType("mcp_server_auth_set_api_key", {
  sessionId: requiredSessionId("mcp_server_auth_set_api_key"),
  name: requiredNonEmptyTrimmedString("mcp_server_auth_set_api_key missing/invalid name"),
  apiKey: requiredNonEmptyTrimmedString("mcp_server_auth_set_api_key missing/invalid apiKey"),
}).superRefine((value, ctx) => {
  if (value.apiKey.length > MAX_MCP_API_KEY_SIZE) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["apiKey"],
      message: "mcp_server_auth_set_api_key apiKey exceeds max size 100000",
    });
  }
});

const mcpServersMigrateLegacySchema = schemaWithType("mcp_servers_migrate_legacy", {
  sessionId: requiredSessionId("mcp_servers_migrate_legacy"),
  scope: z.enum(["workspace", "user"], { error: "mcp_servers_migrate_legacy missing/invalid scope" }),
});

const harnessContextSetSchema = schemaWithType("harness_context_set", {
  sessionId: requiredSessionId("harness_context_set"),
  context: z.unknown().optional(),
}).superRefine((value, ctx) => {
  if (!recordSchema.safeParse(value.context).success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["context"],
      message: "harness_context_set missing/invalid context",
    });
    return;
  }

  const parsedContext = harnessContextSchema.safeParse(value.context);
  if (parsedContext.success) return;

  const issue = parsedContext.error.issues[0];
  const path = issue?.path ?? [];
  const root = String(path[0] ?? "");
  const message = root === "metadata" && path.length > 1
    ? "harness_context_set invalid context.metadata values"
    : (harnessContextRootErrorMessages[root] ?? "harness_context_set missing/invalid context");

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["context"],
    message,
  });
});

const sessionBackupRestoreSchema = schemaWithType("session_backup_restore", {
  sessionId: requiredSessionId("session_backup_restore"),
  checkpointId: optionalNonEmptyTrimmedString("session_backup_restore invalid checkpointId"),
});

const sessionBackupDeleteCheckpointSchema = schemaWithType("session_backup_delete_checkpoint", {
  sessionId: requiredSessionId("session_backup_delete_checkpoint"),
  checkpointId: requiredNonEmptyTrimmedString("session_backup_delete_checkpoint missing checkpointId"),
});

const getMessagesSchema = schemaWithType("get_messages", {
  sessionId: requiredSessionId("get_messages"),
  offset: optionalNumberAtLeast("get_messages invalid offset", 0),
  limit: optionalNumberAtLeast("get_messages invalid limit", 1),
});

const setSessionTitleSchema = schemaWithType("set_session_title", {
  sessionId: requiredSessionId("set_session_title"),
  title: requiredNonEmptyTrimmedString("set_session_title missing/invalid title"),
});

const deleteSessionSchema = schemaWithType("delete_session", {
  sessionId: requiredSessionId("delete_session"),
  targetSessionId: requiredNonEmptyTrimmedString("delete_session missing/invalid targetSessionId"),
});

const setConfigSchema = schemaWithType("set_config", {
  sessionId: requiredSessionId("set_config"),
  config: z.unknown().optional(),
}).superRefine((value, ctx) => {
  if (!recordSchema.safeParse(value.config).success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["config"],
      message: "set_config missing/invalid config",
    });
    return;
  }

  const parsedConfig = setConfigPayloadSchema.safeParse(value.config);
  if (parsedConfig.success) return;

  const issue = parsedConfig.error.issues[0];
  const field = String(issue?.path?.[0] ?? "");
  const message = setConfigFieldErrorMessages[field] ?? "set_config missing/invalid config";

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["config"],
    message,
  });
});

const uploadFileSchema = schemaWithType("upload_file", {
  sessionId: requiredSessionId("upload_file"),
  filename: requiredNonEmptyTrimmedString("upload_file missing/invalid filename"),
  contentBase64: requiredString("upload_file missing/invalid contentBase64"),
});

const clientMessageSchema = z.discriminatedUnion("type", [
  ...Object.values(sessionOnlySchemas),
  ...Object.values(sessionAndSkillNameSchemas),
  ...Object.values(sessionAndNameSchemas),
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
] as [z.ZodObject<any>, ...z.ZodObject<any>[]]);

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

  const parsedMessage = clientMessageSchema.safeParse(obj);
  if (!parsedMessage.success) return err(firstIssueMessage(parsedMessage.error, obj.type));
  return ok(parsedMessage.data as ClientMessage);
}
