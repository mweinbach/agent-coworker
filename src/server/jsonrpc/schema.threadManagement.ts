import { z } from "zod";
import { nonEmptyTrimmedStringSchema } from "./schema.shared";
import { jsonRpcThreadSchema } from "./schema.threadTurn";

export const jsonRpcThreadManagementRequestSchemas = {
  "thread/pinned/set": z
    .object({
      threadId: nonEmptyTrimmedStringSchema,
      pinned: z.boolean(),
    })
    .strict(),
  "thread/archived/set": z
    .object({
      threadId: nonEmptyTrimmedStringSchema,
      archived: z.boolean(),
    })
    .strict(),
} as const;

export const jsonRpcThreadManagementResultSchemas = {
  "thread/pinned/set": z
    .object({
      thread: jsonRpcThreadSchema,
    })
    .strict(),
  "thread/archived/set": z
    .object({
      thread: jsonRpcThreadSchema,
    })
    .strict(),
} as const;
