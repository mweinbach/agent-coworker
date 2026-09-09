import path from "node:path";

import type {
  TaskArtifact,
  TaskArtifactDetail,
  TaskArtifactVersion,
  TaskRecord,
} from "../../shared/tasks";
import type { SessionDb } from "../sessionDb";
import {
  assertExpectedTaskRevision,
  assertTaskAcceptsMutation,
  mediaTypeForArtifact,
  nonEmpty,
} from "./taskPolicy";
import { sameWorkspacePath } from "../../utils/workspacePath";
import { nowIso } from "../../utils/typeGuards";
import type { ArtifactVersionStore } from "./ArtifactVersionStore";
import type { RevisionOutcomeResult } from "./TaskCoordinator";

export type RegisterArtifactInput = {
  taskId: string;
  workspacePath: string;
  expectedRevision: number;
  sessionId?: string;
  path: string;
  title: string;
  kind: string;
  artifactId?: string;
  baseVersionId?: string;
  changeSummary?: string;
  workItemId?: string;
  provenance?: Record<string, unknown>;
};

export type GetArtifactDetailInput = {
  taskId: string;
  workspacePath: string;
  artifactId: string;
};

export type ReadArtifactVersionInput = {
  taskId: string;
  workspacePath: string;
  artifactId: string;
  versionId: string;
};

export type EnsureArtifactBaselineInput = {
  taskId: string;
  workspacePath: string;
  artifactId: string;
  expectedRevision: number;
  expectedSha256?: string;
  createdBy?: string;
};

export type CaptureArtifactVersionRequest = {
  taskId: string;
  workspacePath: string;
  artifactId: string;
  expectedRevision: number;
  expectedSha256?: string;
  changeSummary?: string;
  createdBy?: string;
  provenance?: Record<string, unknown>;
};

export type RestoreArtifactVersionRequest = {
  taskId: string;
  workspacePath: string;
  artifactId: string;
  versionId: string;
  expectedRevision: number;
  expectedSha256?: string;
  createdBy?: string;
  changeSummary?: string;
};

export type AcceptArtifactVersionRequest = {
  taskId: string;
  workspacePath: string;
  artifactId: string;
  versionId?: string;
  expectedRevision: number;
};

/** Coordinator plumbing the artifact phase borrows. All lock discipline lives here. */
export type TaskArtifactHost = {
  sessionDb: SessionDb;
  artifactStore: ArtifactVersionStore;
  runTaskMutation: <T>(
    taskId: string,
    callback: (context: { queued: boolean }) => Promise<T> | T,
  ) => Promise<T>;
  requireTask: (taskId: string, workspacePath: string) => TaskRecord;
  requireArtifactDetail: (input: GetArtifactDetailInput) => TaskArtifactDetail;
  resolveArtifactPath: (task: TaskRecord, artifactPath: string) => Promise<string>;
  makeArtifactVersion: (input: {
    artifact: TaskArtifact;
    version: number;
    parentVersionId: string | null;
    stored: { sha256: string; sizeBytes: number };
    mediaType: string;
    createdBy: string;
    createdAt: string;
    changeSummary: string;
    provenance: Record<string, unknown>;
    reviewStatus: TaskArtifactVersion["reviewStatus"];
  }) => TaskArtifactVersion;
  assertExpectedFingerprint: (
    artifactId: string,
    expectedSha256: string | undefined,
    currentSha256: string | null,
  ) => void;
  notifyUpdated: (task: TaskRecord) => void;
  handleThreadOutcome: (
    sessionId: string,
    outcome: "completed" | "cancelled" | "error",
    failure?: unknown,
  ) => Promise<RevisionOutcomeResult | null>;
  handleThreadOutcomeLocked: (
    sessionId: string,
    outcome: "completed" | "cancelled" | "error",
    failure: unknown,
    options?: { deferTerminalUntilOriginSettled?: boolean },
  ) => Promise<RevisionOutcomeResult | null>;
};

/** Artifact registration, versioning, and acceptance. Runs inside the coordinator's mutation lock. */
export class TaskArtifacts {
  constructor(private readonly host: TaskArtifactHost) {}

  async registerArtifact(input: RegisterArtifactInput): Promise<TaskRecord> {
    return await this.host.runTaskMutation(
      input.taskId,
      async () =>
        await this.registerArtifactLocked(input, { finishActiveRevisionInCurrentLock: true }),
    );
  }

