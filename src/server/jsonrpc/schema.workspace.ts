import { z } from "zod";

import { jsonRpcThreadSchema } from "./schema.threadTurn";
import { nonEmptyTrimmedStringSchema } from "./schema.shared";

export const jsonRpcWorkspaceRequestSchemas = {
  "cowork/workspace/bootstrap": z.object({
    cwd: nonEmptyTrimmedStringSchema.optional(),
  }).strict(),
} as const;

export const jsonRpcWorkspaceResultSchemas = {
  "cowork/workspace/bootstrap": z.object({
    threads: z.array(jsonRpcThreadSchema),
    state: z.array(z.unknown()),
  }).strict(),
} as const;
