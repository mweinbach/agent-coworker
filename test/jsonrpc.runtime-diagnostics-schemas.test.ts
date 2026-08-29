import { describe, expect, test } from "bun:test";

import {
  jsonRpcRuntimeRequestSchemas,
  jsonRpcRuntimeResultSchemas,
} from "../src/server/jsonrpc/schema.runtime";

function diagnostics() {
  return {
    diagnostics: {
      startup: { ready: true },
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

describe("runtime diagnostics JSON-RPC schemas", () => {
  test("diagnostics/read request is a strict empty object", () => {
    expect(jsonRpcRuntimeRequestSchemas["cowork/runtime/diagnostics/read"].parse({})).toEqual({});
    expect(
      jsonRpcRuntimeRequestSchemas["cowork/runtime/diagnostics/read"].safeParse({ extra: true })
        .success,
    ).toBe(false);
  });

  test("diagnostics result rejects negative counters and extra keys", () => {
    expect(
      jsonRpcRuntimeResultSchemas["cowork/runtime/diagnostics/read"].parse(diagnostics()),
    ).toEqual(diagnostics());

    expect(
      jsonRpcRuntimeResultSchemas["cowork/runtime/diagnostics/read"].safeParse({
        diagnostics: {
          ...diagnostics().diagnostics,
          sendQueue: {
            ...diagnostics().diagnostics.sendQueue,
            queuedSends: -1,
          },
        },
      }).success,
    ).toBe(false);
    expect(
      jsonRpcRuntimeResultSchemas["cowork/runtime/diagnostics/read"].safeParse({
        diagnostics: {
          ...diagnostics().diagnostics,
          extra: true,
        },
      }).success,
    ).toBe(false);
    expect(
      jsonRpcRuntimeResultSchemas["cowork/runtime/diagnostics/read"].safeParse({
        diagnostics: {
          ...diagnostics().diagnostics,
          startup: { ready: true, extra: true },
        },
      }).success,
    ).toBe(false);
    expect(
      jsonRpcRuntimeResultSchemas["cowork/runtime/diagnostics/read"].safeParse({
        diagnostics: {
          ...diagnostics().diagnostics,
          sendQueue: {
            ...diagnostics().diagnostics.sendQueue,
            queueDepthByConnection: { ws: -2 },
          },
        },
      }).success,
    ).toBe(false);
  });
});
