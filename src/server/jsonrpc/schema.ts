import { z } from "zod";

const nonEmptyTrimmedStringSchema = z.string().trim().min(1);
const optionalNonEmptyTrimmedStringSchema = nonEmptyTrimmedStringSchema.optional();
const targetScopeSchema = z.enum(["project", "global"]);
const workspaceMemoryScopeSchema = z.enum(["workspace", "user"]);
const anyObjectSchema = z.record(z.string(), z.unknown());
const legacyEventEnvelope = <T extends z.ZodTypeAny>(eventSchema: T) => z.object({ event: eventSchema }).strict();
const legacyEventsEnvelope = <T extends z.ZodTypeAny>(eventSchema: T) => z.object({ events: z.array(eventSchema).min(1) }).strict();
const providerCatalogEventSchema = z.object({
  type: z.literal("provider_catalog"),
  all: z.array(z.unknown()),
  default: z.record(z.string(), z.string()),
  connected: z.array(z.string()),
}).passthrough();
const providerAuthMethodsEventSchema = z.object({
  type: z.literal("provider_auth_methods"),
  methods: z.record(z.string(), z.array(z.unknown())),
}).passthrough();
const providerStatusEventSchema = z.object({
  type: z.literal("provider_status"),
  providers: z.array(z.unknown()),
}).passthrough();
const providerAuthChallengeEventSchema = z.object({
  type: z.literal("provider_auth_challenge"),
}).passthrough();
const providerAuthResultEventSchema = z.object({
  type: z.literal("provider_auth_result"),
}).passthrough();
const mcpServersEventSchema = z.object({
  type: z.literal("mcp_servers"),
  servers: z.array(z.unknown()),
  files: z.array(z.unknown()),
}).passthrough();
const mcpValidationEventSchema = z.object({
  type: z.literal("mcp_server_validation"),
}).passthrough();
const mcpAuthChallengeEventSchema = z.object({
  type: z.literal("mcp_server_auth_challenge"),
}).passthrough();
const mcpAuthResultEventSchema = z.object({
  type: z.literal("mcp_server_auth_result"),
}).passthrough();
const skillsCatalogEventSchema = z.object({
  type: z.literal("skills_catalog"),
}).passthrough();
const skillsListEventSchema = z.object({
  type: z.literal("skills_list"),
  skills: z.array(z.unknown()),
}).passthrough();
const skillContentEventSchema = z.object({
  type: z.literal("skill_content"),
}).passthrough();
const skillInstallationEventSchema = z.object({
  type: z.literal("skill_installation"),
}).passthrough();
const skillInstallPreviewEventSchema = z.object({
  type: z.literal("skill_install_preview"),
}).passthrough();
const skillInstallUpdateCheckEventSchema = z.object({
  type: z.literal("skill_installation_update_check"),
}).passthrough();
const memoryListEventSchema = z.object({
  type: z.literal("memory_list"),
  memories: z.array(z.unknown()),
}).passthrough();
const workspaceBackupsEventSchema = z.object({
  type: z.literal("workspace_backups"),
  workspacePath: z.string(),
  backups: z.array(z.unknown()),
}).passthrough();
const workspaceBackupDeltaEventSchema = z.object({
  type: z.literal("workspace_backup_delta"),
}).passthrough();
const sessionInfoEventSchema = z.object({
  type: z.literal("session_info"),
  title: z.string(),
}).passthrough();
const configUpdatedEventSchema = z.object({
  type: z.literal("config_updated"),
  config: anyObjectSchema,
}).passthrough();
const sessionConfigEventSchema = z.object({
  type: z.literal("session_config"),
  config: anyObjectSchema,
}).passthrough();
const sessionSettingsEventSchema = z.object({
  type: z.literal("session_settings"),
  enableMcp: z.boolean(),
  enableMemory: z.boolean(),
  memoryRequireApproval: z.boolean(),
}).passthrough();
const sessionUsageEventSchema = z.object({
  type: z.literal("session_usage"),
}).passthrough();
const steerAcceptedEventSchema = z.object({
  type: z.literal("steer_accepted"),
  turnId: nonEmptyTrimmedStringSchema,
  text: z.string(),
  clientMessageId: nonEmptyTrimmedStringSchema.optional(),
}).passthrough();
const turnUsageEventSchema = z.object({
  type: z.literal("turn_usage"),
  turnId: nonEmptyTrimmedStringSchema,
}).passthrough();
const budgetWarningEventSchema = z.object({
  type: z.literal("budget_warning"),
  message: z.string(),
}).passthrough();
const budgetExceededEventSchema = z.object({
  type: z.literal("budget_exceeded"),
  message: z.string(),
}).passthrough();
const sessionBackupStateEventSchema = z.object({
  type: z.literal("session_backup_state"),
}).passthrough();
const harnessContextEventSchema = z.object({
  type: z.literal("harness_context"),
}).passthrough();
const agentListEventSchema = z.object({
  type: z.literal("agent_list"),
  agents: z.array(z.unknown()),
}).passthrough();
const agentSpawnedEventSchema = z.object({
  type: z.literal("agent_spawned"),
  agent: z.unknown(),
}).passthrough();
const agentStatusEventSchema = z.object({
  type: z.literal("agent_status"),
  agent: z.unknown(),
}).passthrough();
const agentWaitResultEventSchema = z.object({
  type: z.literal("agent_wait_result"),
  agentIds: z.array(z.string()),
  agents: z.array(z.unknown()),
}).passthrough();
const todosEventSchema = z.object({
  type: z.literal("todos"),
  todos: z.array(z.unknown()),
}).passthrough();
const logEventSchema = z.object({
  type: z.literal("log"),
  line: z.string(),
}).passthrough();
const errorEventSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
  code: z.string(),
  source: z.string(),
}).passthrough();
const sessionDeletedEventSchema = z.object({
  type: z.literal("session_deleted"),
}).passthrough();

