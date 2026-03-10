import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getPersistedSessionFilePath,
  listPersistedSessionSnapshots,
  parsePersistedSessionSnapshot,
  readPersistedSessionSnapshot,
  writePersistedSessionSnapshot,
  type PersistedSessionSnapshot,
} from "../src/server/sessionStore";

function makeSnapshot(sessionId: string): PersistedSessionSnapshot {
  return {
    version: 4,
    sessionId,
    createdAt: "2026-02-19T00:00:00.000Z",
    updatedAt: "2026-02-19T00:00:01.000Z",
    session: {
      title: "Persisted session title",
      titleSource: "model",
      titleModel: "gpt-5-mini",
      provider: "openai",
      model: "gpt-5.2",
      sessionKind: "root",
      parentSessionId: null,
      agentType: null,
    },
    config: {
      provider: "openai",
      model: "gpt-5.2",
      enableMcp: true,
      workingDirectory: "/tmp/workspace",
      outputDirectory: "/tmp/workspace/output",
      uploadsDirectory: "/tmp/workspace/uploads",
    },
    context: {
      system: "System prompt",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "world" },
      ] as any,
      providerState: {
        provider: "openai",
        model: "gpt-5.2",
        responseId: "resp_123",
        updatedAt: "2026-02-19T00:00:01.000Z",
      },
      todos: [{ content: "Do thing", status: "pending", activeForm: "Doing thing" }],
      harnessContext: {
        runId: "run-1",
        objective: "Test",
        acceptanceCriteria: ["A"],
        constraints: ["C"],
        updatedAt: "2026-02-19T00:00:00.000Z",
      },
      costTracker: {
        sessionId,
        totalTurns: 1,
        totalPromptTokens: 100,
        totalCompletionTokens: 25,
        totalTokens: 125,
        estimatedTotalCostUsd: 0.0015,
        costTrackingAvailable: true,
        byModel: [],
        turns: [],
        budgetStatus: {
          configured: false,
          warnAtUsd: null,
          stopAtUsd: null,
          warningTriggered: false,
          stopTriggered: false,
          currentCostUsd: 0.0015,
        },
        createdAt: "2026-02-19T00:00:00.000Z",
        updatedAt: "2026-02-19T00:00:01.000Z",
      },
    },
  };
}

describe("sessionStore", () => {
  test("writes and reads a persisted session snapshot", async () => {
    const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-store-test-"));
    const sessionId = "sess-123";
    const snapshot = makeSnapshot(sessionId);

    const writtenPath = await writePersistedSessionSnapshot({
      paths: { sessionsDir },
      snapshot,
    });

    expect(writtenPath).toBe(getPersistedSessionFilePath({ sessionsDir }, sessionId));

    const loaded = await readPersistedSessionSnapshot({
      paths: { sessionsDir },
      sessionId,
    });

    expect(loaded).toEqual(snapshot);
  });

  test("readPersistedSessionSnapshot throws for malformed files", async () => {
    const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-store-test-"));
    const sessionId = "sess-bad";
    const filePath = getPersistedSessionFilePath({ sessionsDir }, sessionId);

    await fs.writeFile(filePath, "not valid json {{{", "utf-8");

    await expect(
      readPersistedSessionSnapshot({ paths: { sessionsDir }, sessionId }),
    ).rejects.toThrow("Invalid JSON in persisted session snapshot");
  });

  test("parsePersistedSessionSnapshot rejects invalid shape", () => {
    expect(() =>
      parsePersistedSessionSnapshot({
        version: 2,
        sessionId: "sess-1",
        createdAt: "2026-02-19T00:00:00.000Z",
        updatedAt: "2026-02-19T00:00:01.000Z",
        session: { title: "x" },
      }),
    ).toThrow("Invalid persisted session snapshot");
  });

  test("parsePersistedSessionSnapshot keeps v1 read compatibility", () => {
    const parsed = parsePersistedSessionSnapshot({
      version: 1,
      sessionId: "legacy-v1",
      createdAt: "2026-02-19T00:00:00.000Z",
      updatedAt: "2026-02-19T00:00:01.000Z",
      session: {
        title: "Legacy",
        titleSource: "default",
        titleModel: null,
        provider: "openai",
        model: "gpt-5.2",
      },
      config: {
        provider: "openai",
        model: "gpt-5.2",
        enableMcp: false,
        workingDirectory: "/tmp/legacy",
      },
      context: {
        system: "legacy",
        messages: [{ role: "user", content: "hello" }],
        todos: [],
        harnessContext: null,
      },
    });

    expect(parsed.version).toBe(1);
    expect(parsed.context).not.toHaveProperty("providerState");
  });

  test("listPersistedSessionSnapshots excludes subagent snapshots from top-level lists", async () => {
    const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-store-subagents-"));
    await writePersistedSessionSnapshot({
      paths: { sessionsDir },
      snapshot: makeSnapshot("root-session"),
    });
    await writePersistedSessionSnapshot({
      paths: { sessionsDir },
      snapshot: {
        ...makeSnapshot("child-session"),
        session: {
          ...makeSnapshot("child-session").session,
          sessionKind: "subagent",
          parentSessionId: "root-session",
          agentType: "general",
        },
      },
    });

    const summaries = await listPersistedSessionSnapshots({ sessionsDir });

    expect(summaries.map((summary) => summary.sessionId)).toEqual(["root-session"]);
  });

  test("listPersistedSessionSnapshots skips malformed files", async () => {
    const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-store-list-test-"));
    const snapshotA = makeSnapshot("sess-a");
    const snapshotB = {
      ...makeSnapshot("sess-b"),
      updatedAt: "2026-02-19T00:00:02.000Z",
    };
    const subagentSnapshot = {
      ...makeSnapshot("sess-child"),
      session: {
        ...makeSnapshot("sess-child").session,
        sessionKind: "subagent" as const,
        parentSessionId: "sess-a",
        agentType: "general" as const,
      },
    };

    await writePersistedSessionSnapshot({
      paths: { sessionsDir },
      snapshot: snapshotA,
    });
    await writePersistedSessionSnapshot({
      paths: { sessionsDir },
      snapshot: snapshotB,
    });
    await writePersistedSessionSnapshot({
      paths: { sessionsDir },
      snapshot: subagentSnapshot,
    });

    await fs.writeFile(path.join(sessionsDir, "broken.json"), "{ invalid", "utf-8");
    await fs.writeFile(path.join(sessionsDir, "invalid-shape.json"), JSON.stringify({ version: 2 }), "utf-8");

    const summaries = await listPersistedSessionSnapshots({ sessionsDir });

    expect(summaries.map((summary) => summary.sessionId)).toEqual(["sess-b", "sess-a"]);
    expect(summaries).toHaveLength(2);
  });
});
