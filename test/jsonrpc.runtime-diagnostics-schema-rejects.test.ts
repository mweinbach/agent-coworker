import { describe, expect, test } from "bun:test";

import { jsonRpcRuntimeResultSchemas } from "../src/server/jsonrpc/schema.runtime";

const schema = jsonRpcRuntimeResultSchemas["cowork/runtime/diagnostics/read"];

function validDiagnostics() {
  return {
    diagnostics: {
      startup: {
        ready: false,
        progress: {
          phase: "downloading",
          version: "1.0.0",
          transferredBytes: 10,
          totalBytes: 100,
          percent: 10,
        },
      },
      sendQueue: {
        queuedSends: 0,
        droppedDeltas: 0,
        droppedImportant: 0,
        serializationFailures: 0,
        sendFailures: 0,
        externalSinkFailures: 0,
        maxQueueDepth: 0,
        queueDepthByConnection: {},
      },
      journal: {
        untrustedThreadCount: 0,
        failedWriteCount: 0,
        droppedEventCount: 0,
        pendingThreadCount: 0,
      },
      dbLocks: {
        waitCount: 0,
        timeoutCount: 0,
        sqliteLockErrorCount: 0,
        staleRecoveryCount: 0,
        lastWaitMs: 0,
        maxWaitMs: 0,
      },
    },
  };
}

describe("runtime diagnostics result schema", () => {
  test("accepts a complete snapshot and rejects extras, negatives, and invalid progress", () => {
    expect(schema.parse(validDiagnostics())).toEqual(validDiagnostics());

    expect(schema.safeParse({ ...validDiagnostics(), extra: true }).success).toBe(false);
    expect(
      schema.safeParse({
        diagnostics: {
          ...validDiagnostics().diagnostics,
          extra: true,
        },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        diagnostics: {
          ...validDiagnostics().diagnostics,
          sendQueue: {
            ...validDiagnostics().diagnostics.sendQueue,
            queuedSends: -1,
          },
        },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        diagnostics: {
          ...validDiagnostics().diagnostics,
          journal: {
            ...validDiagnostics().diagnostics.journal,
            failedWriteCount: 1.5,
          },
        },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        diagnostics: {
          ...validDiagnostics().diagnostics,
          startup: {
            ready: false,
            progress: {
              phase: "warming",
              version: "1.0.0",
              transferredBytes: 10,
              totalBytes: 100,
              percent: 10,
            },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        diagnostics: {
          ...validDiagnostics().diagnostics,
          startup: {
            ready: false,
            progress: {
              phase: "downloading",
              version: "1.0.0",
              transferredBytes: 10,
              totalBytes: 100,
              percent: 101,
            },
          },
        },
      }).success,
    ).toBe(false);
  });
});