  async registerArtifactLocked(
    input: RegisterArtifactInput,
    options: { finishActiveRevisionInCurrentLock?: boolean } = {},
  ): Promise<TaskRecord> {
    const task = this.host.requireTask(input.taskId, input.workspacePath);
    assertExpectedTaskRevision(task, input.expectedRevision);
    assertTaskAcceptsMutation(task);
    if (input.workItemId && !task.workItems.some((item) => item.id === input.workItemId)) {
      throw new Error(`Unknown work item: ${input.workItemId}`);
    }
    const resolvedPath = await this.host.resolveArtifactPath(task, input.path);
    const activeRevision = input.sessionId
      ? this.host.sessionDb.getActiveTaskArtifactRevisionForSession(input.sessionId)
      : null;
    if (activeRevision) {
      if (input.artifactId && activeRevision.artifactId !== input.artifactId) {
        throw new Error("Active revision targets a different artifact");
      }
      if (input.baseVersionId && input.baseVersionId !== activeRevision.baseVersionId) {
        throw new Error("Artifact base version does not match the active revision");
      }
      const activeDetail = this.host.sessionDb.getTaskArtifactDetail(
        task.id,
        activeRevision.artifactId,
      );
      if (!activeDetail || !sameWorkspacePath(activeDetail.artifact.path, resolvedPath)) {
        throw new Error("Active revision targets a different artifact path");
      }
      const finalized = options.finishActiveRevisionInCurrentLock
        ? await this.host.handleThreadOutcomeLocked(input.sessionId as string, "completed", undefined, {
            deferTerminalUntilOriginSettled: true,
          })
        : await this.host.handleThreadOutcome(input.sessionId as string, "completed");
      if (!finalized) throw new Error("Active artifact revision could not be finalized");
      return finalized.task;
    }
    const stored = await this.host.artifactStore.captureFile(resolvedPath);
    const thread = input.sessionId
      ? task.threads.find((candidate) => candidate.sessionId === input.sessionId)
      : null;
    const createdAt = nowIso();
    const existingArtifact = input.artifactId
      ? task.artifacts.find((candidate) => candidate.id === input.artifactId)
      : task.artifacts.find((candidate) => sameWorkspacePath(candidate.path, resolvedPath));
    if (input.artifactId && !existingArtifact) {
      throw new Error(`Unknown task artifact: ${input.artifactId}`);
    }
    const artifactRecord: TaskArtifact = {
      id: existingArtifact?.id ?? crypto.randomUUID(),
      taskId: task.id,
      workItemId: input.workItemId ?? existingArtifact?.workItemId ?? null,
      threadId: thread?.id ?? existingArtifact?.threadId ?? null,
      path: resolvedPath,
      kind: nonEmpty(input.kind, "Artifact kind"),
      title: nonEmpty(input.title, "Artifact title"),
      createdBy: existingArtifact?.createdBy ?? input.sessionId ?? "user",
      provenance: { ...(existingArtifact?.provenance ?? {}), ...(input.provenance ?? {}) },
      createdAt: existingArtifact?.createdAt ?? createdAt,
    };
    const existingDetail = existingArtifact
      ? this.host.sessionDb.getTaskArtifactDetail(task.id, existingArtifact.id)
      : null;
    const parentVersion = existingDetail?.versions.at(-1) ?? null;
    if (
      input.baseVersionId &&
      !existingDetail?.versions.some((version) => version.id === input.baseVersionId)
    ) {
      throw new Error(`Unknown artifact base version: ${input.baseVersionId}`);
    }
    if (parentVersion?.sha256 === stored.sha256) return task;
    const version = this.host.makeArtifactVersion({
      artifact: artifactRecord,
      version: (parentVersion?.version ?? 0) + 1,
      parentVersionId: parentVersion?.id ?? null,
      stored,
      mediaType: mediaTypeForArtifact(resolvedPath, artifactRecord.kind),
      createdBy: input.sessionId ?? "user",
      createdAt,
      changeSummary:
        input.changeSummary?.trim() ||
        (parentVersion ? "Updated artifact registered" : "Initial artifact registered"),
      provenance: {
        ...(input.provenance ?? {}),
        ...(input.baseVersionId ? { baseVersionId: input.baseVersionId } : {}),
      },
      reviewStatus: "draft",
    });
    const updated = await this.host.sessionDb.registerTaskArtifactVersioned({
      artifact: artifactRecord,
      version,
      expectedRevision: input.expectedRevision,
      updatedAt: createdAt,
    });
    this.host.notifyUpdated(updated);
    return updated;
  }

  getArtifactDetail(input: GetArtifactDetailInput): TaskArtifactDetail | null {
    this.host.requireTask(input.taskId, input.workspacePath);
    return this.host.sessionDb.getTaskArtifactDetail(input.taskId, input.artifactId);
  }