export const jsonRpcInitializeParamsSchema = z.object({
  clientInfo: z.object({
    name: nonEmptyTrimmedStringSchema,
    title: z.string().optional(),
    version: z.string().optional(),
  }).strict(),
  capabilities: z.object({
    experimentalApi: z.boolean().optional(),
    optOutNotificationMethods: z.array(nonEmptyTrimmedStringSchema).optional(),
  }).strict().optional(),
}).strict();

export const jsonRpcInitializedParamsSchema = z.object({}).strict();

export const jsonRpcRequestSchemas = {
  initialize: jsonRpcInitializeParamsSchema,
  initialized: jsonRpcInitializedParamsSchema,
  "thread/start": z.object({
    cwd: nonEmptyTrimmedStringSchema.optional(),
    provider: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
  }).strict(),
  "thread/resume": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    afterSeq: z.number().int().nonnegative().optional(),
  }).strict(),
  "thread/list": z.object({
    cwd: nonEmptyTrimmedStringSchema.optional(),
  }).strict(),
  "thread/read": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    includeTurns: z.boolean().optional(),
  }).strict(),
  "thread/unsubscribe": z.object({
    threadId: nonEmptyTrimmedStringSchema,
  }).strict(),
  "turn/start": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    clientMessageId: nonEmptyTrimmedStringSchema.optional(),
    input: z.array(z.object({
      type: z.literal("text"),
      text: z.string(),
    }).strict()),
  }).strict(),
  "turn/steer": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    turnId: nonEmptyTrimmedStringSchema,
    clientMessageId: nonEmptyTrimmedStringSchema.optional(),
    input: z.array(z.object({
      type: z.literal("text"),
      text: z.string(),
    }).strict()),
  }).strict(),
  "turn/interrupt": z.object({
    threadId: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/session/title/set": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    title: z.string(),
  }).strict(),
  "cowork/session/state/read": z.object({
    cwd: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/session/model/set": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    provider: optionalNonEmptyTrimmedStringSchema,
    model: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/session/usageBudget/set": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    warnAtUsd: z.number().nullable().optional(),
    stopAtUsd: z.number().nullable().optional(),
  }).strict(),
  "cowork/session/config/set": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    config: anyObjectSchema,
  }).strict(),
  "cowork/session/defaults/apply": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    threadId: optionalNonEmptyTrimmedStringSchema,
    provider: optionalNonEmptyTrimmedStringSchema,
    model: optionalNonEmptyTrimmedStringSchema,
    enableMcp: z.boolean().optional(),
    config: anyObjectSchema.optional(),
  }).strict(),
  "cowork/session/delete": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    targetSessionId: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/provider/catalog/read": z.object({
    cwd: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/provider/authMethods/read": z.object({
    cwd: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/provider/status/refresh": z.object({
    cwd: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/provider/auth/authorize": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    provider: nonEmptyTrimmedStringSchema,
    methodId: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/provider/auth/logout": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    provider: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/provider/auth/callback": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    provider: nonEmptyTrimmedStringSchema,
    methodId: nonEmptyTrimmedStringSchema,
    code: z.string().optional(),
  }).strict(),
  "cowork/provider/auth/setApiKey": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    provider: nonEmptyTrimmedStringSchema,
    methodId: nonEmptyTrimmedStringSchema,
    apiKey: z.string(),
  }).strict(),
  "cowork/provider/auth/copyApiKey": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    provider: nonEmptyTrimmedStringSchema,
    sourceProvider: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/mcp/servers/read": z.object({
    cwd: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/mcp/server/upsert": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    server: anyObjectSchema,
    previousName: z.string().optional(),
  }).strict(),
  "cowork/mcp/server/delete": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    name: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/mcp/server/validate": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    name: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/mcp/server/auth/authorize": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    name: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/mcp/server/auth/callback": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    name: nonEmptyTrimmedStringSchema,
    code: z.string().optional(),
  }).strict(),
  "cowork/mcp/server/auth/setApiKey": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    name: nonEmptyTrimmedStringSchema,
    apiKey: z.string(),
  }).strict(),
  "cowork/mcp/legacy/migrate": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    scope: z.enum(["workspace", "user"]),
  }).strict(),
  "cowork/skills/catalog/read": z.object({
    cwd: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/skills/list": z.object({
    cwd: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/skills/read": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    skillName: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/skills/disable": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    skillName: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/skills/enable": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    skillName: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/skills/delete": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    skillName: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/skills/installation/read": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    installationId: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/skills/install/preview": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    sourceInput: z.string(),
    targetScope: targetScopeSchema,
  }).strict(),
  "cowork/skills/install": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    sourceInput: z.string(),
    targetScope: targetScopeSchema,
  }).strict(),
  "cowork/skills/installation/enable": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    installationId: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/skills/installation/disable": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    installationId: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/skills/installation/delete": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    installationId: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/skills/installation/update": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    installationId: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/skills/installation/copy": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    installationId: nonEmptyTrimmedStringSchema,
    targetScope: targetScopeSchema,
  }).strict(),
  "cowork/skills/installation/checkUpdate": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    installationId: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/memory/list": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    scope: workspaceMemoryScopeSchema.optional(),
  }).strict(),
  "cowork/memory/upsert": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    scope: workspaceMemoryScopeSchema,
    id: z.string().optional(),
    content: z.string(),
  }).strict(),
  "cowork/memory/delete": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    scope: workspaceMemoryScopeSchema,
    id: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/backups/workspace/read": z.object({
    cwd: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/backups/workspace/delta/read": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    targetSessionId: nonEmptyTrimmedStringSchema,
    checkpointId: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/backups/workspace/checkpoint": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    targetSessionId: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/backups/workspace/restore": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    targetSessionId: nonEmptyTrimmedStringSchema,
    checkpointId: z.string().optional(),
  }).strict(),
  "cowork/backups/workspace/deleteCheckpoint": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    targetSessionId: nonEmptyTrimmedStringSchema,
    checkpointId: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/backups/workspace/deleteEntry": z.object({
    cwd: nonEmptyTrimmedStringSchema,
    targetSessionId: nonEmptyTrimmedStringSchema,
  }).strict(),
} as const;

