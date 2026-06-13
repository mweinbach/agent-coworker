import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getPersistedSessionFilePath,
  LEGACY_JSON_SESSION_LIST_LAST_EVENT_SEQ,
  listPersistedSessionSnapshots,
  type PersistedSessionSnapshot,
  parsePersistedSessionSnapshot,
  readPersistedSessionSnapshot,
  writePersistedSessionSnapshot,
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
      role: null,
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

function makeRawSnapshot(version: number): {
  version: number;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  session: Record<string, unknown>;
  config: Record<string, unknown>;
  context: Record<string, unknown>;
} {
  const snapshot = {
    version,
    sessionId: `snapshot-v${version}`,
    createdAt: "2026-06-13T00:00:00.000Z",
    updatedAt: "2026-06-13T00:00:01.000Z",
    session: {
      title: `Snapshot v${version}`,
      titleSource: "model",
      titleModel: "gpt-5-mini",
      provider: "openai",
      model: "gpt-5.2",
    } as Record<string, unknown>,
    config: {
      provider: "openai",
      model: "gpt-5.2",
      enableMcp: true,
      workingDirectory: "/tmp/workspace",
    } as Record<string, unknown>,
    context: {
      system: "System prompt",
      messages: [{ role: "user", content: "hello" }],
      todos: [],
      harnessContext: null,
    } as Record<string, unknown>,
  };

  if (version >= 2) {
    snapshot.context.providerState = null;
  }
  if (version >= 3) {
    snapshot.session.sessionKind = "root";
    snapshot.session.parentSessionId = null;
    snapshot.session.role = null;
  }
  if (version >= 4) {
    snapshot.context.costTracker = null;
  }
  if (version >= 5) {
    snapshot.config.backupsEnabledOverride = null;
  }
  if (version >= 6) {
    snapshot.session.mode = null;
    snapshot.session.depth = null;
    snapshot.session.nickname = null;
    snapshot.session.requestedModel = null;
    snapshot.session.effectiveModel = null;
    snapshot.session.requestedReasoningEffort = null;
    snapshot.session.effectiveReasoningEffort = null;
    snapshot.session.executionState = null;
    snapshot.session.lastMessagePreview = null;
  }

  return snapshot;
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

  test("parsePersistedSessionSnapshot preserves advanced-memory checkpoint state", () => {
    const parsed = parsePersistedSessionSnapshot({
      version: 7,
      sessionId: "checkpoint-v7",
      createdAt: "2026-06-03T00:00:00.000Z",
      updatedAt: "2026-06-03T00:00:01.000Z",
      session: {
        title: "Checkpoint",
        titleSource: "manual",
        titleModel: null,
        provider: "openai",
        model: "gpt-5.2",
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
        lastMessagePreview: null,
      },
      config: {
        provider: "openai",
        model: "gpt-5.2",
        enableMcp: true,
        backupsEnabledOverride: null,
        workingDirectory: "/tmp/checkpoint",
      },
      context: {
        system: "system",
        messages: [
          { role: "user", content: "old" },
          { role: "assistant", content: "processed" },
          { role: "user", content: "pending" },
        ],
        lastMemoryGeneratedIndex: 2,
        providerState: null,
        todos: [],
        harnessContext: null,
        costTracker: null,
      },
    });

    expect(parsed.version).toBe(7);
    expect(parsed.context.lastMemoryGeneratedIndex).toBe(2);
  });

  test.each([
    [3, "general", "worker"],
    [4, "explore", "explorer"],
    [5, "research", "research"],
  ] as const)("parsePersistedSessionSnapshot normalizes legacy v%d subagent and agent type values", (version, agentType, expectedRole) => {
    const raw = makeRawSnapshot(version);
    raw.session.sessionKind = "subagent";
    raw.session.agentType = agentType;

    const parsed = parsePersistedSessionSnapshot(raw);

    expect(parsed).toMatchObject({
      version,
      session: {
        sessionKind: "agent",
        role: expectedRole,
      },
    });
  });

  test("parsePersistedSessionSnapshot keeps canonical legacy roles ahead of agentType", () => {
    const raw = makeRawSnapshot(5);
    raw.session.sessionKind = "subagent";
    raw.session.role = "reviewer";
    raw.session.agentType = "general";

    const parsed = parsePersistedSessionSnapshot(raw);

    expect(parsed).toMatchObject({
      version: 5,
      session: {
        sessionKind: "agent",
        role: "reviewer",
      },
    });
  });

  test("parsePersistedSessionSnapshot rejects retired legacy sessionKind values after v5", () => {
    const raw = makeRawSnapshot(6);
    raw.session.sessionKind = "subagent";

    expect(() => parsePersistedSessionSnapshot(raw)).toThrow("Invalid persisted session snapshot");
  });

  test("parsePersistedSessionSnapshot preserves v7 profile, sandbox, and provider options", () => {
    const raw = makeRawSnapshot(7);
    raw.session.profile = {
      id: "reviewer",
      ref: "workspace:reviewer",
      scope: "workspace",
      displayName: "Reviewer",
      description: "Review focused profile",
      baseRole: "reviewer",
      prompt: "Review carefully",
      allowedBuiltInTools: ["read"],
      allowedMcpServers: ["github"],
      skillNames: ["code-review"],
      model: "gpt-5.2",
      reasoningEffort: "high",
      defaultTaskType: "verify",
      defaultContextMode: "brief",
      resolvedAt: "2026-06-13T00:00:00.000Z",
    };
    raw.config.providerOptions = {
      reasoning: { effort: "high" },
      store: false,
    };
    raw.config.sandbox = {
      mode: "workspace-write",
      network: false,
      requireBackend: true,
    };
    raw.context.lastMemoryGeneratedIndex = 1;

    const parsed = parsePersistedSessionSnapshot(raw);

    expect(parsed).toMatchObject({
      version: 7,
      session: {
        profile: {
          id: "reviewer",
          scope: "workspace",
          baseRole: "reviewer",
        },
      },
      config: {
        providerOptions: {
          reasoning: { effort: "high" },
          store: false,
        },
        sandbox: {
          mode: "workspace-write",
          network: false,
          requireBackend: true,
        },
      },
      context: {
        lastMemoryGeneratedIndex: 1,
      },
    });
  });

  test("parsePersistedSessionSnapshot defaults omitted v7 optional objects without pinning config overrides", () => {
    const parsed = parsePersistedSessionSnapshot(makeRawSnapshot(7));

    expect(parsed).toMatchObject({
      version: 7,
      session: {
        profile: null,
      },
    });
    expect(parsed.config).not.toHaveProperty("providerOptions");
    expect(parsed.config).not.toHaveProperty("sandbox");
  });

  test("parsePersistedSessionSnapshot rejects malformed embedded v4 cost tracker state", () => {
    const raw = makeRawSnapshot(4);
    raw.context.costTracker = {};

    expect(() => parsePersistedSessionSnapshot(raw)).toThrow("Invalid persisted session snapshot");
  });

  test("parsePersistedSessionSnapshot rejects malformed embedded v7 sandbox state", () => {
    const raw = makeRawSnapshot(7);
    raw.config.sandbox = {
      mode: "invalid",
    };

    expect(() => parsePersistedSessionSnapshot(raw)).toThrow("Invalid persisted session snapshot");
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
          role: "worker",
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
        role: "worker" as const,
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
    await fs.writeFile(
      path.join(sessionsDir, "invalid-shape.json"),
      JSON.stringify({ version: 2 }),
      "utf-8",
    );

    const summaries = await listPersistedSessionSnapshots({ sessionsDir });

    expect(summaries.map((summary) => summary.sessionId)).toEqual(["sess-b", "sess-a"]);
    expect(summaries).toHaveLength(2);
    for (const summary of summaries) {
      expect(summary.lastEventSeq).toBe(LEGACY_JSON_SESSION_LIST_LAST_EVENT_SEQ);
    }
  });

  test("listPersistedSessionSnapshots filters by workingDirectory for workspace scope parity", async () => {
    const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-store-wd-"));
    const snapshotA = makeSnapshot("sess-a");
    const snapshotB = {
      ...makeSnapshot("sess-b"),
      config: {
        ...makeSnapshot("sess-b").config,
        workingDirectory: "/tmp/other-workspace",
      },
      updatedAt: "2026-02-19T00:00:03.000Z",
    };
    await writePersistedSessionSnapshot({ paths: { sessionsDir }, snapshot: snapshotA });
    await writePersistedSessionSnapshot({ paths: { sessionsDir }, snapshot: snapshotB });

    const scoped = await listPersistedSessionSnapshots(
      { sessionsDir },
      { workingDirectory: "/tmp/workspace" },
    );
    expect(scoped.map((s) => s.sessionId)).toEqual(["sess-a"]);

    const scopedTrailing = await listPersistedSessionSnapshots(
      { sessionsDir },
      { workingDirectory: "/tmp/workspace/" },
    );
    expect(scopedTrailing.map((s) => s.sessionId)).toEqual(["sess-a"]);
  });
});
