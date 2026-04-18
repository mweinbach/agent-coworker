import { z } from "zod";

import {
  jsonRpcA2uiRequestSchemas,
  jsonRpcA2uiResultSchemas,
} from "./schema.a2ui";
import {
  jsonRpcAgentNotificationSchemas,
  jsonRpcAgentRequestSchemas,
  jsonRpcAgentResultSchemas,
} from "./schema.agents";
import { jsonRpcBackupsRequestSchemas, jsonRpcBackupsResultSchemas } from "./schema.backups";
import {
  jsonRpcCoreRequestSchemas,
  jsonRpcCoreResultSchemas,
  jsonRpcInitializeParamsSchema,
  jsonRpcInitializedParamsSchema,
} from "./schema.core";
import { jsonRpcMemoryRequestSchemas, jsonRpcMemoryResultSchemas } from "./schema.memory";
import { jsonRpcMiscNotificationSchemas } from "./schema.misc";
import { jsonRpcMcpRequestSchemas, jsonRpcMcpResultSchemas } from "./schema.mcp";
import { jsonRpcPluginsRequestSchemas, jsonRpcPluginsResultSchemas } from "./schema.plugins";
import { jsonRpcProviderRequestSchemas, jsonRpcProviderResultSchemas } from "./schema.provider";
import {
  jsonRpcSessionNotificationSchemas,
  jsonRpcSessionRequestSchemas,
  jsonRpcSessionResultSchemas,
} from "./schema.session";
import { jsonRpcSkillsRequestSchemas, jsonRpcSkillsResultSchemas } from "./schema.skills";
import {
  jsonRpcThreadTurnNotificationSchemas,
  jsonRpcThreadTurnRequestSchemas,
  jsonRpcThreadTurnResultSchemas,
  jsonRpcThreadTurnServerRequestSchemas,
} from "./schema.threadTurn";

export { jsonRpcInitializeParamsSchema, jsonRpcInitializedParamsSchema };

export const jsonRpcRequestSchemas = {
  ...jsonRpcCoreRequestSchemas,
  ...jsonRpcThreadTurnRequestSchemas,
  ...jsonRpcSessionRequestSchemas,
  ...jsonRpcAgentRequestSchemas,
  ...jsonRpcProviderRequestSchemas,
  ...jsonRpcMcpRequestSchemas,
  ...jsonRpcPluginsRequestSchemas,
  ...jsonRpcSkillsRequestSchemas,
  ...jsonRpcMemoryRequestSchemas,
  ...jsonRpcBackupsRequestSchemas,
  ...jsonRpcA2uiRequestSchemas,
} as const;

export const jsonRpcNotificationSchemas = {
  ...jsonRpcThreadTurnNotificationSchemas,
  ...jsonRpcSessionNotificationSchemas,
  ...jsonRpcAgentNotificationSchemas,
  ...jsonRpcMiscNotificationSchemas,
} as const;

export const jsonRpcServerRequestSchemas = {
  ...jsonRpcThreadTurnServerRequestSchemas,
} as const;

export const jsonRpcResultSchemas = {
  ...jsonRpcCoreResultSchemas,
  ...jsonRpcThreadTurnResultSchemas,
  ...jsonRpcSessionResultSchemas,
  ...jsonRpcAgentResultSchemas,
  ...jsonRpcProviderResultSchemas,
  ...jsonRpcMcpResultSchemas,
  ...jsonRpcPluginsResultSchemas,
  ...jsonRpcSkillsResultSchemas,
  ...jsonRpcMemoryResultSchemas,
  ...jsonRpcBackupsResultSchemas,
  ...jsonRpcA2uiResultSchemas,
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
