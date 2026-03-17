import { z } from "zod";

import { parseMCPServerConfig, parseMCPServersDocument } from "../mcp/configRegistry";
import { resolveProviderAuthMethod } from "../providers/authRegistry";
import {
  CODEX_WEB_SEARCH_BACKEND_VALUES,
  CODEX_WEB_SEARCH_CONTEXT_SIZE_VALUES,
  CODEX_WEB_SEARCH_MODE_VALUES,
  OPENAI_REASONING_EFFORT_VALUES,
  OPENAI_REASONING_SUMMARY_VALUES,
  OPENAI_TEXT_VERBOSITY_VALUES,
} from "../shared/openaiCompatibleOptions";
import { AGENT_ROLE_VALUES, agentReasoningEffortSchema } from "../shared/agents";
import { CHILD_MODEL_ROUTING_MODES, isProviderName } from "../types";

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
  backupsEnabled: "set_config config.backupsEnabled must be boolean",
  enableMemory: "set_config config.enableMemory must be boolean",
  memoryRequireApproval: "set_config config.memoryRequireApproval must be boolean",
  preferredChildModel: "set_config config.preferredChildModel must be non-empty string",
  childModelRoutingMode: `set_config config.childModelRoutingMode must be one of ${CHILD_MODEL_ROUTING_MODES.join(", ")}`,
  preferredChildModelRef: "set_config config.preferredChildModelRef must be non-empty string",
  allowedChildModelRefs: "set_config config.allowedChildModelRefs must be an array of non-empty strings",
  maxSteps: "set_config config.maxSteps must be number 1-1000",
  toolOutputOverflowChars: "set_config config.toolOutputOverflowChars must be null or non-negative integer",
  clearToolOutputOverflowChars: "set_config config.clearToolOutputOverflowChars must be boolean",
  providerOptions: "set_config config.providerOptions must be an object",
  userName: "set_config config.userName must be string",
  userProfile: "set_config config.userProfile must be an object",
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