  async readArtifactVersion(input: ReadArtifactVersionInput): Promise<{
    bytes: Uint8Array;
    filename: string;
    mimeType: string;
    version: TaskArtifactVersion;
  }> {
    const detail = this.host.requireArtifactDetail(input);
    const version = detail.versions.find((candidate) => candidate.id === input.versionId);
    if (!version) throw new Error(`Unknown artifact version: ${input.versionId}`);
    return {
      bytes: await this.host.artifactStore.readBytes(version.sha256),
      filename: path.basename(detail.artifact.path),
      mimeType: version.mediaType,
      version,
    };
  }

  async ensureArtifactBaseline(input: EnsureArtifactBaselineInput): Promise<TaskArtifactDetail> {
    return await this.host.runTaskMutation(
      input.taskId,
      async () => await this.ensureArtifactBaselineLocked(input),
    );
  }

  async ensureArtifactBaselineLocked(input: EnsureArtifactBaselineInput): Promise<TaskArtifactDetail> {
    const task = this.host.requireTask(input.taskId, input.workspacePath);
    const detail = this.host.requireArtifactDetail(input);
    if (detail.versions.length > 0) return detail;
    assertExpectedTaskRevision(task, input.expectedRevision);
    assertTaskAcceptsMutation(task);
    const resolvedPath = await this.host.resolveArtifactPath(task, detail.artifact.path);
    const stored = await this.host.artifactStore.captureFile(resolvedPath);
    this.host.assertExpectedFingerprint(detail.artifact.id, input.expectedSha256, stored.sha256);
    const createdAt = nowIso();
    const version = this.host.makeArtifactVersion({
      artifact: detail.artifact,
      version: 1,
      parentVersionId: null,
      stored,
      mediaType: mediaTypeForArtifact(resolvedPath, detail.artifact.kind),
      createdBy: input.createdBy ?? "system",
      createdAt,
      changeSummary: "Initial versioning baseline",
      provenance: { baseline: true },
      reviewStatus: "accepted",
    });
    const baseline = await this.host.sessionDb.registerTaskArtifactBaseline({
      taskId: input.taskId,
      artifactId: input.artifactId,
      version,
      expectedRevision: input.expectedRevision,
      updatedAt: createdAt,
    });
    const refreshedTask = this.host.sessionDb.getTask(input.taskId);
    if (refreshedTask) this.host.notifyUpdated(refreshedTask);
    return baseline;
  }

  async captureArtifactVersion(
    input: CaptureArtifactVersionRequest,
  ): Promise<{ task: TaskRecord; detail: TaskArtifactDetail; version: TaskArtifactVersion }> {
    return await this.host.runTaskMutation(
      input.taskId,
      async () => await this.captureArtifactVersionLocked(input),
    );
  }

  private async captureArtifactVersionLocked(
    input: CaptureArtifactVersionRequest,
  ): Promise<{ task: TaskRecord; detail: TaskArtifactDetail; version: TaskArtifactVersion }> {
    let task = this.host.requireTask(input.taskId, input.workspacePath);
    assertExpectedTaskRevision(task, input.expectedRevision);
    assertTaskAcceptsMutation(task);
    let detail = this.host.requireArtifactDetail(input);
    if (detail.versions.length === 0) {
      detail = await this.ensureArtifactBaselineLocked({
        ...input,
        createdBy: input.createdBy,
      });
      task = this.host.requireTask(input.taskId, input.workspacePath);
      const baseline = detail.versions[0];
      if (!baseline) throw new Error("Artifact baseline was not created");
      return { task, detail, version: baseline };
    }
    const resolvedPath = await this.host.resolveArtifactPath(task, detail.artifact.path);
    const stored = await this.host.artifactStore.captureFile(resolvedPath);
    this.host.assertExpectedFingerprint(detail.artifact.id, input.expectedSha256, stored.sha256);
    const parent = detail.versions.at(-1);
    if (!parent) throw new Error("Artifact baseline was not created");
    if (parent.sha256 === stored.sha256) return { task, detail, version: parent };
    const createdAt = nowIso();
    const version = this.host.makeArtifactVersion({
      artifact: detail.artifact,
      version: parent.version + 1,
      parentVersionId: parent.id,
      stored,
      mediaType: mediaTypeForArtifact(resolvedPath, detail.artifact.kind),
      createdBy: input.createdBy ?? "user",
      createdAt,
      changeSummary: input.changeSummary?.trim() ?? "Artifact version captured",
      provenance: input.provenance ?? {},
      reviewStatus: "draft",
    });
    const updatedDetail = await this.host.sessionDb.captureTaskArtifactVersion({
      taskId: task.id,
      artifactId: detail.artifact.id,
      version,
      expectedRevision: input.expectedRevision,
      updatedAt: createdAt,
    });
    task = this.host.requireTask(task.id, task.workspacePath);
    this.host.notifyUpdated(task);
    return { task, detail: updatedDetail, version };
  }

