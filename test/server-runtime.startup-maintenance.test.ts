import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runStartupMaintenance } from "../src/server/runtime/startupMaintenance";
import { ServerFileLog, shouldEnableServerFileLog } from "../src/server/serverFileLog";
import { type PersistedSessionMutation, SessionDb } from "../src/server/sessionDb";
import { sweepStaleSessionTmpFiles } from "../src/server/sessionStore";
import type { AgentExecutionState } from "../src/shared/agents";

async function makeTmpCoworkHome(prefix = "startup-maintenance-test-"): Promise<{
  home: string;
  rootDir: string;
  sessionsDir: string;
}> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const rootDir = path.join(home, ".cowork");
  const sessionsDir = path.join(rootDir, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  return { home, rootDir, sessionsDir };
}

function makeMutation(opts: {
  sessionId: string;
  executionState?: AgentExecutionState | null;
  updatedAt?: string;
}): PersistedSessionMutation {
  const now = new Date().toISOString();
  const updatedAt = opts.updatedAt ?? now;
  return {
    sessionId: opts.sessionId,
    eventType: "session.created",
    eventTs: updatedAt,
    snapshot: {
      sessionKind: "root",
      parentSessionId: null,
      role: null,
      executionState: opts.executionState ?? null,
      title: `Session ${opts.sessionId}`,
      titleSource: "default",
      titleModel: null,
      provider: "google",
      model: "gemini-3-flash-preview",
      workingDirectory: "/tmp/project",
      enableMcp: false,
      backupsEnabledOverride: null,
      createdAt: updatedAt,
      updatedAt,
      status: "active",
      hasPendingAsk: false,
      hasPendingApproval: false,
      systemPrompt: "system",
      messages: [{ role: "user", content: "hello" }],
      providerState: null,
      todos: [],
      harnessContext: null,
      costTracker: null,
    },
  };
}

