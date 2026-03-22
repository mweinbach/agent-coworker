import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SessionDb } from "../src/server/sessionDb";
import type { SessionSnapshot } from "../src/shared/sessionSnapshot";

async function makeTmpCoworkHome(prefix = "session-db-test-"): Promise<{
  rootDir: string;
  sessionsDir: string;
}> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const rootDir = path.join(home, ".cowork");
  const sessionsDir = path.join(rootDir, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  return { rootDir, sessionsDir };
}

function makeSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: "s-1",
    title: "Session One",
    titleSource: "default",
    titleModel: null,
    provider: "google",
    model: "gemini-3-flash-preview",
    sessionKind: "root",
    parentSessionId: null,
    role: null,
    mode: null,
    depth: null,
    nickname: null,
    requestedModel: null,
    effectiveModel: null,
    requestedReasoningEffort: null,
    effectiveReasoningEffort: null,
    executionState: null,
    lastMessagePreview: "hello",
    createdAt: "2026-03-19T00:00:00.000Z",
    updatedAt: "2026-03-19T00:00:01.000Z",
    messageCount: 1,
    lastEventSeq: 1,
    feed: [
      {
        id: "item-1",
        kind: "message",
        role: "user",
        ts: "2026-03-19T00:00:00.000Z",
        text: "hello",
      },
    ],
    agents: [],
    todos: [],
    sessionUsage: null,
    lastTurnUsage: null,
    hasPendingAsk: false,
    hasPendingApproval: false,
    ...overrides,
  };
}