export const jsonRpcNotificationSchemas = {
  "thread/started": z.object({
    thread: z.object({
      id: nonEmptyTrimmedStringSchema,
      title: z.string(),
      preview: z.string(),
      modelProvider: z.string(),
      model: z.string(),
      cwd: z.string(),
      createdAt: z.string(),
      updatedAt: z.string(),
      messageCount: z.number().int().nonnegative(),
      lastEventSeq: z.number().int().nonnegative(),
      status: z.object({
        type: z.string(),
      }).strict(),
    }).strict(),
  }).strict(),
  "turn/started": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    turn: z.object({
      id: nonEmptyTrimmedStringSchema,
      status: z.string(),
      items: z.array(z.unknown()),
    }).strict(),
  }).strict(),
  "item/started": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    turnId: nonEmptyTrimmedStringSchema,
    item: z.record(z.string(), z.unknown()),
  }).strict(),
  "item/reasoning/delta": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    turnId: nonEmptyTrimmedStringSchema,
    itemId: nonEmptyTrimmedStringSchema,
    mode: z.enum(["reasoning", "summary"]),
    delta: z.string(),
  }).strict(),
  "item/agentMessage/delta": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    turnId: nonEmptyTrimmedStringSchema,
    itemId: nonEmptyTrimmedStringSchema,
    delta: z.string(),
  }).strict(),
  "item/completed": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    turnId: nonEmptyTrimmedStringSchema,
    item: z.record(z.string(), z.unknown()),
  }).strict(),
  "turn/completed": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    turn: z.object({
      id: nonEmptyTrimmedStringSchema,
      status: z.string(),
    }).strict(),
  }).strict(),
  "serverRequest/resolved": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    requestId: nonEmptyTrimmedStringSchema,
  }).strict(),
  "cowork/session/settings": sessionSettingsEventSchema,
  "cowork/session/info": sessionInfoEventSchema,
  "cowork/session/configUpdated": configUpdatedEventSchema,
  "cowork/session/config": sessionConfigEventSchema,
  "cowork/session/usage": sessionUsageEventSchema,
  "cowork/session/steerAccepted": steerAcceptedEventSchema,
  "cowork/session/turnUsage": turnUsageEventSchema,
  "cowork/session/budgetWarning": budgetWarningEventSchema,
  "cowork/session/budgetExceeded": budgetExceededEventSchema,
  "cowork/session/backupState": sessionBackupStateEventSchema,
  "cowork/session/harnessContext": harnessContextEventSchema,
  "cowork/session/agentList": agentListEventSchema,
  "cowork/session/agentSpawned": agentSpawnedEventSchema,
  "cowork/session/agentStatus": agentStatusEventSchema,
  "cowork/session/agentWaitResult": agentWaitResultEventSchema,
  "cowork/log": logEventSchema,
  "cowork/todos": todosEventSchema,
  error: errorEventSchema,
} as const;