describe("startup maintenance", () => {
  test("reconcileStaleExecutionStates flips running and pending_init to errored", async () => {
    const paths = await makeTmpCoworkHome();
    const db = await SessionDb.create({ paths });
    try {
      await db.persistSessionMutation(
        makeMutation({ sessionId: "s-running", executionState: "running" }),
      );
      await db.persistSessionMutation(
        makeMutation({ sessionId: "s-pending", executionState: "pending_init" }),
      );
      await db.persistSessionMutation(
        makeMutation({ sessionId: "s-done", executionState: "completed" }),
      );

      const reconciled = await db.reconcileStaleExecutionStates();
      expect(reconciled).toBe(2);

      expect(db.getSessionRecord("s-running")?.executionState).toBe("errored");
      expect(db.getSessionRecord("s-pending")?.executionState).toBe("errored");
      expect(db.getSessionRecord("s-done")?.executionState).toBe("completed");

      expect(await db.reconcileStaleExecutionStates()).toBe(0);
    } finally {
      db.close();
    }
  });

  test("pruneModelStreamChunksForStaleSessions deletes only chunks of stale sessions", async () => {
    const paths = await makeTmpCoworkHome();
    const db = await SessionDb.create({ paths });
    try {
      const staleUpdatedAt = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
      await db.persistSessionMutation(
        makeMutation({ sessionId: "s-stale", updatedAt: staleUpdatedAt }),
      );
      await db.persistSessionMutation(makeMutation({ sessionId: "s-fresh" }));

      for (const sessionId of ["s-stale", "s-fresh"]) {
        await db.persistModelStreamChunk({
          sessionId,
          turnId: "turn-1",
          chunkIndex: 0,
          ts: new Date().toISOString(),
          provider: "google",
          model: "gemini-3-flash-preview",
          rawFormat: "google-interactions-v1",
          normalizerVersion: 1,
          rawEvent: { kind: "test" },
        });
      }

      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const deleted = await db.pruneModelStreamChunksForStaleSessions(cutoff);
      expect(deleted).toBe(1);

      expect(db.listModelStreamChunks("s-stale")).toHaveLength(0);
      expect(db.listModelStreamChunks("s-fresh")).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("sweepStaleSessionTmpFiles removes only old atomic-write leftovers", async () => {
    const { sessionsDir } = await makeTmpCoworkHome();
    const oldTime = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

    const staleTmp = path.join(sessionsDir, `persisted-session.json.${crypto.randomUUID()}.tmp`);
    await fs.writeFile(staleTmp, "{}", "utf-8");
    await fs.utimes(staleTmp, oldTime, oldTime);

    const freshTmp = path.join(sessionsDir, `persisted-session.json.${crypto.randomUUID()}.tmp`);
    await fs.writeFile(freshTmp, "{}", "utf-8");

    const realSnapshot = path.join(sessionsDir, "persisted-session.json");
    await fs.writeFile(realSnapshot, "{}", "utf-8");
    await fs.utimes(realSnapshot, oldTime, oldTime);

    const removed = await sweepStaleSessionTmpFiles({ sessionsDir });
    expect(removed).toBe(1);

    await expect(fs.stat(staleTmp)).rejects.toThrow();
    expect((await fs.stat(freshTmp)).isFile()).toBe(true);
    expect((await fs.stat(realSnapshot)).isFile()).toBe(true);
  });

  test("runStartupMaintenance reports what it cleaned and never throws", async () => {
    const { home, sessionsDir } = await makeTmpCoworkHome();
    const paths = { rootDir: path.join(home, ".cowork"), sessionsDir };
    const db = await SessionDb.create({ paths });
    try {
      const staleUpdatedAt = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
      await db.persistSessionMutation(
        makeMutation({ sessionId: "s-stale", updatedAt: staleUpdatedAt }),
      );
      await db.persistModelStreamChunk({
        sessionId: "s-stale",
        turnId: "turn-1",
        chunkIndex: 0,
        ts: new Date().toISOString(),
        provider: "google",
        model: "gemini-3-flash-preview",
        rawFormat: "google-interactions-v1",
        normalizerVersion: 1,
        rawEvent: { kind: "test" },
      });

      const staleTmp = path.join(sessionsDir, `persisted-session.json.${crypto.randomUUID()}.tmp`);
      await fs.writeFile(staleTmp, "{}", "utf-8");
      const oldTime = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      await fs.utimes(staleTmp, oldTime, oldTime);

      const result = await runStartupMaintenance({
        sessionDb: db,
        sessionsDir,
        homedir: home,
      });

      expect(result.prunedModelStreamChunks).toBe(1);
      expect(result.sweptSessionTmpFiles).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe("server file log", () => {
  test("is enabled by default and disabled via COWORK_SERVER_FILE_LOGS=0", () => {
    expect(shouldEnableServerFileLog({})).toBe(true);
    expect(shouldEnableServerFileLog({ COWORK_SERVER_FILE_LOGS: "1" })).toBe(true);
    expect(shouldEnableServerFileLog({ COWORK_SERVER_FILE_LOGS: "0" })).toBe(false);
    expect(shouldEnableServerFileLog({ COWORK_SERVER_FILE_LOGS: "false" })).toBe(false);
  });

  test("appends session log and error events as JSONL", async () => {
    const { rootDir } = await makeTmpCoworkHome();
    const logsDir = path.join(rootDir, "logs");
    const fileLog = new ServerFileLog({ logsDir });

    fileLog.appendSessionEvent({ type: "log", sessionId: "s-1", line: "tool> read {}" });
    fileLog.appendSessionEvent({
      type: "error",
      sessionId: "s-1",
      message: "Request timed out.",
      code: "provider_error",
      source: "provider",
    });
    fileLog.appendSessionEvent({ type: "pong", sessionId: "s-1" });
    await fileLog.flush();

    const fileName = `server-${new Date().toISOString().slice(0, 10)}.log`;
    const contents = await fs.readFile(path.join(logsDir, fileName), "utf-8");
    const entries = contents
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ sessionId: "s-1", kind: "log", line: "tool> read {}" });
    expect(entries[1]).toMatchObject({
      sessionId: "s-1",
      kind: "error",
      message: "Request timed out.",
      code: "provider_error",
      source: "provider",
    });
    expect(typeof entries[0]?.ts).toBe("string");
  });

  test("sweeps log files older than the retention window", async () => {
    const { rootDir } = await makeTmpCoworkHome();
    const logsDir = path.join(rootDir, "logs");
    await fs.mkdir(logsDir, { recursive: true });

    const expired = path.join(logsDir, "server-2020-01-01.log");
    await fs.writeFile(expired, "{}\n", "utf-8");
    const unrelated = path.join(logsDir, "other.log");
    await fs.writeFile(unrelated, "keep\n", "utf-8");

    const fileLog = new ServerFileLog({ logsDir, retentionDays: 14 });
    fileLog.appendSessionEvent({ type: "log", sessionId: "s-1", line: "hello" });
    await fileLog.flush();
    // The retention sweep is fired on first append; give it a beat to settle.
    await new Promise((resolve) => setTimeout(resolve, 50));

    await expect(fs.stat(expired)).rejects.toThrow();
    expect((await fs.stat(unrelated)).isFile()).toBe(true);
  });
});