  async restoreArtifactVersion(
    input: RestoreArtifactVersionRequest,
  ): Promise<{ task: TaskRecord; detail: TaskArtifactDetail; version: TaskArtifactVersion }> {
    return await this.host.runTaskMutation(
      input.taskId,
      async () => await this.restoreArtifactVersionLocked(input),
    );
  }

  private async restoreArtifactVersionLocked(
    input: RestoreArtifactVersionRequest,
  ): Promise<{ task: TaskRecord; detail: TaskArtifactDetail; version: TaskArtifactVersion }> {
    let task = this.host.requireTask(input.taskId, input.workspacePath);
    assertExpectedTaskRevision(task, input.expectedRevision);
    assertTaskAcceptsMutation(task);
    const detail = this.host.requireArtifactDetail(input);
    const target = detail.versions.find((version) => version.id === input.versionId);
    if (!target) throw new Error(`Unknown artifact version: ${input.versionId}`);
    const parent = detail.versions.at(-1);
    if (!parent) throw new Error("Artifact has no version to restore from");
    const resolvedPath = await this.host.resolveArtifactPath(task, detail.artifact.path);
    const current = await this.host.artifactStore.captureFile(resolvedPath);
    this.host.assertExpectedFingerprint(
      detail.artifact.id,
      input.expectedSha256 ?? parent.sha256,
      current.sha256,
    );
    const createdAt = nowIso();
    const version = this.host.makeArtifactVersion({
      artifact: detail.artifact,
      version: parent.version + 1,
      parentVersionId: parent.id,
      stored: { sha256: target.sha256, sizeBytes: target.sizeBytes },
      mediaType: target.mediaType,
      createdBy: input.createdBy ?? "user",
      createdAt,
      changeSummary:
        input.changeSummary?.trim() || `Restored from artifact version ${target.version}`,
      provenance: { restoredFromVersionId: target.id },
      reviewStatus: "draft",
    });
    await this.host.artifactStore.restoreFile({
      blobSha256: target.sha256,
      filePath: resolvedPath,
      expectedFingerprint: current.sha256,
    });
    let updatedDetail: TaskArtifactDetail;
    try {
      updatedDetail = await this.host.sessionDb.captureTaskArtifactVersion({
        taskId: task.id,
        artifactId: detail.artifact.id,
        version,
        expectedRevision: input.expectedRevision,
        updatedAt: createdAt,
        activityKind: "artifact_version_restored",
      });
    } catch (error) {
      await this.host.artifactStore.restoreFile({
        blobSha256: current.sha256,
        filePath: resolvedPath,
        expectedFingerprint: target.sha256,
      });
      throw error;
    }
    task = this.host.requireTask(task.id, task.workspacePath);
    this.host.notifyUpdated(task);
    return { task, detail: updatedDetail, version };
  }

  async acceptArtifactVersion(
    input: AcceptArtifactVersionRequest,
  ): Promise<{ task: TaskRecord; detail: TaskArtifactDetail }> {
    return await this.host.runTaskMutation(
      input.taskId,
      async () => await this.acceptArtifactVersionLocked(input),
    );
  }

  private async acceptArtifactVersionLocked(
    input: AcceptArtifactVersionRequest,
  ): Promise<{ task: TaskRecord; detail: TaskArtifactDetail }> {
    const current = this.host.requireTask(input.taskId, input.workspacePath);
    assertExpectedTaskRevision(current, input.expectedRevision);
    assertTaskAcceptsMutation(current);
    const detail = this.host.requireArtifactDetail(input);
    const versionId = input.versionId ?? detail.latestVersionId;
    if (!versionId) throw new Error("Artifact has no version to accept");
    const task = await this.host.sessionDb.acceptTaskArtifactVersion({
      taskId: input.taskId,
      artifactId: input.artifactId,
      versionId,
      expectedRevision: input.expectedRevision,
      updatedAt: nowIso(),
    });
    const updatedDetail = this.host.requireArtifactDetail(input);
    this.host.notifyUpdated(task);
    return { task, detail: updatedDetail };
  }
}
