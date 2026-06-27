import { z } from "zod";

import { nonEmptyTrimmedStringSchema } from "./schema.shared";
import { jsonRpcThreadTurnResultSchemas } from "./schema.threadTurn";

const commandInfoSchema = z
  .object({
    name: nonEmptyTrimmedStringSchema,
    description: z.string().optional(),
    source: z.enum(["command", "mcp", "skill"]),
    hints: z.array(z.string()),
  })
  .strict();

export const jsonRpcCommandRequestSchemas = {
  "command/list": z.object({ threadId: nonEmptyTrimmedStringSchema }).strict(),
  "command/execute": z
    .object({
      threadId: nonEmptyTrimmedStringSchema,
      name: nonEmptyTrimmedStringSchema,
      arguments: z.string().optional(),
      clientMessageId: nonEmptyTrimmedStringSchema.optional(),
    })
    .strict(),
} as const;

export const jsonRpcCommandResultSchemas = {
  "command/list": z.object({ commands: z.array(commandInfoSchema) }).strict(),
  "command/execute": jsonRpcThreadTurnResultSchemas["turn/start"],
} as const;