describe("sessionDb", () => {
  test("persists/lists/deletes sessions with canonical state", async () => {
    const paths = await makeTmpCoworkHome();
    const db = await SessionDb.create({ paths });
    try {
      const now = new Date().toISOString();
      await db.persistSessionMutation({
        sessionId: "s-1",
        eventType: "session.created",
        snapshot: {
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          title: "Session One",
          titleSource: "default",
          titleModel: null,
          provider: "google",
          model: "gemini-3-flash-preview",
          workingDirectory: "/tmp/project",
          providerOptions: {
            openai: {
              reasoningEffort: "high",
              reasoningSummary: "detailed",
            },
          },
          enableMcp: true,
          createdAt: now,
          updatedAt: now,
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          systemPrompt: "system",
          messages: [{ role: "user", content: "hello" }],
          providerState: {
            provider: "openai",
            model: "gpt-5.2",
            responseId: "resp_123",
            updatedAt: now,
          },
          todos: [],
          harnessContext: null,
          costTracker: {
            sessionId: "s-1",
            totalTurns: 1,
            totalPromptTokens: 100,
            totalCompletionTokens: 40,
            totalTokens: 140,
            estimatedTotalCostUsd: 0.0025,
            costTrackingAvailable: true,
            byModel: [],
            turns: [],
            budgetStatus: {
              configured: true,
              warnAtUsd: 5,
              stopAtUsd: 10,
              warningTriggered: false,
              stopTriggered: false,
              currentCostUsd: 0.0025,
            },
            createdAt: now,
            updatedAt: now,
          },
        },
      });

      const sessions = db.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.sessionId).toBe("s-1");
      expect(sessions[0]?.messageCount).toBe(1);

      const paged = db.getMessages("s-1", 0, 10);
      expect(paged.total).toBe(1);
      expect(paged.messages).toHaveLength(1);

      const persisted = db.getSessionRecord("s-1");
      expect(persisted?.sessionId).toBe("s-1");
      expect(persisted?.lastEventSeq).toBe(1);
      expect(persisted?.providerState).toEqual({
        provider: "openai",
        model: "gpt-5.2",
        responseId: "resp_123",
        updatedAt: now,
      });
      expect(persisted?.providerOptions).toEqual({
        openai: {
          reasoningEffort: "high",
          reasoningSummary: "detailed",
        },
      });
      expect(persisted?.costTracker).toEqual({
        sessionId: "s-1",
        totalTurns: 1,
        totalPromptTokens: 100,
        totalCompletionTokens: 40,
        totalTokens: 140,
        estimatedTotalCostUsd: 0.0025,
        costTrackingAvailable: true,
        byModel: [],
        turns: [],
        budgetStatus: {
          configured: true,
          warnAtUsd: 5,
          stopAtUsd: 10,
          warningTriggered: false,
          stopTriggered: false,
          currentCostUsd: 0.0025,
        },
        createdAt: now,
        updatedAt: now,
      });

      await db.deleteSession("s-1");
      expect(db.getSessionRecord("s-1")).toBeNull();
    } finally {
      db.close();
    }
  });

  test("persists raw model stream chunks alongside session state", async () => {
    const paths = await makeTmpCoworkHome();
    const db = await SessionDb.create({ paths });
    try {
      const now = new Date().toISOString();
      await db.persistSessionMutation({
        sessionId: "s-raw",
        eventType: "session.created",
        snapshot: {
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          title: "Raw Session",
          titleSource: "default",
          titleModel: null,
          provider: "openai",
          model: "gpt-5.2",
          workingDirectory: "/tmp/project",
          enableMcp: true,
          createdAt: now,
          updatedAt: now,
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
      });

      await db.persistModelStreamChunk({
        sessionId: "s-raw",
        turnId: "turn-1",
        chunkIndex: 0,
        ts: now,
        provider: "openai",
        model: "gpt-5.2",
        rawFormat: "openai-responses-v1",
        normalizerVersion: 1,
        rawEvent: {
          type: "response.output_item.added",
          item: { type: "reasoning", id: "rs_1" },
        },
      });

      expect(db.listModelStreamChunks("s-raw")).toEqual([
        {
          sessionId: "s-raw",
          turnId: "turn-1",
          chunkIndex: 0,
          ts: now,
          provider: "openai",
          model: "gpt-5.2",
          rawFormat: "openai-responses-v1",
          normalizerVersion: 1,
          rawEvent: {
            type: "response.output_item.added",
            item: { type: "reasoning", id: "rs_1" },
          },
        },
      ]);
    } finally {
      db.close();
    }
  });

  test("persists canonical thread journal events", async () => {
    const paths = await makeTmpCoworkHome();
    const db = await SessionDb.create({ paths });
    try {
      const now = new Date().toISOString();
      await db.persistSessionMutation({
        sessionId: "thread-1",
        eventType: "session.created",
        snapshot: {
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          title: "Thread One",
          titleSource: "default",
          titleModel: null,
          provider: "openai",
          model: "gpt-5.4",
          workingDirectory: "/tmp/project",
          enableMcp: true,
          createdAt: now,
          updatedAt: now,
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          systemPrompt: "system",
          messages: [],
          providerState: null,
          todos: [],
          harnessContext: null,
          costTracker: null,
        },
      });

      const seq1 = await db.appendThreadJournalEvent({
        threadId: "thread-1",
        ts: now,
        eventType: "thread/started",
        turnId: null,
        itemId: null,
        requestId: null,
        payload: {
          thread: {
            id: "thread-1",
          },
        },
      });
      const seq2 = await db.appendThreadJournalEvent({
        threadId: "thread-1",
        ts: now,
        eventType: "turn/started",
        turnId: "turn-1",
        itemId: null,
        requestId: null,
        payload: {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            status: "inProgress",
            items: [],
          },
        },
      });

      expect(seq1).toBe(1);
      expect(seq2).toBe(2);
      expect(db.listThreadJournalEvents("thread-1")).toEqual([
        {
          threadId: "thread-1",
          seq: 1,
          ts: now,
          eventType: "thread/started",
          turnId: null,
          itemId: null,
          requestId: null,
          payload: {
            thread: {
              id: "thread-1",
            },
          },
        },
        {
          threadId: "thread-1",
          seq: 2,
          ts: now,
          eventType: "turn/started",
          turnId: "turn-1",
          itemId: null,
          requestId: null,
          payload: {
            threadId: "thread-1",
            turn: {
              id: "turn-1",
              status: "inProgress",
              items: [],
            },
          },
        },
      ]);
      expect(db.listThreadJournalEvents("thread-1", { afterSeq: 1 })).toEqual([
        {
          threadId: "thread-1",
          seq: 2,
          ts: now,
          eventType: "turn/started",
          turnId: "turn-1",
          itemId: null,
          requestId: null,
          payload: {
            threadId: "thread-1",
            turn: {
              id: "turn-1",
              status: "inProgress",
              items: [],
            },
          },
        },
      ]);
    } finally {
      db.close();
    }
  });

  test("listThreadJournalEvents returns the full journal when no limit is requested", async () => {
    const paths = await makeTmpCoworkHome();
    const db = await SessionDb.create({ paths });
    try {
      const now = new Date().toISOString();
      await db.persistSessionMutation({
        sessionId: "thread-1",
        eventType: "session.created",
        snapshot: {
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          title: "Thread One",
          titleSource: "default",
          titleModel: null,
          provider: "openai",
          model: "gpt-5.4",
          workingDirectory: "/tmp/project",
          enableMcp: true,
          createdAt: now,
          updatedAt: now,
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          systemPrompt: "system",
          messages: [],
          providerState: null,
          todos: [],
          harnessContext: null,
          costTracker: null,
        },
      });

      for (let index = 0; index < 1_005; index += 1) {
        await db.appendThreadJournalEvent({
          threadId: "thread-1",
          ts: now,
          eventType: "item/agentMessage/delta",
          turnId: "turn-1",
          itemId: `item-${index}`,
          requestId: null,
          payload: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: `item-${index}`,
            delta: `chunk-${index}`,
          },
        });
      }

      expect(db.listThreadJournalEvents("thread-1")).toHaveLength(1_005);
      expect(db.listThreadJournalEvents("thread-1", { limit: 10 })).toHaveLength(10);
      expect(db.listThreadJournalEvents("thread-1").at(-1)?.payload).toMatchObject({ delta: "chunk-1004" });
    } finally {
      db.close();
    }
  });

  test("filters listed sessions by working directory and persists materialized snapshots", async () => {
    const paths = await makeTmpCoworkHome();
    const db = await SessionDb.create({ paths });
    try {
      const now = new Date().toISOString();
      await db.persistSessionMutation({
        sessionId: "workspace-a",
        eventType: "session.created",
        snapshot: {
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          title: "Workspace A",
          titleSource: "default",
          titleModel: null,
          provider: "google",
          model: "gemini-3-flash-preview",
          workingDirectory: "/tmp/workspace-a",
          enableMcp: true,
          createdAt: now,
          updatedAt: now,
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          systemPrompt: "system",
          messages: [{ role: "user", content: "hello a" }],
          providerState: null,
          todos: [],
          harnessContext: null,
          costTracker: null,
        },
      });
      await db.persistSessionMutation({
        sessionId: "workspace-b",
        eventType: "session.created",
        snapshot: {
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          title: "Workspace B",
          titleSource: "manual",
          titleModel: null,
          provider: "openai",
          model: "gpt-5.4",
          workingDirectory: "/tmp/workspace-b",
          enableMcp: true,
          createdAt: now,
          updatedAt: now,
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          systemPrompt: "system",
          messages: [{ role: "user", content: "hello b" }],
          providerState: null,
          todos: [],
          harnessContext: null,
          costTracker: null,
        },
      });

      const persistedSnapshot = makeSnapshot({
        sessionId: "workspace-a",
        title: "Workspace A",
        updatedAt: now,
      });
      await db.persistSessionSnapshot("workspace-a", persistedSnapshot);

      expect(db.listSessions({ workingDirectory: "/tmp/workspace-a" }).map((session) => session.sessionId)).toEqual([
        "workspace-a",
      ]);
      expect(db.listSessions({ workingDirectory: "/tmp/workspace-b" }).map((session) => session.sessionId)).toEqual([
        "workspace-b",
      ]);
      expect(db.getSessionSnapshot("workspace-a")).toEqual(persistedSnapshot);
      expect(db.getSessionSnapshot("workspace-b")).toBeNull();
    } finally {
      db.close();
    }
  });

  test("listSessions matches working directory across lexical normalization", async () => {
    const paths = await makeTmpCoworkHome();
    const db = await SessionDb.create({ paths });
    try {
      const realDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-db-wdnorm-"));
      const canonical = path.resolve(realDir);
      const now = new Date().toISOString();
      await db.persistSessionMutation({
        sessionId: "wd-norm",
        eventType: "session.created",
        snapshot: {
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          title: "Norm",
          titleSource: "default",
          titleModel: null,
          provider: "google",
          model: "gemini-3-flash-preview",
          workingDirectory: canonical,
          enableMcp: true,
          createdAt: now,
          updatedAt: now,
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
      });
      expect(db.listSessions({ workingDirectory: path.join(canonical, ".") }).map((s) => s.sessionId)).toEqual(["wd-norm"]);
      expect(db.listSessions({ workingDirectory: `${canonical}${path.sep}` }).map((s) => s.sessionId)).toEqual(["wd-norm"]);
    } finally {
      db.close();
    }
  });

  test("imports legacy JSON snapshots before marking legacy migration as applied", async () => {
    const paths = await makeTmpCoworkHome();
    const now = new Date().toISOString();

    await fs.writeFile(
      path.join(paths.sessionsDir, "legacy-1.json"),
      JSON.stringify({
        version: 1,
        sessionId: "legacy-1",
        createdAt: now,
        updatedAt: now,
        session: {
          title: "Legacy Session",
          titleSource: "default",
          titleModel: null,
          provider: "google",
          model: "gemini-3-flash-preview",
        },
        config: {
          provider: "google",
          model: "gemini-3-flash-preview",
          enableMcp: false,
          workingDirectory: "/tmp/legacy",
        },
        context: {
          system: "legacy",
          messages: [{ role: "user", content: "hello from legacy" }],
          todos: [],
          harnessContext: null,
        },
      }),
      "utf-8",
    );

    const db = await SessionDb.create({ paths });
    try {
      const sessions = db.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.sessionId).toBe("legacy-1");
      expect(sessions[0]?.messageCount).toBe(1);

      const persisted = db.getSessionRecord("legacy-1");
      expect(persisted?.title).toBe("Legacy Session");
      expect(persisted?.messages).toHaveLength(1);
      expect(persisted?.providerState).toBeNull();
    } finally {
      db.close();
    }
  });

  test("imports providerOptions from version 7 legacy snapshots", async () => {
    const paths = await makeTmpCoworkHome();
    const now = new Date().toISOString();

    await fs.writeFile(
      path.join(paths.sessionsDir, "legacy-7.json"),
      JSON.stringify({
        version: 7,
        sessionId: "legacy-7",
        createdAt: now,
        updatedAt: now,
        session: {
          title: "Legacy Agent",
          titleSource: "manual",
          titleModel: null,
          provider: "openai",
          model: "gpt-5.2",
          sessionKind: "agent",
          parentSessionId: "root-1",
          role: "worker",
          mode: "collaborative",
          depth: 1,
          nickname: null,
          requestedModel: null,
          effectiveModel: "gpt-5.2",
          requestedReasoningEffort: null,
          effectiveReasoningEffort: null,
          executionState: "completed",
          lastMessagePreview: "done",
        },
        config: {
          provider: "openai",
          model: "gpt-5.2",
          enableMcp: true,
          backupsEnabledOverride: null,
          workingDirectory: "/tmp/legacy-7",
          providerOptions: {
            openai: {
              reasoningEffort: "xhigh",
              textVerbosity: "low",
            },
          },
        },
        context: {
          system: "legacy",
          messages: [{ role: "assistant", content: "done" }],
          providerState: null,
          todos: [],
          harnessContext: null,
          costTracker: null,
        },
      }),
      "utf-8",
    );

    const db = await SessionDb.create({ paths });
    try {
      const persisted = db.getSessionRecord("legacy-7");
      expect(persisted?.providerOptions).toEqual({
        openai: {
          reasoningEffort: "xhigh",
          textVerbosity: "low",
        },
      });
      expect(db.listAgentSessions("root-1")[0]?.executionState).toBe("completed");
    } finally {
      db.close();
    }
  });

  test("lists child-agent sessions separately and cascades deletion from the parent", async () => {
    const paths = await makeTmpCoworkHome();
    const db = await SessionDb.create({ paths });
    try {
      const now = new Date().toISOString();
      await db.persistSessionMutation({
        sessionId: "root-1",
        eventType: "session.created",
        snapshot: {
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          title: "Root Session",
          titleSource: "default",
          titleModel: null,
          provider: "openai",
          model: "gpt-5.2",
          workingDirectory: "/tmp/project",
          enableMcp: false,
          createdAt: now,
          updatedAt: now,
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          systemPrompt: "root-system",
          messages: [{ role: "user", content: "root hello" }],
          providerState: null,
          todos: [],
          harnessContext: null,
          costTracker: null,
        },
      });
      await db.persistSessionMutation({
        sessionId: "child-1",
        eventType: "session.created",
        snapshot: {
          sessionKind: "agent",
          parentSessionId: "root-1",
          role: "worker",
          title: "Child Session",
          titleSource: "default",
          titleModel: null,
          provider: "openai",
          model: "gpt-5.2-mini",
          workingDirectory: "/tmp/project",
          enableMcp: false,
          createdAt: now,
          updatedAt: now,
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          systemPrompt: "child-system",
          messages: [{ role: "assistant", content: "child hello" }],
          providerState: null,
          todos: [],
          harnessContext: null,
          costTracker: null,
        },
      });

      expect(db.listSessions().map((session) => session.sessionId)).toEqual(["root-1"]);
      const agents = db.listAgentSessions("root-1");
      expect(agents).toHaveLength(1);
      expect(agents[0]).toMatchObject({
        agentId: "child-1",
        parentSessionId: "root-1",
        role: "worker",
        mode: "collaborative",
        depth: 1,
        lifecycleState: "active",
      });

      await db.deleteSession("root-1");
      expect(db.getSessionRecord("root-1")).toBeNull();
      expect(db.getSessionRecord("child-1")).toBeNull();
      expect(db.listAgentSessions("root-1")).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("skips malformed legacy snapshots and still imports valid ones", async () => {
    const paths = await makeTmpCoworkHome();
    const now = new Date().toISOString();
    await fs.writeFile(
      path.join(paths.sessionsDir, "legacy-valid.json"),
      JSON.stringify({
        version: 1,
        sessionId: "legacy-valid",
        createdAt: now,
        updatedAt: now,
        session: {
          title: "Legacy Valid",
          titleSource: "default",
          titleModel: null,
          provider: "google",
          model: "gemini-3-flash-preview",
        },
        config: {
          provider: "google",
          model: "gemini-3-flash-preview",
          enableMcp: false,
          workingDirectory: "/tmp/legacy-valid",
        },
        context: {
          system: "legacy-valid",
          messages: [{ role: "user", content: "hello from valid legacy snapshot" }],
          todos: [],
          harnessContext: null,
        },
      }),
      "utf-8",
    );
    await fs.writeFile(path.join(paths.sessionsDir, "legacy-bad-json.json"), "not valid json {{{", "utf-8");
    await fs.writeFile(
      path.join(paths.sessionsDir, "legacy-bad-structure.json"),
      JSON.stringify({ version: 1, sessionId: "missing-fields" }),
      "utf-8",
    );

    const db = await SessionDb.create({ paths });
    try {
      const sessions = db.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.sessionId).toBe("legacy-valid");

      const persisted = db.getSessionRecord("legacy-valid");
      expect(persisted?.title).toBe("Legacy Valid");
      expect(persisted?.messages).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("skips unreadable legacy snapshot entries while importing valid ones", async () => {
    const paths = await makeTmpCoworkHome();
    const now = new Date().toISOString();
    await fs.writeFile(
      path.join(paths.sessionsDir, "legacy-valid.json"),
      JSON.stringify({
        version: 1,
        sessionId: "legacy-valid",
        createdAt: now,
        updatedAt: now,
        session: {
          title: "Legacy Valid",
          titleSource: "default",
          titleModel: null,
          provider: "google",
          model: "gemini-3-flash-preview",
        },
        config: {
          provider: "google",
          model: "gemini-3-flash-preview",
          enableMcp: false,
          workingDirectory: "/tmp/legacy-valid",
        },
        context: {
          system: "legacy-valid",
          messages: [{ role: "user", content: "hello from valid legacy snapshot" }],
          todos: [],
          harnessContext: null,
        },
      }),
      "utf-8",
    );

    const unreadableDir = path.join(paths.sessionsDir, "legacy-unreadable.json");
    await fs.mkdir(unreadableDir);

    const db = await SessionDb.create({ paths });
    try {
      const sessions = db.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.sessionId).toBe("legacy-valid");

      const persisted = db.getSessionRecord("legacy-valid");
      expect(persisted?.title).toBe("Legacy Valid");
      expect(persisted?.messages).toHaveLength(1);
    } finally {
      db.close();
      await fs.rm(unreadableDir, { recursive: true, force: true });
    }
  });

  test("returns empty messages when messages_json is malformed", async () => {
    const paths = await makeTmpCoworkHome();
    const db = await SessionDb.create({ paths });
    try {
      const now = new Date().toISOString();
      await db.persistSessionMutation({
        sessionId: "s-bad-messages",
        eventType: "session.created",
        snapshot: {
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          title: "Session with bad messages",
          titleSource: "default",
          titleModel: null,
          provider: "google",
          model: "gemini-3-flash-preview",
          workingDirectory: "/tmp/project",
          enableMcp: false,
          createdAt: now,
          updatedAt: now,
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
      });

      (db as any).db
        .query("UPDATE session_state SET messages_json = ? WHERE session_id = ?")
        .run("not-json", "s-bad-messages");

      const paged = db.getMessages("s-bad-messages", 0, 10);
      expect(paged.total).toBe(0);
      expect(paged.messages).toEqual([]);
    } finally {
      db.close();
    }
  });
});
