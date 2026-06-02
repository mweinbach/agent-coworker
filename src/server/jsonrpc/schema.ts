import { z } from "zod";

import {
  jsonRpcAgentNotificationSchemas,
  jsonRpcAgentRequestSchemas,
  jsonRpcAgentResultSchemas,
} from "./schema.agents";
import {
  jsonRpcAgentProfilesNotificationSchemas,
  jsonRpcAgentProfilesRequestSchemas,
  jsonRpcAgentProfilesResultSchemas,
} from "./schema.agentProfiles";
import { jsonRpcBackupsRequestSchemas, jsonRpcBackupsResultSchemas } from "./schema.backups";
import {
  jsonRpcConnectorsRequestSchemas,
  jsonRpcConnectorsResultSchemas,
} from "./schema.connectors";
import { jsonRpcCoreRequestSchemas, jsonRpcCoreResultSchemas } from "./schema.core";
import { jsonRpcImportRequestSchemas, jsonRpcImportResultSchemas } from "./schema.import";
import { jsonRpcMemoryRequestSchemas, jsonRpcMemoryResultSchemas } from "./schema.memory";
import { jsonRpcMiscNotificationSchemas } from "./schema.misc";
import { jsonRpcMcpRequestSchemas, jsonRpcMcpResultSchemas } from "./schema.mcp";
import { jsonRpcPluginsRequestSchemas, jsonRpcPluginsResultSchemas } from "./schema.plugins";
import { jsonRpcProviderRequestSchemas, jsonRpcProviderResultSchemas } from "./schema.provider";
import {
  jsonRpcResearchNotificationSchemas,
  jsonRpcResearchRequestSchemas,
  jsonRpcResearchResultSchemas,
} from "./schema.research";
import { jsonRpcRuntimeRequestSchemas, jsonRpcRuntimeResultSchemas } from "./schema.runtime";
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
import {
  jsonRpcWorkspaceRequestSchemas,
  jsonRpcWorkspaceResultSchemas,
} from "./schema.workspace";

export const jsonRpcRequestSchemas = {
  ...jsonRpcCoreRequestSchemas,
  ...jsonRpcThreadTurnRequestSchemas,
  ...jsonRpcSessionRequestSchemas,
  ...jsonRpcAgentRequestSchemas,
  ...jsonRpcAgentProfilesRequestSchemas,
  ...jsonRpcConnectorsRequestSchemas,
  ...jsonRpcProviderRequestSchemas,
  ...jsonRpcRuntimeRequestSchemas,
  ...jsonRpcResearchRequestSchemas,
  ...jsonRpcMcpRequestSchemas,
  ...jsonRpcPluginsRequestSchemas,
  ...jsonRpcSkillsRequestSchemas,
  ...jsonRpcImportRequestSchemas,
  ...jsonRpcMemoryRequestSchemas,
  ...jsonRpcBackupsRequestSchemas,
  ...jsonRpcWorkspaceRequestSchemas,
} as const;

export const jsonRpcNotificationSchemas = {
  ...jsonRpcThreadTurnNotificationSchemas,
  ...jsonRpcSessionNotificationSchemas,
  ...jsonRpcAgentNotificationSchemas,
  ...jsonRpcAgentProfilesNotificationSchemas,
  ...jsonRpcResearchNotificationSchemas,
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
  ...jsonRpcAgentProfilesResultSchemas,
  ...jsonRpcConnectorsResultSchemas,
  ...jsonRpcProviderResultSchemas,
  ...jsonRpcRuntimeResultSchemas,
  ...jsonRpcResearchResultSchemas,
  ...jsonRpcMcpResultSchemas,
  ...jsonRpcPluginsResultSchemas,
  ...jsonRpcSkillsResultSchemas,
  ...jsonRpcImportResultSchemas,
  ...jsonRpcMemoryResultSchemas,
  ...jsonRpcBackupsResultSchemas,
  ...jsonRpcWorkspaceResultSchemas,
} as const;

export const jsonRpcSchemaBundleSchema = z.object({
  requests: z.object(jsonRpcRequestSchemas),
  results: z.object(jsonRpcResultSchemas),
  notifications: z.object(jsonRpcNotificationSchemas),
  serverRequests: z.object(jsonRpcServerRequestSchemas),
}).strict();
