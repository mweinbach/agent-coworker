import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionDb } from "../src/server/sessionDb";
import { TaskCoordinator } from "../src/server/tasks/TaskCoordinator";

async function createHarness() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "task-mode-test-"));
  const paths = {
    rootDir: path.join(home, ".cowork"),
    sessionsDir: path.join(home, ".cowork", "sessions"),
  };
  await fs.mkdir(paths.sessionsDir, { recursive: true });
  const sessionDb = await SessionDb.create({ paths });
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const coordinator = new TaskCoordinator({
    sessionDb,
    notify: (notification) => notifications.push(notification),
  });
  let nextThread = 1;
  coordinator.setThreadFactory(async () => ({ sessionId: `session-${++nextThread}` }));
  return {
    home,
    sessionDb,
    coordinator,
    notifications,
    workspacePath: path.join(home, "project"),
  };
}

describe("task mode persistence", () => {
  test("creates a complete working plan and locks its source chat idempotently", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const creation = {
        idempotencyKey: "planned-task-1",
        title: "Managed delivery",
        objective: "Deliver a reviewed implementation.",
        context: "The source chat established the implementation constraints.",
        requirements: [{ kind: "acceptance_criterion" as const, text: "All verification passes." }],
        workItems: [
          { key: "build", title: "Build", expectedOutputs: ["Implementation"] },
          {
            key: "verify",
            title: "Verify",
            dependsOn: ["build"],
            expectedOutputs: ["Test evidence"],
          },
        ],
      };
      const created = await harness.coordinator.createPlanned({
        workspacePath: harness.workspacePath,
        sessionId: "task-session-1",
        sourceSessionId: "source-chat-1",
        creationOrigin: "chat_tool",
        workspaceDisposition: "existing_project",
        creation,
      });
      const retried = await harness.coordinator.createPlanned({
        workspacePath: harness.workspacePath,
        sessionId: "unused-retry-session",
        sourceSessionId: "source-chat-1",
        creationOrigin: "chat_tool",
        workspaceDisposition: "existing_project",
        creation,
      });
      const sameKeyFromAnotherChat = await harness.coordinator.createPlanned({
        workspacePath: harness.workspacePath,
        sessionId: "task-session-2",
        sourceSessionId: "source-chat-2",
        creationOrigin: "chat_tool",
        workspaceDisposition: "existing_project",
        creation,
      });

      expect(created.task.status).toBe("working");
      expect(created.task.sourceSessionId).toBe("source-chat-1");
      expect(created.task.context).toContain("source chat");
      expect(created.task.workItems).toHaveLength(2);
      expect(created.task.workItems[1]?.dependsOn).toEqual([created.task.workItems[0]?.id]);
      expect(retried.task.id).toBe(created.task.id);
      expect(sameKeyFromAnotherChat.task.id).not.toBe(created.task.id);
      expect(harness.sessionDb.getActiveTaskForSourceSession("source-chat-1")?.id).toBe(
        created.task.id,
      );
      expect(harness.notifications.some((entry) => entry.method === "task/created")).toBe(true);
      await harness.coordinator.transition({
        taskId: created.task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: created.task.revision,
        status: "cancelled",
        summary: "Cancelled by user",
      });
      expect(harness.sessionDb.getActiveTaskForSourceSession("source-chat-1")).toBeNull();
    } finally {
      harness.sessionDb.close();
    }
  });

  test("persists a task independently from standard chat sessions", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const created = await harness.coordinator.create({
        workspacePath: harness.workspacePath,
        title: "Competitive analysis",
        objective: "Compare the three primary vendors.",
        sessionId: "session-1",
      });

      expect(created.status).toBe("draft");
      expect(created.threads).toHaveLength(1);
      expect(harness.sessionDb.isTaskThread("session-1")).toBe(true);
      expect(harness.coordinator.list(harness.workspacePath)).toHaveLength(1);
      expect(harness.coordinator.getContextForThread("session-1")?.objective).toBe(
        "Compare the three primary vendors.",
      );
      expect(harness.notifications.at(-1)?.method).toBe("task/updated");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("rejects cyclic plans without partially mutating task state", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const created = await harness.coordinator.create({
        workspacePath: harness.workspacePath,
        title: "Model",
        objective: "Build and verify a model.",
        sessionId: "session-1",
      });

      await expect(
        harness.coordinator.replaceWorkItems({
          taskId: created.id,
          workspacePath: harness.workspacePath,
          expectedRevision: created.revision,
          items: [
            { id: "a", title: "A", dependsOn: ["b"] },
            { id: "b", title: "B", dependsOn: ["a"] },
          ],
        }),
      ).rejects.toThrow("cycle");

      const reloaded = harness.coordinator.get(created.id, harness.workspacePath);
      expect(reloaded?.revision).toBe(0);
      expect(reloaded?.workItems).toEqual([]);
    } finally {
      harness.sessionDb.close();
    }
  });

  test("allows concurrent threads only one claim for the same work item", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      let task = await harness.coordinator.create({
        workspacePath: harness.workspacePath,
        title: "Research",
        objective: "Research in parallel.",
        sessionId: "session-1",
      });
      task = await harness.coordinator.replaceWorkItems({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        items: [{ id: "research", title: "Collect sources" }],
      });
      task = await harness.coordinator.addThread({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        title: "Second lane",
        createdBy: "user",
      });
      const [firstThread, secondThread] = task.threads;
      if (!firstThread || !secondThread) throw new Error("Expected two task threads");

      const results = await Promise.allSettled([
        harness.coordinator.claimWorkItem({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          workItemId: "research",
          threadId: firstThread.id,
          expectedRevision: task.revision,
        }),
        harness.coordinator.claimWorkItem({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          workItemId: "research",
          threadId: secondThread.id,
          expectedRevision: task.revision,
        }),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(
        harness.coordinator.get(task.id, harness.workspacePath)?.workItems[0]?.claimedByThreadId,
      ).toBeTruthy();
    } finally {
      harness.sessionDb.close();
    }
  });

  test("preserves work ownership when the plan is revised", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      let task = await harness.coordinator.create({
        workspacePath: harness.workspacePath,
        title: "Owned plan",
        objective: "Keep concurrent work ownership stable.",
        sessionId: "session-1",
      });
      task = await harness.coordinator.replaceWorkItems({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        items: [{ id: "owned", title: "Owned work" }],
      });
      const mainThread = task.threads[0];
      if (!mainThread) throw new Error("Expected a main task thread");
      task = await harness.coordinator.claimWorkItem({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        workItemId: "owned",
        threadId: mainThread.id,
      });
      task = await harness.coordinator.replaceWorkItems({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        items: [
          { id: "owned", title: "Owned work, clarified" },
          { id: "next", title: "Next work", dependsOn: ["owned"] },
        ],
      });

      expect(task.workItems.find((item) => item.id === "owned")?.claimedByThreadId).toBe(
        mainThread.id,
      );
    } finally {
      harness.sessionDb.close();
    }
  });

  test("moves blocking tasks back to working when the final blocker resolves", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      let task = await harness.coordinator.create({
        workspacePath: harness.workspacePath,
        title: "Recoverable work",
        objective: "Recover from a blocking dependency.",
        sessionId: "session-1",
      });
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "working",
        summary: "Work started",
      });
      task = await harness.coordinator.reportBlocker({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        description: "Credential expired",
        blocking: true,
      });
      expect(task.status).toBe("blocked");
      const blocker = task.blockers[0];
      if (!blocker) throw new Error("Expected a blocker");

      task = await harness.coordinator.resolveBlocker({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        blockerId: blocker.id,
      });
      expect(task.status).toBe("working");
      expect(task.blockers[0]?.status).toBe("resolved");
    } finally {
      harness.sessionDb.close();
    }
  });

  test("requires evidence and registered expected outputs before review", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    const artifactPath = path.join(harness.workspacePath, "report.md");
    await fs.writeFile(artifactPath, "# Report\n");
    try {
      let task = await harness.coordinator.create({
        workspacePath: harness.workspacePath,
        title: "Report",
        objective: "Produce a reviewed report.",
        sessionId: "session-1",
      });
      task = await harness.coordinator.replaceWorkItems({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        items: [{ id: "draft", title: "Draft report", expectedOutputs: ["report"] }],
      });
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "working",
        summary: "Work started",
      });
      await expect(
        harness.coordinator.markWorkItem({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          workItemId: "draft",
          expectedRevision: task.revision,
          status: "done",
        }),
      ).rejects.toThrow("Completion evidence");
      task = await harness.coordinator.markWorkItem({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        workItemId: "draft",
        expectedRevision: task.revision,
        status: "done",
        completionEvidence: "Draft exists and was checked.",
      });
      await expect(
        harness.coordinator.proposeCompletion({
          taskId: task.id,
          workspacePath: harness.workspacePath,
          expectedRevision: task.revision,
          summary: "Ready",
        }),
      ).rejects.toThrow("Expected artifact");
      task = await harness.coordinator.registerArtifact({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        path: artifactPath,
        title: "Report",
        kind: "markdown",
        workItemId: "draft",
      });
      task = await harness.coordinator.proposeCompletion({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        summary: "Report ready for review",
      });

      expect(task.status).toBe("awaiting_review");
      await harness.coordinator.checkpointThread("session-1", "turn completed", "Report built");
      expect(
        harness.coordinator.get(task.id, harness.workspacePath)?.latestCheckpoint,
      ).not.toBeNull();
    } finally {
      harness.sessionDb.close();
    }
  });

  test("deduplicates retried agent directives", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      const task = await harness.coordinator.create({
        workspacePath: harness.workspacePath,
        title: "Digest",
        objective: "Prepare a digest.",
        sessionId: "session-1",
      });
      const directive = {
        type: "report_progress" as const,
        idempotencyKey: "progress-1",
        summary: "Sources collected",
      };
      await harness.coordinator.applyDirective("session-1", directive);
      await harness.coordinator.applyDirective("session-1", directive);

      const progress = harness.coordinator
        .get(task.id, harness.workspacePath)
        ?.activity.filter((item) => item.kind === "progress_reported");
      expect(progress).toHaveLength(1);
    } finally {
      harness.sessionDb.close();
    }
  });

  test("completes directly when review is explicitly disabled", async () => {
    const harness = await createHarness();
    await fs.mkdir(harness.workspacePath, { recursive: true });
    try {
      let task = await harness.coordinator.create({
        workspacePath: harness.workspacePath,
        title: "Automatic delivery",
        objective: "Finish without a review gate.",
        sessionId: "session-1",
        reviewRequired: false,
      });
      task = await harness.coordinator.replaceWorkItems({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        items: [{ id: "deliver", title: "Deliver" }],
      });
      task = await harness.coordinator.transition({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        status: "working",
        summary: "Work started",
      });
      task = await harness.coordinator.markWorkItem({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        workItemId: "deliver",
        status: "done",
        completionEvidence: "Delivery verified.",
      });
      task = await harness.coordinator.proposeCompletion({
        taskId: task.id,
        workspacePath: harness.workspacePath,
        expectedRevision: task.revision,
        summary: "Delivered",
      });

      expect(task.status).toBe("completed");
    } finally {
      harness.sessionDb.close();
    }
  });
});
