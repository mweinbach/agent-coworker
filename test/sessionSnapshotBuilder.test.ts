import { describe, expect, test } from "bun:test";
import path from "node:path";

import { HarnessContextStore } from "../src/harness/contextStore";
import type { SessionRuntimeState } from "../src/server/session/SessionContext";
import { SessionSnapshotBuilder } from "../src/server/session/SessionSnapshotBuilder";
import type { AgentConfig } from "../src/types";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const dir = "/tmp/session-snapshot-builder";
  return {
    provider: "openai",
    model: "gpt-5.4",
    preferredChildModel: "gpt-5-mini",
    workingDirectory: dir,
    outputDirectory: path.join(dir, "output"),
    uploadsDirectory: path.join(dir, "uploads"),
    userName: "",
    knowledgeCutoff: "unknown",
    projectAgentDir: path.join(dir, ".agent"),
    userAgentDir: path.join(dir, ".agent-user"),
    builtInDir: dir,
    builtInConfigDir: path.join(dir, "config"),
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
    ...overrides,
  };
}

function makeAgentState(overrides: Partial<SessionRuntimeState> = {}): SessionRuntimeState {
  const config = makeConfig();
  return {
    config,
    system: "child system prompt",
    discoveredSkills: [],
    yolo: false,
    messages: [],
    allMessages: [],
    providerState: null,
    running: false,
    connecting: false,
    abortController: null,
    currentTurnId: null,
    currentTurnOutcome: "completed",
    maxSteps: 100,
    todos: [],
    sessionInfo: {
      title: "Child session",
      titleSource: "default",
      titleModel: null,
      createdAt: "2026-03-16T18:00:00.000Z",
      updatedAt: "2026-03-16T18:00:00.000Z",
      provider: config.provider,
      model: config.model,
      sessionKind: "agent",
      parentSessionId: "root-1",
      role: "worker",
      mode: "collaborative",
      depth: 1,
      effectiveModel: config.model,
      executionState: "pending_init",
    },
    persistenceStatus: "active",
    hasGeneratedTitle: false,
    backupsEnabledOverride: null,
    sessionBackup: null,
    sessionBackupState: {
      status: "initializing",
      sessionId: "child-1",
      workingDirectory: config.workingDirectory,
      backupDirectory: null,
      createdAt: "2026-03-16T18:00:00.000Z",
      originalSnapshot: { kind: "pending" },
      checkpoints: [],
    },
    sessionBackupInit: null,
    backupOperationQueue: Promise.resolve(),
    lastAutoCheckpointAt: 0,
    costTracker: null,
    ...overrides,
  };
}

describe("SessionSnapshotBuilder child execution state", () => {
  test("persists completed child execution state from runtime instead of stale pending_init metadata", () => {
    const state = makeAgentState({
      currentTurnOutcome: "completed",
      running: false,
      sessionInfo: {
        ...makeAgentState().sessionInfo,
        executionState: "pending_init",
      },
    });
    const builder = new SessionSnapshotBuilder({
      sessionId: "child-1",
      state,
      harnessContextStore: new HarnessContextStore(),
      getEnableMcp: () => true,
      hasPendingAsk: () => false,
      hasPendingApproval: () => false,
    });

    const canonical = builder.buildCanonicalSnapshot("2026-03-16T18:01:00.000Z");
    const persisted = builder.buildPersistedSnapshotAt("2026-03-16T18:01:00.000Z");

    expect(canonical.executionState).toBe("completed");
    expect(persisted.session.executionState).toBe("completed");
  });

  test("persists errored and closed child execution states from runtime", () => {
    const erroredBuilder = new SessionSnapshotBuilder({
      sessionId: "child-1",
      state: makeAgentState({
        currentTurnOutcome: "error",
        sessionInfo: {
          ...makeAgentState().sessionInfo,
          executionState: "pending_init",
        },
      }),
      harnessContextStore: new HarnessContextStore(),
      getEnableMcp: () => true,
      hasPendingAsk: () => false,
      hasPendingApproval: () => false,
    });
    const closedBuilder = new SessionSnapshotBuilder({
      sessionId: "child-1",
      state: makeAgentState({
        persistenceStatus: "closed",
        currentTurnOutcome: "completed",
        sessionInfo: {
          ...makeAgentState().sessionInfo,
          executionState: "pending_init",
        },
      }),
      harnessContextStore: new HarnessContextStore(),
      getEnableMcp: () => true,
      hasPendingAsk: () => false,
      hasPendingApproval: () => false,
    });

    expect(erroredBuilder.buildCanonicalSnapshot("2026-03-16T18:01:00.000Z").executionState).toBe(
      "errored",
    );
    expect(closedBuilder.buildCanonicalSnapshot("2026-03-16T18:01:00.000Z").executionState).toBe(
      "closed",
    );
  });

  test("includes providerOptions in persisted snapshots when routed config overrides are present", () => {
    const providerOptions = {
      openai: {
        reasoningEffort: "xhigh",
        reasoningSummary: "concise",
      },
    };
    const state = makeAgentState({
      config: makeConfig({ providerOptions }),
    });
    const builder = new SessionSnapshotBuilder({
      sessionId: "child-1",
      state,
      harnessContextStore: new HarnessContextStore(),
      getEnableMcp: () => true,
      hasPendingAsk: () => false,
      hasPendingApproval: () => false,
    });

    const persisted = builder.buildPersistedSnapshotAt("2026-03-16T18:01:00.000Z");

    expect(persisted.version).toBe(7);
    expect(persisted.config.providerOptions).toEqual(providerOptions);
  });

  test("derives child lastMessagePreview from the latest assistant transcript when metadata is stale", () => {
    const base = makeAgentState();
    const state = makeAgentState({
      allMessages: [
        {
          role: "assistant",
          content: [{ type: "output_text", phase: "final", text: "Latest child result" }],
        } as any,
      ],
      sessionInfo: {
        ...base.sessionInfo,
        lastMessagePreview: undefined,
      },
    });
    const builder = new SessionSnapshotBuilder({
      sessionId: "child-1",
      state,
      harnessContextStore: new HarnessContextStore(),
      getEnableMcp: () => true,
      hasPendingAsk: () => false,
      hasPendingApproval: () => false,
    });

    const persisted = builder.buildPersistedSnapshotAt("2026-03-16T18:01:00.000Z");
    const canonical = builder.buildCanonicalSnapshot("2026-03-16T18:01:00.000Z");

    expect(persisted.session.lastMessagePreview).toBe("Latest child result");
    expect(canonical.lastMessagePreview).toBe("Latest child result");
  });

  test("preserves a newer sessionInfo preview over older assistant transcript text", () => {
    const base = makeAgentState();
    const state = makeAgentState({
      allMessages: [
        {
          role: "assistant",
          content: [{ type: "output_text", phase: "final", text: "Older child result" }],
        } as any,
      ],
      sessionInfo: {
        ...base.sessionInfo,
        lastMessagePreview: "Latest child error",
      },
    });
    const builder = new SessionSnapshotBuilder({
      sessionId: "child-1",
      state,
      harnessContextStore: new HarnessContextStore(),
      getEnableMcp: () => true,
      hasPendingAsk: () => false,
      hasPendingApproval: () => false,
    });

    const persisted = builder.buildPersistedSnapshotAt("2026-03-16T18:01:00.000Z");
    const canonical = builder.buildCanonicalSnapshot("2026-03-16T18:01:00.000Z");

    expect(persisted.session.lastMessagePreview).toBe("Latest child error");
    expect(canonical.lastMessagePreview).toBe("Latest child error");
  });
});
