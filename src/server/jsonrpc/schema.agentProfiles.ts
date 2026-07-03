import { z } from "zod";

import {
  agentProfileCopyInputSchema,
  agentProfileScopeSchema,
  agentProfilesCatalogSchema,
  agentProfileUpsertInputSchema,
} from "../../shared/agentProfiles";
import { nonEmptyTrimmedStringSchema, sessionEventEnvelope } from "./schema.shared";

const agentProfilesCatalogEventSchema = z
  .object({
    type: z.literal("agent_profiles_catalog"),
    sessionId: nonEmptyTrimmedStringSchema,
    catalog: agentProfilesCatalogSchema,
  })
  .strict();

const cwdRequestSchema = z
  .object({
    cwd: z.string().optional(),
  })
  .passthrough();

export const jsonRpcAgentProfilesRequestSchemas = {
  "cowork/agentProfiles/catalog/read": cwdRequestSchema,
  "cowork/agentProfiles/upsert": cwdRequestSchema.extend({
    profile: agentProfileUpsertInputSchema,
  }),
  "cowork/agentProfiles/delete": cwdRequestSchema.extend({
    scope: agentProfileScopeSchema,
    id: nonEmptyTrimmedStringSchema,
  }),
  "cowork/agentProfiles/copy": cwdRequestSchema.extend({
    copy: agentProfileCopyInputSchema,
  }),
  "cowork/agentProfiles/workspaceAvailability/set": cwdRequestSchema.extend({
    id: nonEmptyTrimmedStringSchema,
    disabled: z.boolean(),
  }),
} as const;

export const jsonRpcAgentProfilesResultSchemas = {
  "cowork/agentProfiles/catalog/read": sessionEventEnvelope(agentProfilesCatalogEventSchema),
  "cowork/agentProfiles/upsert": sessionEventEnvelope(agentProfilesCatalogEventSchema),
  "cowork/agentProfiles/delete": sessionEventEnvelope(agentProfilesCatalogEventSchema),
  "cowork/agentProfiles/copy": sessionEventEnvelope(agentProfilesCatalogEventSchema),
  "cowork/agentProfiles/workspaceAvailability/set": sessionEventEnvelope(
    agentProfilesCatalogEventSchema,
  ),
} as const;

export const jsonRpcAgentProfilesNotificationSchemas = {
  "cowork/agentProfiles/catalog": agentProfilesCatalogEventSchema,
} as const;