function optionalNullableNonNegativeNumber(message: string): z.ZodOptional<z.ZodNullable<z.ZodType<number>>> {
  return z.number({ error: message }).finite({ error: message }).nonnegative({ error: message }).nullable().optional();
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

const openAiCompatibleProviderOptionsSchema = z.object({
  reasoningEffort: z.enum(OPENAI_REASONING_EFFORT_VALUES).optional(),
  reasoningSummary: z.enum(OPENAI_REASONING_SUMMARY_VALUES).optional(),
  textVerbosity: z.enum(OPENAI_TEXT_VERBOSITY_VALUES).optional(),
}).strict();

const codexWebSearchLocationSchema = z.object({
  country: z.string().trim().min(1).optional(),
  region: z.string().trim().min(1).optional(),
  city: z.string().trim().min(1).optional(),
  timezone: z.string().trim().min(1).optional(),
}).strict();

const codexWebSearchSchema = z.object({
  contextSize: z.enum(CODEX_WEB_SEARCH_CONTEXT_SIZE_VALUES).optional(),
  allowedDomains: z.array(z.string().trim().min(1)).optional(),
  location: codexWebSearchLocationSchema.optional(),
}).strict();

const codexCliProviderOptionsSchema = openAiCompatibleProviderOptionsSchema.extend({
  webSearchBackend: z.enum(CODEX_WEB_SEARCH_BACKEND_VALUES).optional(),
  webSearchMode: z.enum(CODEX_WEB_SEARCH_MODE_VALUES).optional(),
  webSearch: codexWebSearchSchema.optional(),
}).strict();

const editableOpenAiProviderOptionsByProviderSchema = z.object({
  openai: openAiCompatibleProviderOptionsSchema.optional(),
  "codex-cli": codexCliProviderOptionsSchema.optional(),
}).strict();

const setConfigPayloadSchema = z.object({
  yolo: z.boolean().optional(),
  observabilityEnabled: z.boolean().optional(),
  backupsEnabled: z.boolean().optional(),
  enableMemory: z.boolean().optional(),
  memoryRequireApproval: z.boolean().optional(),
  preferredChildModel: z.string().trim().min(1).optional(),
  childModelRoutingMode: z.enum(CHILD_MODEL_ROUTING_MODES).optional(),
  preferredChildModelRef: z.string().trim().min(1).optional(),
  allowedChildModelRefs: z.array(z.string().trim().min(1)).optional(),
  maxSteps: z.number().min(1).max(1000).optional(),
  toolOutputOverflowChars: z.number().int().nonnegative().nullable().optional(),
  clearToolOutputOverflowChars: z.boolean().optional(),
  providerOptions: editableOpenAiProviderOptionsByProviderSchema.optional(),
  userName: z.string().optional(),
  userProfile: z.object({
    instructions: z.string().optional(),
    work: z.string().optional(),
    details: z.string().optional(),
  }).passthrough().optional(),
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

function setConfigIssueMessage(issue: z.ZodIssue): string {
  const path = issue.path.map((part) => String(part));
  const [field, provider, option, nestedOption, nestedField] = path;

  if (field === "providerOptions") {
    if (issue.code === "unrecognized_keys") {
      if (provider === undefined) {
        return "set_config config.providerOptions only supports openai and codex-cli";
      }
      if (provider === "codex-cli" && option === "webSearch" && nestedOption === "location") {
        return "set_config config.providerOptions.codex-cli.webSearch.location only supports country, region, city, and timezone";
      }
      if (provider === "codex-cli" && option === "webSearch") {
        return "set_config config.providerOptions.codex-cli.webSearch only supports contextSize, allowedDomains, and location";
      }
      if (provider === "codex-cli") {
        return "set_config config.providerOptions.codex-cli only supports reasoningEffort, reasoningSummary, textVerbosity, webSearchBackend, webSearchMode, and webSearch";
      }
      return `set_config config.providerOptions.${provider} only supports reasoningEffort, reasoningSummary, and textVerbosity`;
    }

    if (!provider) {
      return "set_config config.providerOptions must be an object";
    }

    if (!option) {
      return `set_config config.providerOptions.${provider} must be an object`;
    }

    if (option === "webSearchBackend") {
      return `set_config config.providerOptions.${provider}.webSearchBackend must be one of ${CODEX_WEB_SEARCH_BACKEND_VALUES.join(", ")}`;
    }

    if (option === "webSearchMode") {
      return `set_config config.providerOptions.${provider}.webSearchMode must be one of ${CODEX_WEB_SEARCH_MODE_VALUES.join(", ")}`;
    }

    if (option === "webSearch") {
      if (!nestedOption) {
        return `set_config config.providerOptions.${provider}.webSearch must be an object`;
      }
      if (nestedOption === "contextSize") {
        return `set_config config.providerOptions.${provider}.webSearch.contextSize must be one of ${CODEX_WEB_SEARCH_CONTEXT_SIZE_VALUES.join(", ")}`;
      }
      if (nestedOption === "allowedDomains") {
        return `set_config config.providerOptions.${provider}.webSearch.allowedDomains must be an array of non-empty strings`;
      }
      if (nestedOption === "location" && !nestedField) {
        return `set_config config.providerOptions.${provider}.webSearch.location must be an object`;
      }
      if (nestedOption === "location") {
        return `set_config config.providerOptions.${provider}.webSearch.location.${nestedField} must be a non-empty string`;
      }
      return `set_config config.providerOptions.${provider}.webSearch must be an object`;
    }

    if (option === "reasoningEffort") {
      return `set_config config.providerOptions.${provider}.reasoningEffort must be one of ${OPENAI_REASONING_EFFORT_VALUES.join(", ")}`;
    }

    if (option === "textVerbosity") {
      return `set_config config.providerOptions.${provider}.textVerbosity must be one of ${OPENAI_TEXT_VERBOSITY_VALUES.join(", ")}`;
    }

    if (option === "reasoningSummary") {
      return `set_config config.providerOptions.${provider}.reasoningSummary must be one of ${OPENAI_REASONING_SUMMARY_VALUES.join(", ")}`;
    }

    return "set_config missing/invalid config";
  }

  const message = setConfigFieldErrorMessages[field] ?? "set_config missing/invalid config";
  return message;
}

function schemaWithType<TType extends string>(
  type: TType,
  shape: z.ZodRawShape,
) {
  return z.object({
    type: z.literal(type),
    ...shape,
  }).passthrough();
}

function sessionOnlySchema<TType extends string>(type: TType) {
  return schemaWithType(type, {
    sessionId: requiredSessionId(type),
  });
}

function sessionAndFieldSchema<TType extends string>(
  type: TType,
  field: string,
  label?: string,
) {
  return schemaWithType(type, {
    sessionId: requiredSessionId(type),
    [field]: requiredNonEmptyTrimmedString(`${type} missing/invalid ${label ?? field}`),
  });
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
  "agent_list_get",
  "refresh_provider_status",
  "provider_catalog_get",
  "provider_auth_methods_get",
  "mcp_servers_get",
  "harness_context_get",
  "session_backup_get",
  "session_backup_checkpoint",
  "workspace_backups_get",
  "get_session_usage",
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

const sessionOnlySchemaList = sessionOnlyTypes.map((type) => sessionOnlySchema(type));

const sessionAndSkillNameSchemaList = sessionAndSkillNameTypes.map((type) => sessionAndFieldSchema(type, "skillName"));

const sessionAndNameSchemaList = sessionAndNameTypes.map((type) => sessionAndFieldSchema(type, "name"));

const clientHelloSchema = schemaWithType("client_hello", {
  client: requiredNonEmptyTrimmedString("client_hello missing/invalid client"),
  version: optionalString("client_hello invalid version"),
});

const userMessageSchema = schemaWithType("user_message", {
  sessionId: requiredSessionId("user_message"),
  text: requiredString("user_message missing text"),
  clientMessageId: optionalString("user_message invalid clientMessageId"),
});

const steerMessageSchema = schemaWithType("steer_message", {
  sessionId: requiredSessionId("steer_message"),
  expectedTurnId: requiredNonEmptyTrimmedString("steer_message missing/invalid expectedTurnId"),
  text: requiredNonEmptyTrimmedString("steer_message missing/invalid text"),
  clientMessageId: optionalString("steer_message invalid clientMessageId"),
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
  validateProviderAuthTarget(ctx, {
    provider: value["provider"],
    methodId: value["methodId"],
  }, "provider_auth_authorize");
});

const providerAuthLogoutSchema = schemaWithType("provider_auth_logout", {
  sessionId: requiredSessionId("provider_auth_logout"),
  provider: z.unknown(),
}).superRefine((value, ctx) => {
  if (!isProviderName(value.provider)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["provider"],
      message: "provider_auth_logout missing/invalid provider",
    });
  }
});

const providerAuthCallbackSchema = schemaWithType("provider_auth_callback", {
  sessionId: requiredSessionId("provider_auth_callback"),
  provider: z.unknown(),
  methodId: z.unknown(),
  code: z.unknown().optional(),
}).superRefine((value, ctx) => {
  if (!validateProviderAuthTarget(ctx, {
    provider: value["provider"],
    methodId: value["methodId"],
  }, "provider_auth_callback")) return;

  if (value["code"] !== undefined && typeof value["code"] !== "string") {
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
  if (!validateProviderAuthTarget(ctx, {
    provider: value["provider"],
    methodId: value["methodId"],
  }, "provider_auth_set_api_key")) return;

  if (!nonEmptyTrimmedStringSchema.safeParse(value["apiKey"]).success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["apiKey"],
      message: "provider_auth_set_api_key missing/invalid apiKey",
    });
  }
});

const providerAuthCopyApiKeySchema = schemaWithType("provider_auth_copy_api_key", {
  sessionId: requiredSessionId("provider_auth_copy_api_key"),
  provider: z.unknown(),
  sourceProvider: z.unknown(),
}).superRefine((value, ctx) => {
  if (!isProviderName(value.provider)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["provider"],
      message: "provider_auth_copy_api_key missing/invalid provider",
    });
  }

  if (!isProviderName(value.sourceProvider)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceProvider"],
      message: "provider_auth_copy_api_key missing/invalid sourceProvider",
    });
  }
});

