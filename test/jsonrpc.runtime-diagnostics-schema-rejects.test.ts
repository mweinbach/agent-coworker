import { describe, expect, test } from "bun:test";
import { jsonRpcRuntimeResultSchemas } from "../src/server/jsonrpc/schema.runtime";

const schema = jsonRpcRuntimeResultSchemas["cowork/runtime/diagnostics/read"];

const validDiagnostics = () => ({
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
});

describe("runtime diagnostics result schema", () => {
  test("accepts a complete snapshot and rejects extras, negatives, and invalid progress", () => {
    const base = validDiagnostics();
    expect(schema.parse(base)).toEqual(base);

    const d = base.diagnostics;
    for (const invalid of [
      { ...base, extra: true },
      { diagnostics: { ...d, extra: true } },
      { diagnostics: { ...d, sendQueue: { ...d.sendQueue, queuedSends: -1 } } },
      { diagnostics: { ...d, journal: { ...d.journal, failedWriteCount: 1.5 } } },
      {
        diagnostics: {
          ...d,
          startup: { ready: false, progress: { ...d.startup.progress, phase: "warming" } },
        },
      },
      {
        diagnostics: {
          ...d,
          startup: { ready: false, progress: { ...d.startup.progress, percent: 101 } },
        },
      },
    ]) {
      expect(schema.safeParse(invalid).success).toBe(false);
    }
  });
});
