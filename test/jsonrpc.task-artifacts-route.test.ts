import { describe, expect, test } from "bun:test";

import type {
  JsonRpcLiteError,
  JsonRpcLiteId,
  JsonRpcLiteRequest,
} from "../src/server/jsonrpc/protocol";
import { createTaskRouteHandlers } from "../src/server/jsonrpc/routes/tasks";
import type { JsonRpcRouteContext } from "../src/server/jsonrpc/routes/types";
import { jsonRpcTaskResultSchemas } from "../src/server/jsonrpc/schema.tasks";
import { ArtifactConflictError } from "../src/server/tasks/TaskCoordinator";
import type {
  TaskArtifactDetail,
  TaskArtifactRevision,
  TaskArtifactVersion,
  TaskRecord,
} from "../src/shared/tasks";

const createdAt = "2026-06-18T12:00:00.000Z";

function version(
  id: string,
  number: number,
  content: string,
  parentVersionId: string | null,
): TaskArtifactVersion {
  return {
    id,
    artifactId: "artifact-1",
    version: number,
    parentVersionId,
    sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
    sizeBytes: Buffer.byteLength(content),
    mediaType: "text/plain",
    createdBy: "session-1",
    createdAt,
    changeSummary: number === 1 ? "Initial version" : "Updated greeting",
    provenance: {},
    reviewStatus: number === 1 ? "accepted" : "draft",
  };
}

function fixture() {
  const before = version("version-1", 1, "hello\n", null);
  const after = version("version-2", 2, "hello coworker\n", before.id);
  const artifact = {
    id: "artifact-1",
    taskId: "task-1",
    workItemId: "work-1",
    threadId: "task-thread-1",
    path: "C:\\workspace\\report.txt",
    kind: "text",
    title: "Report",
    createdBy: "session-1",
    provenance: {},
    createdAt,
  };
  const revision: TaskArtifactRevision = {
    id: "revision-1",
    taskId: "task-1",
    artifactId: artifact.id,
    workItemId: "revision-work-1",
    taskThreadId: "task-thread-2",
    sessionId: "session-2",
    baseVersionId: before.id,
    priorVersionId: after.id,
    status: "active",
    instruction: "Make the conclusion more direct.",
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
  };
  const detail: TaskArtifactDetail = {
    artifact,
    versions: [before, after],
    latestVersionId: after.id,
    acceptedVersionId: before.id,
    activeRevision: null,
  };
  const task: TaskRecord = {
    id: "task-1",
    workspacePath: "C:\\workspace",
    title: "Task",
    objective: "Write the report",
    status: "awaiting_review",
    revision: 4,
    reviewRequired: true,
    createdAt,
    updatedAt: createdAt,
    threadCount: 2,
    completedWorkItemCount: 1,
    totalWorkItemCount: 2,
    activeBlockerCount: 0,
    pendingQuestionCount: 0,
    blockingQuestionCount: 0,
    requirements: [],
    threads: [
      {
        id: "task-thread-1",
        taskId: "task-1",
        sessionId: "session-1",
        title: "Main",
        createdBy: "user",
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: "task-thread-2",
        taskId: "task-1",
        sessionId: "session-2",
        title: "Revise Report",
        createdBy: "coordinator",
        createdAt,
        updatedAt: createdAt,
      },
    ],
    workItems: [],
    decisions: [],
    questions: [],
    artifacts: [artifact],
    blockers: [],
    activity: [],
    latestCheckpoint: null,
  };
  return { before, after, artifact, revision, detail, task };
}

