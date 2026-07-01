import { z } from "zod";

import {
  jsonRpcControlRequestSchemas,
  jsonRpcControlResultSchemas,
} from "../../shared/jsonrpcControlSchemas";

const runtimeDiagnosticsResultSchema = z
  .object({
    diagnostics: z
      .object({
        sendQueue: z
          .object({
            queuedSends: z.number().int().nonnegative(),
            droppedDeltas: z.number().int().nonnegative(),
            droppedImportant: z.number().int().nonnegative(),
            serializationFailures: z.number().int().nonnegative(),
            sendFailures: z.number().int().nonnegative(),
            externalSinkFailures: z.number().int().nonnegative(),
            maxQueueDepth: z.number().int().nonnegative(),
            queueDepthByConnection: z.record(z.string(), z.number().int().nonnegative()),
          })
          .strict(),
        journal: z
          .object({
            untrustedThreadCount: z.number().int().nonnegative(),
            failedWriteCount: z.number().int().nonnegative(),
            droppedEventCount: z.number().int().nonnegative(),
            pendingThreadCount: z.number().int().nonnegative(),
          })
          .strict(),
        dbLocks: z
          .object({
            waitCount: z.number().int().nonnegative(),
            timeoutCount: z.number().int().nonnegative(),
            sqliteLockErrorCount: z.number().int().nonnegative(),
            staleRecoveryCount: z.number().int().nonnegative(),
            lastWaitMs: z.number().int().nonnegative(),
            maxWaitMs: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export const jsonRpcRuntimeRequestSchemas = {
  "cowork/runtime/libreoffice/check":
    jsonRpcControlRequestSchemas["cowork/runtime/libreoffice/check"],
  "cowork/runtime/diagnostics/read": z.object({}).strict(),
} as const;

export const jsonRpcRuntimeResultSchemas = {
  "cowork/runtime/libreoffice/check":
    jsonRpcControlResultSchemas["cowork/runtime/libreoffice/check"],
  "cowork/runtime/diagnostics/read": runtimeDiagnosticsResultSchema,
} as const;
