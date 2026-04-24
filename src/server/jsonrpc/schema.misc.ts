import { z } from "zod";

import {
  mcpServersEventSchema,
  pluginsCatalogEventSchema,
  skillsCatalogEventSchema,
  skillsListEventSchema,
} from "../../shared/jsonrpcControlSchemas";

export const todosEventSchema = z
  .object({
    type: z.literal("todos"),
    todos: z.array(z.unknown()),
  })
  .passthrough();

export const logEventSchema = z
  .object({
    type: z.literal("log"),
    line: z.string(),
  })
  .passthrough();

export const errorEventSchema = z
  .object({
    type: z.literal("error"),
    message: z.string(),
    code: z.string(),
    source: z.string(),
  })
  .passthrough();

export const controlEventNotificationSchema = z.union([
  skillsListEventSchema,
  skillsCatalogEventSchema,
  pluginsCatalogEventSchema,
  mcpServersEventSchema,
]);

export const jsonRpcMiscNotificationSchemas = {
  "cowork/log": logEventSchema,
  "cowork/todos": todosEventSchema,
  "cowork/control/event": controlEventNotificationSchema,
  error: errorEventSchema,
} as const;