export const jsonRpcServerRequestSchemas = {
  "item/tool/requestUserInput": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    turnId: nonEmptyTrimmedStringSchema.nullable().optional(),
    requestId: nonEmptyTrimmedStringSchema,
    itemId: nonEmptyTrimmedStringSchema,
    question: z.string(),
    options: z.array(z.string()).optional(),
  }).strict(),
  "item/commandExecution/requestApproval": z.object({
    threadId: nonEmptyTrimmedStringSchema,
    turnId: nonEmptyTrimmedStringSchema.nullable().optional(),
    requestId: nonEmptyTrimmedStringSchema,
    itemId: nonEmptyTrimmedStringSchema,
    command: z.string(),
    dangerous: z.boolean(),
    reason: z.string(),
  }).strict(),
} as const;

export const jsonRpcResultSchemas = {
  initialize: z.object({
    protocolVersion: z.string(),
    serverInfo: z.object({
      name: z.string(),
      subprotocol: z.string().optional(),
    }).strict(),
    capabilities: z.object({
      experimentalApi: z.boolean(),
    }).strict(),
    transport: z.object({
      type: z.literal("websocket"),
      protocolMode: z.enum(["legacy", "jsonrpc"]),
    }).strict(),
  }).strict(),
  "thread/start": z.object({
    thread: jsonRpcNotificationSchemas["thread/started"].shape.thread,
  }).strict(),
  "thread/resume": z.object({
    thread: jsonRpcNotificationSchemas["thread/started"].shape.thread,
  }).strict(),
  "thread/list": z.object({
    threads: z.array(jsonRpcNotificationSchemas["thread/started"].shape.thread),
  }).strict(),
  "thread/read": z.object({
    thread: jsonRpcNotificationSchemas["thread/started"].shape.thread.extend({
      turns: z.array(z.unknown()).optional(),
    }),
    coworkSnapshot: z.unknown().nullable(),
    journalTailSeq: z.number().int().nonnegative().optional(),
  }).strict(),
  "thread/unsubscribe": z.object({
    status: z.enum(["unsubscribed", "notSubscribed", "notLoaded"]),
  }).strict(),
  "turn/start": z.object({
    turn: z.object({
      id: z.string().nullable(),
      threadId: nonEmptyTrimmedStringSchema,
      status: z.string(),
      items: z.array(z.unknown()),
    }).strict(),
  }).strict(),
  "turn/steer": z.object({
    turnId: nonEmptyTrimmedStringSchema,
  }).strict(),
  "turn/interrupt": z.object({}).strict(),
  "cowork/session/title/set": legacyEventEnvelope(sessionInfoEventSchema),
  "cowork/session/state/read": legacyEventsEnvelope(z.union([
    configUpdatedEventSchema,
    sessionSettingsEventSchema,
    sessionConfigEventSchema,
  ])),
  "cowork/session/model/set": legacyEventEnvelope(configUpdatedEventSchema),
  "cowork/session/usageBudget/set": legacyEventEnvelope(sessionUsageEventSchema),
  "cowork/session/config/set": legacyEventEnvelope(sessionConfigEventSchema),
  "cowork/session/defaults/apply": legacyEventEnvelope(sessionConfigEventSchema),
  "cowork/session/delete": legacyEventEnvelope(sessionDeletedEventSchema),
  "cowork/provider/catalog/read": legacyEventEnvelope(providerCatalogEventSchema),
  "cowork/provider/authMethods/read": legacyEventEnvelope(providerAuthMethodsEventSchema),
  "cowork/provider/status/refresh": legacyEventEnvelope(providerStatusEventSchema),
  "cowork/provider/auth/authorize": legacyEventEnvelope(z.union([providerAuthChallengeEventSchema, providerAuthResultEventSchema])),
  "cowork/provider/auth/logout": legacyEventEnvelope(providerAuthResultEventSchema),
  "cowork/provider/auth/callback": legacyEventEnvelope(providerAuthResultEventSchema),
  "cowork/provider/auth/setApiKey": legacyEventEnvelope(providerAuthResultEventSchema),
  "cowork/provider/auth/copyApiKey": legacyEventEnvelope(providerAuthResultEventSchema),
  "cowork/mcp/servers/read": legacyEventEnvelope(mcpServersEventSchema),
  "cowork/mcp/server/upsert": legacyEventEnvelope(mcpServersEventSchema),
  "cowork/mcp/server/delete": legacyEventEnvelope(mcpServersEventSchema),
  "cowork/mcp/server/validate": legacyEventEnvelope(mcpValidationEventSchema),
  "cowork/mcp/server/auth/authorize": legacyEventEnvelope(z.union([mcpAuthChallengeEventSchema, mcpAuthResultEventSchema])),
  "cowork/mcp/server/auth/callback": legacyEventEnvelope(mcpAuthResultEventSchema),
  "cowork/mcp/server/auth/setApiKey": legacyEventEnvelope(mcpAuthResultEventSchema),
  "cowork/mcp/legacy/migrate": legacyEventEnvelope(mcpServersEventSchema),
  "cowork/skills/catalog/read": legacyEventEnvelope(skillsCatalogEventSchema),
  "cowork/skills/list": legacyEventEnvelope(skillsListEventSchema),
  "cowork/skills/read": legacyEventEnvelope(skillContentEventSchema),
  "cowork/skills/disable": legacyEventEnvelope(skillsListEventSchema),
  "cowork/skills/enable": legacyEventEnvelope(skillsListEventSchema),
  "cowork/skills/delete": legacyEventEnvelope(skillsListEventSchema),
  "cowork/skills/installation/read": legacyEventEnvelope(skillInstallationEventSchema),
  "cowork/skills/install/preview": legacyEventEnvelope(skillInstallPreviewEventSchema),
  "cowork/skills/install": legacyEventEnvelope(skillsCatalogEventSchema),
  "cowork/skills/installation/enable": legacyEventEnvelope(skillsCatalogEventSchema),
  "cowork/skills/installation/disable": legacyEventEnvelope(skillsCatalogEventSchema),
  "cowork/skills/installation/delete": legacyEventEnvelope(skillsCatalogEventSchema),
  "cowork/skills/installation/update": legacyEventEnvelope(skillsCatalogEventSchema),
  "cowork/skills/installation/copy": legacyEventEnvelope(skillsCatalogEventSchema),
  "cowork/skills/installation/checkUpdate": legacyEventEnvelope(skillInstallUpdateCheckEventSchema),
  "cowork/memory/list": legacyEventEnvelope(memoryListEventSchema),
  "cowork/memory/upsert": legacyEventEnvelope(memoryListEventSchema),
  "cowork/memory/delete": legacyEventEnvelope(memoryListEventSchema),
  "cowork/backups/workspace/read": legacyEventEnvelope(workspaceBackupsEventSchema),
  "cowork/backups/workspace/delta/read": legacyEventEnvelope(workspaceBackupDeltaEventSchema),
  "cowork/backups/workspace/checkpoint": legacyEventEnvelope(workspaceBackupsEventSchema),
  "cowork/backups/workspace/restore": legacyEventEnvelope(workspaceBackupsEventSchema),
  "cowork/backups/workspace/deleteCheckpoint": legacyEventEnvelope(workspaceBackupsEventSchema),
  "cowork/backups/workspace/deleteEntry": legacyEventEnvelope(workspaceBackupsEventSchema),
} as const;

export const jsonRpcSchemaBundle = {
  requests: jsonRpcRequestSchemas,
  results: jsonRpcResultSchemas,
  notifications: jsonRpcNotificationSchemas,
  serverRequests: jsonRpcServerRequestSchemas,
};

export const jsonRpcSchemaBundleSchema = z.object({
  requests: z.object(jsonRpcRequestSchemas),
  results: z.object(jsonRpcResultSchemas),
  notifications: z.object(jsonRpcNotificationSchemas),
  serverRequests: z.object(jsonRpcServerRequestSchemas),
}).strict();