function makeHarness() {
  const data = fixture();
  const results: Array<{ id: JsonRpcLiteId; result: unknown }> = [];
  const errors: Array<{ id: JsonRpcLiteId | null; error: JsonRpcLiteError }> = [];
  const sentMessages: Array<{ text: string; displayText?: string }> = [];
  let baselineCalls = 0;
  const context = {
    tasks: {
      get: () => data.task,
      getArtifactDetail: () => data.detail,
      ensureArtifactBaseline: async () => {
        baselineCalls += 1;
        return data.detail;
      },
      readArtifactVersion: async ({ versionId }: { versionId: string }) => {
        const selected = versionId === data.before.id ? data.before : data.after;
        return {
          bytes: Buffer.from(versionId === data.before.id ? "hello\n" : "hello coworker\n"),
          filename: "report.txt",
          mimeType: "text/plain",
          version: selected,
        };
      },
      startArtifactRevision: async () => ({
        task: { ...data.task, status: "working" },
        detail: { ...data.detail, activeRevision: data.revision },
        revision: data.revision,
      }),
      restoreArtifactVersion: async () => {
        throw new ArtifactConflictError("artifact-1", data.after.sha256, "f".repeat(64));
      },
      handleThreadOutcome: async () => null,
    },
    threads: {
      getLive: () => ({
        runtime: {
          id: "session-2",
          turns: {
            sendUserMessage: async (text: string, _clientId?: string, displayText?: string) => {
              sentMessages.push({ text, ...(displayText ? { displayText } : {}) });
            },
          },
        },
      }),
    },
    utils: {
      resolveWorkspacePath: () => "C:\\workspace",
      buildThreadFromSession: () => ({
        id: "session-2",
        title: "Revise Report",
        preview: "",
        modelProvider: "openai",
        model: "gpt-5",
        cwd: "C:\\workspace",
        createdAt,
        updatedAt: createdAt,
        messageCount: 0,
        lastEventSeq: 0,
        status: { type: "loaded" },
      }),
    },
    jsonrpc: {
      sendResult: (_ws: unknown, id: JsonRpcLiteId, result: unknown) =>
        results.push({ id, result }),
      sendError: (_ws: unknown, id: JsonRpcLiteId | null, error: JsonRpcLiteError) =>
        errors.push({ id, error }),
    },
  } as unknown as JsonRpcRouteContext;
  return { context, results, errors, sentMessages, getBaselineCalls: () => baselineCalls, ...data };
}

async function invoke(context: JsonRpcRouteContext, method: string, params: unknown) {
  const handler = createTaskRouteHandlers(context)[method];
  if (!handler) throw new Error(`Missing handler: ${method}`);
  const request: JsonRpcLiteRequest = { id: 1, method, params };
  await handler({} as never, request);
}

describe("task artifact JSON-RPC routes", () => {
  test("reads terminal legacy artifact detail without creating a baseline", async () => {
    const harness = makeHarness();
    harness.task.status = "completed";
    harness.detail.versions = [];
    harness.detail.latestVersionId = null;
    harness.detail.acceptedVersionId = null;

    await invoke(harness.context, "task/artifact/read", {
      cwd: "C:\\workspace",
      taskId: "task-1",
      artifactId: "artifact-1",
    });

    expect(harness.errors).toEqual([]);
    expect(harness.getBaselineCalls()).toBe(0);
    expect(harness.results[0]?.result).toEqual({
      detail: expect.objectContaining({
        artifact: harness.artifact,
        versions: [],
        latestVersionId: null,
        acceptedVersionId: null,
      }),
    });
  });

  test("compares immutable text versions through the harness", async () => {
    const harness = makeHarness();
    await invoke(harness.context, "task/artifact/version/compare", {
      cwd: "C:\\workspace",
      taskId: "task-1",
      artifactId: "artifact-1",
      baseVersionId: "version-1",
      targetVersionId: "version-2",
    });

    expect(harness.errors).toEqual([]);
    const result = harness.results[0]?.result as { comparison?: { kind?: string } };
    expect(result.comparison?.kind).toBe("text");
    expect(
      jsonRpcTaskResultSchemas["task/artifact/version/compare"].safeParse(result).success,
    ).toBe(true);
  });

  test("starts a focused revision thread and displays only the requested delta", async () => {
    const harness = makeHarness();
    await invoke(harness.context, "task/artifact/revision/start", {
      cwd: "C:\\workspace",
      taskId: "task-1",
      artifactId: "artifact-1",
      baseVersionId: "version-1",
      expectedRevision: 4,
      instruction: "Make the conclusion more direct.",
    });
    await Promise.resolve();

    expect(harness.errors).toEqual([]);
    expect(harness.sentMessages).toHaveLength(1);
    expect(harness.sentMessages[0]?.displayText).toBe("Make the conclusion more direct.");
    expect(harness.sentMessages[0]?.text).toContain("preserve unaffected content");
    const result = harness.results[0]?.result;
    const parsed = jsonRpcTaskResultSchemas["task/artifact/revision/start"].safeParse(result);
    expect(parsed.success).toBe(true);
  });

  test("returns structured conflicts instead of overwriting a changed live file", async () => {
    const harness = makeHarness();
    await invoke(harness.context, "task/artifact/version/restore", {
      cwd: "C:\\workspace",
      taskId: "task-1",
      artifactId: "artifact-1",
      versionId: "version-1",
      expectedRevision: 4,
    });

    expect(harness.results).toEqual([]);
    expect(harness.errors[0]?.error.data).toEqual({
      category: "artifact_conflict",
      artifactId: "artifact-1",
      expectedSha256: harness.after.sha256,
      currentSha256: "f".repeat(64),
    });
  });
});
