import { z } from "zod";
import { nonEmptyTrimmedStringSchema } from "./schema.shared";
import { jsonRpcThreadSchema } from "./schema.threadTurn";

export const jsonRpcWorkspaceRequestSchemas = {
  "cowork/workspace/bootstrap": z
    .object({
      cwd: nonEmptyTrimmedStringSchema.optional(),
    })
    .strict(),
} as const;

export const jsonRpcWorkspaceResultSchemas = {
  "cowork/workspace/bootstrap": z
    .object({
      threads: z.array(jsonRpcThreadSchema),
      state: z.array(z.unknown()),
    })
    .strict(),
} as const;
