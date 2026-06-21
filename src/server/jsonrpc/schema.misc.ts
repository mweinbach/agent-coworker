import { z } from "zod";

import {
  mcpServersEventSchema,
  pluginsCatalogEventSchema,
  skillsCatalogEventSchema,
  skillsListEventSchema,
} from "../../shared/jsonrpcControlSchemas";

const todosEventSchema = z
  .object({
    type: z.literal("todos"),
    todos: z.array(z.unknown()),
  })
  .passthrough();

const logEventSchema = z
  .object({
    type: z.literal("log"),
    line: z.string(),
  })
  .passthrough();

const errorEventSchema = z
  .object({
    type: z.literal("error"),
    message: z.string(),
    code: z.string(),
    source: z.string(),
    data: z.unknown().optional(),
  })
  .passthrough();

const controlEventNotificationSchema = z.union([
  skillsListEventSchema,
  skillsCatalogEventSchema,
  pluginsCatalogEventSchema,
  mcpServersEventSchema,
]);

const workspaceListChangedNotificationSchema = z
  .object({
    revision: z.number().int().nonnegative(),
  })
  .strict();

export const jsonRpcMiscNotificationSchemas = {
  "cowork/log": logEventSchema,
  "cowork/todos": todosEventSchema,
  "cowork/control/event": controlEventNotificationSchema,
  "workspace/listChanged": workspaceListChangedNotificationSchema,
  error: errorEventSchema,
} as const;
