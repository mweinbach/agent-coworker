import type { z } from "zod";
import { taskCreationInputSchema } from "../../../shared/tasks";
import type { AgentConfig } from "../../../types";
import { ArtifactComparisonService, ArtifactPreviewService } from "../../artifacts";
import { ArtifactFingerprintConflictError } from "../../tasks/ArtifactVersionStore";
import { ArtifactConflictError, buildArtifactRevisionPrompt } from "../../tasks/TaskCoordinator";
import { JSONRPC_ERROR_CODES } from "../protocol";
import { jsonRpcTaskRequestSchemas } from "../schema.tasks";
import { getTaskRpcRequiredPermissions } from "../taskPermissions";
import { classifyWorkspaceKind, listWorkspaceSummaries } from "../workspaceCatalog";
import type { JsonRpcRequestHandler, JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

type TaskRequestMethod = keyof typeof jsonRpcTaskRequestSchemas;
type TaskRequestParams<M extends TaskRequestMethod> = z.infer<
  (typeof jsonRpcTaskRequestSchemas)[M]
>;

const artifactComparisonService = new ArtifactComparisonService();
const artifactPreviewService = new ArtifactPreviewService();

function createTaskHandler<M extends TaskRequestMethod>(
  context: JsonRpcRouteContext,
  method: M,
  run: (params: TaskRequestParams<M>) => Promise<unknown> | unknown,
): JsonRpcRequestHandler {
  return async (ws, message) => {
    const deniedPermission = getDeniedTaskPermission(ws, method);
    if (deniedPermission) {
      context.jsonrpc.sendError(ws, message.id, {
        code: JSONRPC_ERROR_CODES.invalidRequest,
        message: `${method} requires ${deniedPermission} permission`,
        data: { category: "permission_denied", permission: deniedPermission },
      });
      return;
    }
    const parsed = jsonRpcTaskRequestSchemas[method].safeParse(message.params ?? {});
    if (!parsed.success) {
      context.jsonrpc.sendError(ws, message.id, {
        code: JSONRPC_ERROR_CODES.invalidParams,
        message: parsed.error.issues[0]?.message ?? `Invalid ${method} params`,
      });
      return;
    }
    try {
      context.jsonrpc.sendResult(ws, message.id, await run(parsed.data as TaskRequestParams<M>));
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      const revisionMatch = messageText.match(
        /^Task revision conflict: expected (\d+), current (\d+)$/,
      );
      const artifactConflict =
        error instanceof ArtifactConflictError || error instanceof ArtifactFingerprintConflictError;
      context.jsonrpc.sendError(ws, message.id, {
        code: JSONRPC_ERROR_CODES.invalidRequest,
        message: messageText,
        ...(revisionMatch
          ? {
              data: {
                category: "revision_conflict",
                expectedRevision: Number(revisionMatch[1]),
                currentRevision: Number(revisionMatch[2]),
              },
            }
          : {}),
        ...(artifactConflict
          ? {
              data: {
                category: "artifact_conflict",
                ...(error instanceof ArtifactConflictError
                  ? {
                      artifactId: error.artifactId,
                      expectedSha256: error.expectedSha256,
                      currentSha256: error.currentSha256,
                    }
                  : {
                      expectedSha256: error.expectedFingerprint,
                      currentSha256: error.actualFingerprint,
                    }),
              },
            }
          : {}),
      });
    }
  };
}

function getDeniedTaskPermission(
  ws: Parameters<JsonRpcRequestHandler>[0],
  method: TaskRequestMethod,
): "conversations" | "turns" | null {
  const requiredPermissions = getTaskRpcRequiredPermissions(method);
  if (requiredPermissions.includes("conversations") && ws.data?.taskReadAllowed === false) {
    return "conversations";
  }
  if (requiredPermissions.includes("turns") && ws.data?.taskMutationAllowed === false) {
    return "turns";
  }
  return null;
}

async function requireProjectTaskWorkspacePath(
  context: JsonRpcRouteContext,
  workspacePath: string,
  method: string,
): Promise<string> {
  if (!context.desktopService) {
    return workspacePath;
  }
  const { workspaces } = await listWorkspaceSummaries({
    workingDirectory: context.getConfig().workingDirectory,
    desktopService: context.desktopService,
    homedir: context.homedir,
  });
  const workspace = workspaces.find((entry) => entry.path === workspacePath);
  const workspaceKind =
    workspace?.workspaceKind ?? classifyWorkspaceKind({ path: workspacePath }, context.homedir);
  if (workspaceKind !== "project") {
    throw new Error(`${method} cwd must match an authorized project workspace`);
  }
  return workspace?.path ?? workspacePath;
}

export async function resolveTaskWorkspacePath(
  context: JsonRpcRouteContext,
  params: { cwd?: string },
  method: string,
): Promise<string> {
  try {
    const workspacePath = context.utils.resolveWorkspacePath(params, method);
    return await requireProjectTaskWorkspacePath(context, workspacePath, method);
  } catch (error) {
    const requestedCwd = typeof params.cwd === "string" ? params.cwd.trim() : "";
    if (!requestedCwd || !context.desktopService) {
      throw error;
    }
    const { workspaces } = await listWorkspaceSummaries({
      workingDirectory: context.getConfig().workingDirectory,
      desktopService: context.desktopService,
      homedir: context.homedir,
    });
    const workspace = workspaces.find((entry) => entry.path === requestedCwd);
    if (!workspace) {
      throw error;
    }
    if (workspace.workspaceKind !== "project") {
      throw new Error(`${method} cwd must match an authorized project workspace`);
    }
    return workspace.path;
  }
}

export function createTaskRouteHandlers(context: JsonRpcRouteContext): JsonRpcRequestHandlerMap {
  return {
    "task/create": createTaskHandler(context, "task/create", async (params) => {
      const cwd = await resolveTaskWorkspacePath(context, params, "task/create");
      const { cwd: _cwd, provider, model, ...rawCreation } = params;
      const creation = taskCreationInputSchema.parse(rawCreation);
      const existing = context.tasks.getByCreationKey(creation.idempotencyKey, {
        sourceSessionId: null,
        workspacePath: cwd,
      });
      if (existing) {
        const mainSessionId = existing.threads[0]?.sessionId;
        const live = mainSessionId ? context.threads.getLive(mainSessionId)?.runtime : null;
        const persisted = mainSessionId ? context.threads.getPersisted(mainSessionId) : null;
        if (!live && !persisted) {
          throw new Error("The existing task thread is unavailable");
        }
        return {
          task: existing,
          thread: live
            ? context.utils.buildThreadFromSession(live)
            : context.utils.buildThreadFromRecord(persisted as NonNullable<typeof persisted>),
        };
      }
      const runtime = context.threads.create({
        cwd,
        provider: provider as AgentConfig["provider"] | undefined,
        model,
      });
      await runtime.lifecycle.waitForPersistenceIdle();
      const result = await context.tasks.createPlanned({
        workspacePath: cwd,
        sessionId: runtime.id,
        sourceSessionId: null,
        creationOrigin: "manual",
        workspaceDisposition: "existing_project",
        creation,
      });
      const kickoff = [
        `Execute the task "${result.task.title}" using the existing task brief and work graph.`,
        "Start with the first unblocked work item. Maintain task state with taskUpdate and ask only at material decision boundaries.",
      ].join("\n\n");
      void runtime.turns
        .sendUserMessage(kickoff, undefined, `Start task: ${result.task.title}`)
        .catch((error) =>
          context.tasks.handleThreadOutcome(runtime.id, "error", error).catch(() => undefined),
        );
      return { task: result.task, thread: context.utils.buildThreadFromSession(runtime) };
    }),
    "task/list": createTaskHandler(context, "task/list", async (params) => {
      const cwd = await resolveTaskWorkspacePath(context, params, "task/list");
      const tasks = context.tasks.list(cwd);
      return { tasks, total: tasks.length };
    }),
    "task/read": createTaskHandler(context, "task/read", async (params) => ({
      task: context.tasks.get(
        params.taskId,
        await resolveTaskWorkspacePath(context, params, "task/read"),
      ),
    })),
    "task/updateBrief": createTaskHandler(context, "task/updateBrief", async (params) => ({
      task: await context.tasks.updateBrief({
        ...params,
        workspacePath: await resolveTaskWorkspacePath(context, params, "task/updateBrief"),
      }),
    })),
    "task/updateGraph": createTaskHandler(context, "task/updateGraph", async (params) => ({
      task: await context.tasks.replaceWorkItems({
        taskId: params.taskId,
        workspacePath: await resolveTaskWorkspacePath(context, params, "task/updateGraph"),
        expectedRevision: params.expectedRevision,
        items: params.workItems,
      }),
    })),
    "task/workItem/claim": createTaskHandler(context, "task/workItem/claim", async (params) => ({
      task: await context.tasks.claimWorkItem({
        taskId: params.taskId,
        workspacePath: await resolveTaskWorkspacePath(context, params, "task/workItem/claim"),
        workItemId: params.workItemId,
        threadId: params.taskThreadId,
        expectedRevision: params.expectedRevision,
      }),
    })),
    "task/workItem/mark": createTaskHandler(context, "task/workItem/mark", async (params) => ({
      task: await context.tasks.markWorkItem({
        taskId: params.taskId,
        workspacePath: await resolveTaskWorkspacePath(context, params, "task/workItem/mark"),
        workItemId: params.workItemId,
        expectedRevision: params.expectedRevision,
        status: params.status,
        completionEvidence: params.completionEvidence,
      }),
    })),
    "task/decision/record": createTaskHandler(context, "task/decision/record", async (params) => ({
      task: await context.tasks.recordDecision({
        taskId: params.taskId,
        workspacePath: await resolveTaskWorkspacePath(context, params, "task/decision/record"),
        expectedRevision: params.expectedRevision,
        question: params.question,
        resolution: params.resolution,
        source: params.source,
        scope: params.scope,
        confidence: params.confidence,
        supersedes: params.supersedes,
      }),
    })),
    "task/questions/resolve": createTaskHandler(
      context,
      "task/questions/resolve",
      async (params) =>
        await context.tasks.resolveQuestions({
          taskId: params.taskId,
          workspacePath: await resolveTaskWorkspacePath(context, params, "task/questions/resolve"),
          expectedRevision: params.expectedRevision,
          answers: params.answers,
        }),
    ),
    "task/blocker/report": createTaskHandler(context, "task/blocker/report", async (params) => ({
      task: await context.tasks.reportBlocker({
        taskId: params.taskId,
        workspacePath: await resolveTaskWorkspacePath(context, params, "task/blocker/report"),
        expectedRevision: params.expectedRevision,
        description: params.description,
        blocking: params.blocking,
        workItemId: params.workItemId,
      }),
    })),
    "task/blocker/resolve": createTaskHandler(context, "task/blocker/resolve", async (params) => ({
      task: await context.tasks.resolveBlocker({
        taskId: params.taskId,
        workspacePath: await resolveTaskWorkspacePath(context, params, "task/blocker/resolve"),
        expectedRevision: params.expectedRevision,
        blockerId: params.blockerId,
      }),
    })),
    "task/artifact/register": createTaskHandler(
      context,
      "task/artifact/register",
      async (params) => ({
        task: await context.tasks.registerArtifact({
          taskId: params.taskId,
          workspacePath: await resolveTaskWorkspacePath(context, params, "task/artifact/register"),
          expectedRevision: params.expectedRevision,
          path: params.path,
          title: params.title,
          kind: params.kind,
          artifactId: params.artifactId,
          baseVersionId: params.baseVersionId,
          changeSummary: params.changeSummary,
          workItemId: params.workItemId,
          provenance: params.provenance,
        }),
      }),
    ),
    "task/artifact/read": createTaskHandler(context, "task/artifact/read", async (params) => {
      const workspacePath = await resolveTaskWorkspacePath(context, params, "task/artifact/read");
      let detail = context.tasks.getArtifactDetail({
        taskId: params.taskId,
        workspacePath,
        artifactId: params.artifactId,
      });
      if (!detail) throw new Error(`Unknown task artifact: ${params.artifactId}`);
      if (detail.versions.length === 0) {
        const task = context.tasks.get(params.taskId, workspacePath);
        if (!task) throw new Error(`Unknown task: ${params.taskId}`);
        if (
          task.status === "completed" ||
          task.status === "cancelled" ||
          task.status === "failed"
        ) {
          return { detail };
        }
        try {
          detail = await context.tasks.ensureArtifactBaseline({
            taskId: params.taskId,
            workspacePath,
            artifactId: params.artifactId,
            expectedRevision: task.revision,
          });
        } catch (error) {
          const concurrent = context.tasks.getArtifactDetail({
            taskId: params.taskId,
            workspacePath,
            artifactId: params.artifactId,
          });
          if (!concurrent || concurrent.versions.length === 0) throw error;
          detail = concurrent;
        }
      }
      return { detail };
    }),
    "task/artifact/version/capture": createTaskHandler(
      context,
      "task/artifact/version/capture",
      async (params) => {
        const result = await context.tasks.captureArtifactVersion({
          taskId: params.taskId,
          workspacePath: await resolveTaskWorkspacePath(
            context,
            params,
            "task/artifact/version/capture",
          ),
          artifactId: params.artifactId,
          expectedRevision: params.expectedRevision,
          changeSummary: params.changeSummary,
        });
        return { task: result.task, detail: result.detail };
      },
    ),
    "task/artifact/version/compare": createTaskHandler(
      context,
      "task/artifact/version/compare",
      async (params) => {
        const workspacePath = await resolveTaskWorkspacePath(
          context,
          params,
          "task/artifact/version/compare",
        );
        const [before, after] = await Promise.all([
          context.tasks.readArtifactVersion({
            taskId: params.taskId,
            workspacePath,
            artifactId: params.artifactId,
            versionId: params.baseVersionId,
          }),
          context.tasks.readArtifactVersion({
            taskId: params.taskId,
            workspacePath,
            artifactId: params.artifactId,
            versionId: params.targetVersionId,
          }),
        ]);
        return {
          comparison: await artifactComparisonService.compare({
            before: {
              bytes: before.bytes,
              filename: before.filename,
              mimeType: before.mimeType,
            },
            after: {
              bytes: after.bytes,
              filename: after.filename,
              mimeType: after.mimeType,
            },
          }),
        };
      },
    ),
    "task/artifact/version/preview": createTaskHandler(
      context,
      "task/artifact/version/preview",
      async (params) => {
        const source = await context.tasks.readArtifactVersion({
          taskId: params.taskId,
          workspacePath: await resolveTaskWorkspacePath(
            context,
            params,
            "task/artifact/version/preview",
          ),
          artifactId: params.artifactId,
          versionId: params.versionId,
        });
        return {
          versionId: params.versionId,
          preview: await artifactPreviewService.preview({
            bytes: source.bytes,
            filename: source.filename,
            mimeType: source.mimeType,
          }),
        };
      },
    ),
    "task/artifact/version/restore": createTaskHandler(
      context,
      "task/artifact/version/restore",
      async (params) => {
        const workspacePath = await resolveTaskWorkspacePath(
          context,
          params,
          "task/artifact/version/restore",
        );
        const detail = context.tasks.getArtifactDetail({
          taskId: params.taskId,
          workspacePath,
          artifactId: params.artifactId,
        });
        const expectedSha256 = detail?.versions.at(-1)?.sha256;
        if (!expectedSha256) throw new Error("Artifact has no current version to restore over");
        const result = await context.tasks.restoreArtifactVersion({
          taskId: params.taskId,
          workspacePath,
          artifactId: params.artifactId,
          versionId: params.versionId,
          expectedRevision: params.expectedRevision,
          expectedSha256,
          changeSummary: params.changeSummary,
        });
        return { task: result.task, detail: result.detail };
      },
    ),
    "task/artifact/version/accept": createTaskHandler(
      context,
      "task/artifact/version/accept",
      async (params) => {
        return await context.tasks.acceptArtifactVersion({
          taskId: params.taskId,
          workspacePath: await resolveTaskWorkspacePath(
            context,
            params,
            "task/artifact/version/accept",
          ),
          artifactId: params.artifactId,
          versionId: params.versionId,
          expectedRevision: params.expectedRevision,
        });
      },
    ),
    "task/artifact/revision/start": createTaskHandler(
      context,
      "task/artifact/revision/start",
      async (params) => {
        const result = await context.tasks.startArtifactRevision({
          taskId: params.taskId,
          workspacePath: await resolveTaskWorkspacePath(
            context,
            params,
            "task/artifact/revision/start",
          ),
          artifactId: params.artifactId,
          instruction: params.instruction,
          baseVersionId: params.baseVersionId,
          expectedRevision: params.expectedRevision,
          title: params.title,
          provider: params.provider,
          model: params.model,
        });
        const binding = context.threads.getLive(result.revision.sessionId);
        if (!binding?.runtime) {
          await context.tasks.handleThreadOutcome(result.revision.sessionId, "error");
          throw new Error("Artifact revision thread runtime is unavailable");
        }
        const prompt = buildArtifactRevisionPrompt({
          artifact: result.detail.artifact,
          revision: result.revision,
        });
        void binding.runtime.turns
          .sendUserMessage(prompt, undefined, params.instruction)
          .catch(async () => {
            await context.tasks
              .handleThreadOutcome(result.revision.sessionId, "error")
              .catch(() => undefined);
          });
        return {
          ...result,
          thread: context.utils.buildThreadFromSession(binding.runtime),
        };
      },
    ),
    "task/thread/create": createTaskHandler(context, "task/thread/create", async (params) => {
      const before = context.tasks.get(
        params.taskId,
        await resolveTaskWorkspacePath(context, params, "task/thread/create"),
      );
      if (!before) throw new Error(`Unknown task: ${params.taskId}`);
      const task = await context.tasks.addThread({
        taskId: params.taskId,
        workspacePath: before.workspacePath,
        expectedRevision: params.expectedRevision,
        title: params.title,
        createdBy: "user",
        workItemId: params.workItemId,
        provider: params.provider,
        model: params.model,
      });
      const priorSessionIds = new Set(before.threads.map((thread) => thread.sessionId));
      const createdThread = task.threads.find((thread) => !priorSessionIds.has(thread.sessionId));
      if (!createdThread) throw new Error("Task thread was not created");
      const binding = context.threads.getLive(createdThread.sessionId);
      if (!binding?.runtime) throw new Error("Task thread runtime is unavailable");
      return { task, thread: context.utils.buildThreadFromSession(binding.runtime) };
    }),
    "task/proposeCompletion": createTaskHandler(
      context,
      "task/proposeCompletion",
      async (params) => ({
        task: await context.tasks.proposeCompletion({
          taskId: params.taskId,
          workspacePath: await resolveTaskWorkspacePath(context, params, "task/proposeCompletion"),
          expectedRevision: params.expectedRevision,
          summary: params.summary,
          caveats: params.caveats,
        }),
      }),
    ),
    "task/cancel": createTaskHandler(context, "task/cancel", async (params) => {
      const workspacePath = await resolveTaskWorkspacePath(context, params, "task/cancel");
      const task = await context.tasks.transition({
        taskId: params.taskId,
        workspacePath,
        expectedRevision: params.expectedRevision,
        status: "cancelled",
        summary: "Task cancelled",
        detail: params.reason,
      });
      return { task };
    }),
    "task/accept": createTaskHandler(context, "task/accept", async (params) => ({
      task: await context.tasks.acceptTask({
        taskId: params.taskId,
        workspacePath: await resolveTaskWorkspacePath(context, params, "task/accept"),
        expectedRevision: params.expectedRevision,
      }),
    })),
    "task/requestChanges": createTaskHandler(context, "task/requestChanges", async (params) => ({
      task: await context.tasks.requestChanges({
        taskId: params.taskId,
        workspacePath: await resolveTaskWorkspacePath(context, params, "task/requestChanges"),
        expectedRevision: params.expectedRevision,
        feedback: params.feedback,
      }),
    })),
    "task/reopen": createTaskHandler(context, "task/reopen", async (params) => ({
      task: await context.tasks.reopenTask({
        taskId: params.taskId,
        workspacePath: await resolveTaskWorkspacePath(context, params, "task/reopen"),
        expectedRevision: params.expectedRevision,
        reason: params.reason,
      }),
    })),
    "task/retry": createTaskHandler(
      context,
      "task/retry",
      async (params) =>
        await context.tasks.retryTask({
          taskId: params.taskId,
          workspacePath: await resolveTaskWorkspacePath(context, params, "task/retry"),
          expectedRevision: params.expectedRevision,
        }),
    ),
  };
}