const setEnableMcpSchema = schemaWithType("set_enable_mcp", {
  sessionId: requiredSessionId("set_enable_mcp"),
  enableMcp: requiredBoolean("set_enable_mcp missing/invalid enableMcp"),
});

const memoryListSchema = schemaWithType("memory_list", {
  sessionId: requiredSessionId("memory_list"),
  scope: z.enum(["workspace", "user"]).optional(),
});

const memoryUpsertSchema = schemaWithType("memory_upsert", {
  sessionId: requiredSessionId("memory_upsert"),
  scope: z.enum(["workspace", "user"], { error: "memory_upsert missing/invalid scope" }),
  id: z.string().optional(),
  content: requiredNonEmptyTrimmedString("memory_upsert missing/invalid content"),
});

const memoryDeleteSchema = schemaWithType("memory_delete", {
  sessionId: requiredSessionId("memory_delete"),
  scope: z.enum(["workspace", "user"], { error: "memory_delete missing/invalid scope" }),
  id: requiredNonEmptyTrimmedString("memory_delete missing/invalid id"),
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
  const apiKey = value["apiKey"];
  if (typeof apiKey === "string" && apiKey.length > MAX_MCP_API_KEY_SIZE) {
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

const workspaceBackupCheckpointSchema = schemaWithType("workspace_backup_checkpoint", {
  sessionId: requiredSessionId("workspace_backup_checkpoint"),
  targetSessionId: requiredNonEmptyTrimmedString("workspace_backup_checkpoint missing targetSessionId"),
});

const workspaceBackupRestoreSchema = schemaWithType("workspace_backup_restore", {
  sessionId: requiredSessionId("workspace_backup_restore"),
  targetSessionId: requiredNonEmptyTrimmedString("workspace_backup_restore missing targetSessionId"),
  checkpointId: optionalNonEmptyTrimmedString("workspace_backup_restore invalid checkpointId"),
});

const workspaceBackupDeleteCheckpointSchema = schemaWithType("workspace_backup_delete_checkpoint", {
  sessionId: requiredSessionId("workspace_backup_delete_checkpoint"),
  targetSessionId: requiredNonEmptyTrimmedString("workspace_backup_delete_checkpoint missing targetSessionId"),
  checkpointId: requiredNonEmptyTrimmedString("workspace_backup_delete_checkpoint missing checkpointId"),
});

const workspaceBackupDeleteEntrySchema = schemaWithType("workspace_backup_delete_entry", {
  sessionId: requiredSessionId("workspace_backup_delete_entry"),
  targetSessionId: requiredNonEmptyTrimmedString("workspace_backup_delete_entry missing targetSessionId"),
});

const workspaceBackupDeltaGetSchema = schemaWithType("workspace_backup_delta_get", {
  sessionId: requiredSessionId("workspace_backup_delta_get"),
  targetSessionId: requiredNonEmptyTrimmedString("workspace_backup_delta_get missing targetSessionId"),
  checkpointId: requiredNonEmptyTrimmedString("workspace_backup_delta_get missing checkpointId"),
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

const agentSpawnSchema = schemaWithType("agent_spawn", {
  sessionId: requiredSessionId("agent_spawn"),
  message: requiredNonEmptyTrimmedString("agent_spawn missing/invalid message"),
  role: z.enum(AGENT_ROLE_VALUES, { error: "agent_spawn invalid role" }).optional(),
  model: optionalNonEmptyTrimmedString("agent_spawn invalid model"),
  reasoningEffort: agentReasoningEffortSchema.optional(),
  forkContext: z.boolean({ error: "agent_spawn invalid forkContext" }).optional(),
});

const agentInputSendSchema = schemaWithType("agent_input_send", {
  sessionId: requiredSessionId("agent_input_send"),
  agentId: requiredNonEmptyTrimmedString("agent_input_send missing/invalid agentId"),
  message: requiredNonEmptyTrimmedString("agent_input_send missing/invalid message"),
  interrupt: z.boolean({ error: "agent_input_send invalid interrupt" }).optional(),
});

const agentWaitSchema = schemaWithType("agent_wait", {
  sessionId: requiredSessionId("agent_wait"),
  agentIds: z.array(requiredNonEmptyTrimmedString("agent_wait invalid agentIds")).min(1, { error: "agent_wait missing/invalid agentIds" }),
  timeoutMs: optionalNumberAtLeast("agent_wait invalid timeoutMs", 0),
});

const agentResumeSchema = schemaWithType("agent_resume", {
  sessionId: requiredSessionId("agent_resume"),
  agentId: requiredNonEmptyTrimmedString("agent_resume missing/invalid agentId"),
});

const agentCloseSchema = schemaWithType("agent_close", {
  sessionId: requiredSessionId("agent_close"),
  agentId: requiredNonEmptyTrimmedString("agent_close missing/invalid agentId"),
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
  if (parsedConfig.success) {
    if (
      parsedConfig.data.toolOutputOverflowChars !== undefined
      && parsedConfig.data.clearToolOutputOverflowChars === true
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["config"],
        message: "set_config config.toolOutputOverflowChars cannot be combined with clearToolOutputOverflowChars",
      });
    }
    return;
  }

  const issue = parsedConfig.error.issues[0];
  const message = issue ? setConfigIssueMessage(issue) : "set_config missing/invalid config";

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

const setSessionUsageBudgetSchema = schemaWithType("set_session_usage_budget", {
  sessionId: requiredSessionId("set_session_usage_budget"),
  warnAtUsd: optionalNullableNonNegativeNumber("set_session_usage_budget invalid warnAtUsd"),
  stopAtUsd: optionalNullableNonNegativeNumber("set_session_usage_budget invalid stopAtUsd"),
}).superRefine((value, ctx) => {
  if (value.warnAtUsd === undefined && value.stopAtUsd === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["warnAtUsd"],
      message: "set_session_usage_budget requires warnAtUsd and/or stopAtUsd",
    });
    return;
  }

  if (
    typeof value.warnAtUsd === "number"
    && typeof value.stopAtUsd === "number"
    && value.warnAtUsd >= value.stopAtUsd
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["warnAtUsd"],
      message: "set_session_usage_budget warnAtUsd must be less than stopAtUsd",
    });
  }
});

const clientMessageSchema = z.discriminatedUnion("type", [
  ...sessionOnlySchemaList,
  ...sessionAndSkillNameSchemaList,
  ...sessionAndNameSchemaList,
  clientHelloSchema,
  userMessageSchema,
  steerMessageSchema,
  askResponseSchema,
  approvalResponseSchema,
  executeCommandSchema,
  setModelSchema,
  providerAuthAuthorizeSchema,
  providerAuthLogoutSchema,
  providerAuthCallbackSchema,
  providerAuthSetApiKeySchema,
  providerAuthCopyApiKeySchema,
  setEnableMcpSchema,
  memoryListSchema,
  memoryUpsertSchema,
  memoryDeleteSchema,
  mcpServerUpsertSchema,
  mcpServerAuthCallbackSchema,
  mcpServerAuthSetApiKeySchema,
  mcpServersMigrateLegacySchema,
  harnessContextSetSchema,
  sessionBackupRestoreSchema,
  sessionBackupDeleteCheckpointSchema,
  workspaceBackupCheckpointSchema,
  workspaceBackupRestoreSchema,
  workspaceBackupDeleteCheckpointSchema,
  workspaceBackupDeleteEntrySchema,
  workspaceBackupDeltaGetSchema,
  getMessagesSchema,
  setSessionTitleSchema,
  deleteSessionSchema,
  agentSpawnSchema,
  agentInputSendSchema,
  agentWaitSchema,
  agentResumeSchema,
  agentCloseSchema,
  setConfigSchema,
  uploadFileSchema,
  setSessionUsageBudgetSchema,
] as unknown as [any, ...any[]]);

type ParsedClientMessage = Record<string, unknown> & { type: ClientMessage["type"] };

function normalizeClientMessage(parsed: ParsedClientMessage): ClientMessage {
  switch (parsed.type) {
    case "set_model": {
      const sessionId = parsed.sessionId as string;
      const model = parsed.model as string;
      const { provider } = parsed;
      if (provider !== undefined && !isProviderName(provider)) {
        throw new Error(`set_model invalid provider: ${String(provider)}`);
      }
      return {
        type: "set_model",
        sessionId,
        model,
        ...(provider !== undefined ? { provider } : {}),
      };
    }
    case "provider_auth_authorize": {
      const sessionId = parsed.sessionId as string;
      const methodId = parsed.methodId as string;
      if (!isProviderName(parsed.provider)) {
        throw new Error("provider_auth_authorize missing/invalid provider");
      }
      if (!nonEmptyTrimmedStringSchema.safeParse(methodId).success) {
        throw new Error("provider_auth_authorize missing/invalid methodId");
      }
      return {
        type: "provider_auth_authorize",
        sessionId,
        provider: parsed.provider,
        methodId,
      };
    }
    case "provider_auth_logout": {
      const sessionId = parsed.sessionId as string;
      if (!isProviderName(parsed.provider)) {
        throw new Error("provider_auth_logout missing/invalid provider");
      }
      return {
        type: "provider_auth_logout",
        sessionId,
        provider: parsed.provider,
      };
    }
    case "provider_auth_callback": {
      const sessionId = parsed.sessionId as string;
      const methodId = parsed.methodId as string;
      if (!isProviderName(parsed.provider)) {
        throw new Error("provider_auth_callback missing/invalid provider");
      }
      if (!nonEmptyTrimmedStringSchema.safeParse(methodId).success) {
        throw new Error("provider_auth_callback missing/invalid methodId");
      }
      if (parsed.code !== undefined && typeof parsed.code !== "string") {
        throw new Error("provider_auth_callback invalid code");
      }
      return {
        type: "provider_auth_callback",
        sessionId,
        provider: parsed.provider,
        methodId,
        ...(parsed.code !== undefined ? { code: parsed.code } : {}),
      };
    }
    case "provider_auth_set_api_key": {
      const sessionId = parsed.sessionId as string;
      const methodId = parsed.methodId as string;
      const apiKey = parsed.apiKey as string;
      if (!isProviderName(parsed.provider)) {
        throw new Error("provider_auth_set_api_key missing/invalid provider");
      }
      if (!nonEmptyTrimmedStringSchema.safeParse(methodId).success) {
        throw new Error("provider_auth_set_api_key missing/invalid methodId");
      }
      if (!nonEmptyTrimmedStringSchema.safeParse(apiKey).success) {
        throw new Error("provider_auth_set_api_key missing/invalid apiKey");
      }
      return {
        type: "provider_auth_set_api_key",
        sessionId,
        provider: parsed.provider,
        methodId,
        apiKey,
      };
    }
    case "provider_auth_copy_api_key": {
      const sessionId = parsed.sessionId as string;
      if (!isProviderName(parsed.provider)) {
        throw new Error("provider_auth_copy_api_key missing/invalid provider");
      }
      if (!isProviderName(parsed.sourceProvider)) {
        throw new Error("provider_auth_copy_api_key missing/invalid sourceProvider");
      }
      return {
        type: "provider_auth_copy_api_key",
        sessionId,
        provider: parsed.provider,
        sourceProvider: parsed.sourceProvider,
      };
    }
    case "mcp_server_upsert": {
      const sessionId = parsed.sessionId as string;
      const previousName = parsed.previousName as string | undefined;
      if (parsed.previousName !== undefined && !nonEmptyTrimmedStringSchema.safeParse(parsed.previousName).success) {
        throw new Error("mcp_server_upsert invalid previousName");
      }
      return {
        type: "mcp_server_upsert",
        sessionId,
        server: parseMCPServerConfig(parsed.server),
        ...(previousName !== undefined ? { previousName } : {}),
      };
    }
    case "harness_context_set": {
      const sessionId = parsed.sessionId as string;
      const parsedContext = harnessContextSchema.safeParse(parsed.context);
      if (!parsedContext.success) {
        throw new Error("harness_context_set missing/invalid context");
      }
      return {
        type: "harness_context_set",
        sessionId,
        context: parsedContext.data,
      };
    }
    case "set_config": {
      const sessionId = parsed.sessionId as string;
      const parsedConfig = setConfigPayloadSchema.safeParse(parsed.config);
      if (!parsedConfig.success) {
        throw new Error("set_config missing/invalid config");
      }
      return {
        type: "set_config",
        sessionId,
        config: parsedConfig.data,
      };
    }
    default:
      return parsed as ClientMessage;
  }
}

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
  try {
    return ok(normalizeClientMessage(parsedMessage.data as ParsedClientMessage));
  } catch (normalizeError) {
    const message = normalizeError instanceof Error ? normalizeError.message : "validation_failed";
    return err(message || "validation_failed");
  }
}
