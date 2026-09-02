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

function makeSnapshot(sessionId: string): Extract<PersistedSessionSnapshot, { version: 4 }> {
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
  describe.each([1, 2, 3, 4, 5, 6, 7])("snapshot v%d contract", (version) => {
    test("accepts minimal snapshots and preserves normalized field presence across JSON roundtrips", () => {
      const raw = makeRawSnapshot(version);
      const parsed = parsePersistedSessionSnapshot(raw);

      expect(parsed).toStrictEqual({
        ...raw,
        session: {
          ...raw.session,
          ...(version >= 6 ? { taskType: null, targetPaths: null } : {}),
          ...(version === 7 ? { profile: null } : {}),
        },
        config: { ...raw.config, outputDirectory: undefined, uploadsDirectory: undefined },
        context: {
          ...raw.context,
          ...(version === 7 ? { lastMemoryGeneratedIndex: undefined, workflowRuns: [] } : {}),
        },
      });
      expect(parsePersistedSessionSnapshot(JSON.parse(JSON.stringify(parsed)))).toStrictEqual(
        parsed,
      );
    });

    test("requires every baseline field except optional legacy role", () => {
      const raw = makeRawSnapshot(version);
      const sections = [raw, raw.session, raw.config, raw.context];
      for (const section of sections) {
        for (const [field, value] of Object.entries(section)) {
          if (section === raw.session && field === "role" && version <= 5) continue;
          const record = section as Record<string, unknown>;
          delete record[field];
          expect(() => parsePersistedSessionSnapshot(raw)).toThrow(
            "Invalid persisted session snapshot",
          );
          record[field] = undefined;
          expect(() => parsePersistedSessionSnapshot(raw)).toThrow(
            "Invalid persisted session snapshot",
          );
          record[field] = value;
        }
      }
    });

    test.each(["snapshot", "session", "config", "context"] as const)(
      "rejects unknown keys in %s, even with undefined values",
      (section) => {
        for (const value of [true, null, undefined]) {
          const raw = makeRawSnapshot(version);
          const record = section === "snapshot" ? raw : raw[section];
          Object.assign(record, { unexpected: value });
          expect(() => parsePersistedSessionSnapshot(raw)).toThrow(
            "Invalid persisted session snapshot",
          );
        }
      },
    );

    test.each([
      ["context", "providerState", 2, 2, true, makeSnapshot("continuation").context.providerState],
      ["session", "sessionKind", 3, 3, false, "agent"],
      ["session", "parentSessionId", 3, 3, true, "parent-session"],
      ["session", "role", 3, 6, true, "reviewer"],
      ["context", "costTracker", 4, 4, true, makeSnapshot("usage").context.costTracker],
      ["config", "backupsEnabledOverride", 5, 5, true, false],
      ["session", "mode", 6, 6, true, "delegate"],
      ["session", "depth", 6, 6, true, 0],
      ["session", "nickname", 6, 6, true, "Reviewer"],
      ["session", "taskType", 6, 8, true, "verify"],
      ["session", "targetPaths", 6, 8, true, ["src/server"]],
      ["session", "requestedModel", 6, 6, true, "gpt-5.2"],
      ["session", "effectiveModel", 6, 6, true, "gpt-5.2"],
      ["session", "requestedReasoningEffort", 6, 6, true, "high"],
      ["session", "effectiveReasoningEffort", 6, 6, true, "high"],
      ["session", "executionState", 6, 6, true, "running"],
      ["session", "lastMessagePreview", 6, 6, true, "Review complete"],
      ["session", "profile", 7, 8, true, null],
      ["config", "providerOptions", 7, 8, false, { futureOption: { enabled: true } }],
      ["config", "sandbox", 7, 8, false, { mode: "workspace-write", network: false }],
      ["context", "lastMemoryGeneratedIndex", 7, 8, false, 0],
      ["context", "workflowRuns", 7, 8, false, []],
      ["config", "outputDirectory", 1, 8, false, "/tmp/output"],
      ["config", "uploadsDirectory", 1, 8, false, "/tmp/uploads"],
    ] as const)(
      "enforces %s.%s version, required, undefined, null, and value boundaries",
      (section, field, introduced, requiredSince, nullable, value) => {
        const raw = makeRawSnapshot(version);
        const supported = version >= introduced;
        const variants = [
          { value, accepted: supported },
          { value: null, accepted: supported && nullable },
          { value: undefined, accepted: supported && version < requiredSince },
          { value: -1, accepted: false },
        ];
        for (const variant of variants) {
          raw[section][field] = variant.value;
          if (variant.accepted) {
            const parsed = parsePersistedSessionSnapshot(raw);
            expect(parsePersistedSessionSnapshot(JSON.parse(JSON.stringify(parsed)))).toStrictEqual(
              parsed,
            );
            if (variant.value !== undefined) {
              expect(parsed[section]).toHaveProperty(field, variant.value);
            }
          } else {
            expect(() => parsePersistedSessionSnapshot(raw)).toThrow(
              "Invalid persisted session snapshot",
            );
          }
        }
        delete raw[section][field];
        if (version < requiredSince) {
          expect(() => parsePersistedSessionSnapshot(raw)).not.toThrow();
        } else {
          expect(() => parsePersistedSessionSnapshot(raw)).toThrow(
            "Invalid persisted session snapshot",
          );
        }
      },
    );

    test("accepts agentType only in v3-v5 and removes it from normalized output", () => {
      for (const agentType of ["general", "explore", "research", null, undefined]) {
        const raw = makeRawSnapshot(version);
        raw.session.agentType = agentType;
        if (version >= 3 && version <= 5) {
          const parsed = parsePersistedSessionSnapshot(raw);
          const role =
            agentType === "general"
              ? "worker"
              : agentType === "explore"
                ? "explorer"
                : (agentType ?? null);
          expect(parsed.session).toHaveProperty("role", role);
          expect(parsed.session).not.toHaveProperty("agentType");
          expect(parsePersistedSessionSnapshot(JSON.parse(JSON.stringify(parsed)))).toStrictEqual(
            parsed,
          );
        } else {
          expect(() => parsePersistedSessionSnapshot(raw)).toThrow(
            "Invalid persisted session snapshot",
          );
        }
      }
    });

    test("rejects malformed common fields and strict nested objects", () => {
      const populated = makeSnapshot("nested");
      for (const [section, field, value] of [
        ["session", "title", "  "],
        ["session", "titleSource", "unknown"],
        ["session", "titleModel", "  "],
        ["session", "model", null],
        ["session", "provider", "unknown"],
        ["config", "provider", "unknown"],
        ["config", "model", "  "],
        ["config", "enableMcp", null],
        ["config", "workingDirectory", "  "],
        ["context", "system", null],
        ["context", "messages", [null]],
        ["context", "todos", [{ ...populated.context.todos[0], unexpected: true }]],
        ["context", "harnessContext", { ...populated.context.harnessContext, unexpected: true }],
      ] as const) {
        const raw = makeRawSnapshot(version);
        raw[section][field] = value;
        expect(() => parsePersistedSessionSnapshot(raw)).toThrow(
          "Invalid persisted session snapshot",
        );
      }
    });

    test("trims identifiers without rewriting message payloads or prompt text", () => {
      const raw = makeRawSnapshot(version);
      raw.sessionId = "  session-id  ";
      raw.session.title = "  title  ";
      raw.session.model = "  model-id  ";
      raw.session.titleModel = "  title-model  ";
      raw.config.model = "  config-model  ";
      raw.config.workingDirectory = "  /tmp/workspace  ";
      raw.config.outputDirectory = "  /tmp/output  ";
      raw.context.system = "  prompt  ";
      raw.context.messages = [{ arbitraryProviderPayload: ["  message  "] }];

      const parsed = parsePersistedSessionSnapshot(raw);
      expect(parsed).toMatchObject({
        sessionId: "session-id",
        session: { title: "title", model: "model-id", titleModel: "title-model" },
        config: {
          model: "config-model",
          workingDirectory: "/tmp/workspace",
          outputDirectory: "/tmp/output",
        },
        context: { system: raw.context.system, messages: raw.context.messages },
      });
      expect(parsePersistedSessionSnapshot(JSON.parse(JSON.stringify(parsed)))).toStrictEqual(
        parsed,
      );
    });
  });

  describe.each([3, 4, 5])("legacy v%d role precedence", (version) => {
    test.each([
      ["reviewer", "general", "reviewer"],
      ["general", "reviewer", "worker"],
      ["explore", "general", "explorer"],
      [null, "general", "worker"],
      [undefined, "explore", "explorer"],
      [null, null, null],
      [undefined, undefined, null],
    ] as const)(
      "normalizes role %s ahead of agentType %s to %s",
      (role, agentType, expectedRole) => {
        const raw = makeRawSnapshot(version);
        raw.session.sessionKind = "subagent";
        raw.session.role = role;
        raw.session.agentType = agentType;
        const parsed = parsePersistedSessionSnapshot(raw);
        expect(parsed.session).toMatchObject({ sessionKind: "agent", role: expectedRole });
        expect(parsed.session).not.toHaveProperty("agentType");
        expect(parsePersistedSessionSnapshot(JSON.parse(JSON.stringify(parsed)))).toStrictEqual(
          parsed,
        );
      },
    );
  });

  test.each([6, 7])("rejects retired session kinds and role aliases in v%d", (version) => {
    for (const [field, value] of [
      ["sessionKind", "subagent"],
      ["role", "general"],
      ["role", "explore"],
    ]) {
      const raw = makeRawSnapshot(version);
      raw.session[field] = value;
      expect(() => parsePersistedSessionSnapshot(raw)).toThrow(
        "Invalid persisted session snapshot",
      );
    }
  });

  test.each([0, 8, "7", null, undefined])("rejects unsupported version %s", (version) => {
    expect(() => parsePersistedSessionSnapshot({ ...makeRawSnapshot(7), version })).toThrow(
      "Invalid persisted session snapshot",
    );
  });

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
  ] as const)(
    "parsePersistedSessionSnapshot normalizes legacy v%d subagent and agent type values",
    (version, agentType, expectedRole) => {
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
    },
  );

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

  test("parsePersistedSessionSnapshot preserves v7 profile, sandbox, provider options, and workflows", () => {
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
    raw.context.workflowRuns = [
      {
        runId: "wf_123",
        name: "Failure",
        phases: ["main"],
        currentPhase: "main",
        agents: [],
        logs: [],
        spentUsd: 0.1,
        outcome: "errored",
        error: "run failed",
      },
    ];

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
        workflowRuns: [{ runId: "wf_123", error: "run failed" }],
      },
    });
    expect(parsePersistedSessionSnapshot(JSON.parse(JSON.stringify(parsed)))).toStrictEqual(parsed);
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
    expect(parsed.context.workflowRuns).toEqual([]);
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
