import { RAW_REPLAY_PART_TYPES } from "../../../shared/modelStreamReplay";
import { isFailedToolOutcome, type ToolRetryIntent } from "../../../shared/toolRetry";
import {
  createToolRetryAttemptTracker,
  type ToolCallMetadata,
} from "../../../shared/toolRetryAttempts";
import { createRawToolRetryEventTracker } from "../../../shared/toolRetryRawEvents";
import type { ApproveCommandOptions, TodoItem } from "../../../types";
import { getAgentRoleShellPolicy } from "../../agents/roles";
import { MODEL_STREAM_NORMALIZER_VERSION, normalizeModelStreamPart } from "../../modelStream";
import type { SessionContext } from "../SessionContext";
import { getSessionTaskLock } from "../taskLocks";
import type { SteerCoordinator } from "./steerCoordinator";
import { isStartStepPart } from "./userMessageTurnHelpers";

type TurnStreamTracker = {
  startedStepCount: number;
  streamPartIndex: number;
  rawStreamEventIndex: number;
  lastStreamError: unknown;
  /** Set when `session_busy { busy: true }` is emitted; anchors time-to-first-output. */
  turnAnnouncedAtMs: number | null;
  /** True once the first visible output delta (text or reasoning) was observed. */
  firstOutputObserved: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function rawToolKey(part: Record<string, unknown>): string | undefined {
  return asNonEmptyString(part.toolCallId) ?? asNonEmptyString(part.id);
}

function rawToolName(part: Record<string, unknown>): string {
  return asNonEmptyString(part.toolName) ?? "tool";
}

export type RunTurnInvocationDeps = {
  context: SessionContext;
  turnId: string;
  steerCoordinator: SteerCoordinator;
  log: (line: string) => void;
  askUser: (question: string, options?: string[]) => Promise<string>;
  approveCommand: (command: string, opts?: ApproveCommandOptions) => Promise<boolean>;
  updateTodos: (todos: TodoItem[]) => void;
  tracker: TurnStreamTracker;
  includeRawChunks: boolean;
  onAdvancedMemoryChanged?: (folder: string) => Promise<void>;
  setAcceptingSteers: (accepting: boolean) => void;
  allowThreadManagementTools?: boolean;
  toolRetryIntent?: ToolRetryIntent;
};

export function createRunTurnInvocation(deps: RunTurnInvocationDeps) {
  const {
    context,
    turnId,
    steerCoordinator,
    log,
    askUser,
    approveCommand,
    updateTodos,
    tracker,
    includeRawChunks,
    onAdvancedMemoryChanged,
    setAcceptingSteers,
    allowThreadManagementTools,
    toolRetryIntent,
  } = deps;
  const toolRetryTracker = createToolRetryAttemptTracker(toolRetryIntent);
  const rawToolRetryTracker = createRawToolRetryEventTracker(toolRetryTracker);
  const rawBackedToolKeys = new Set<string>();

  return async (maxSteps: number, providerStateOverride = context.state.providerState) => {
    const abortSignal = context.state.abortController?.signal;
    const isTurnAborted = () => abortSignal?.aborted === true;
    const assertCanMutate = (toolName: string) => {
      if (isTurnAborted()) {
        throw new Error(`Tool ${toolName} blocked because the turn was cancelled.`);
      }
      const taskLock = getSessionTaskLock(
        context.deps.sessionDb,
        context.id,
        context.deps.getLiveSessionParentIdImpl,
      );
      if (taskLock?.data.lockKind === "terminal_task_thread") {
        throw new Error(
          `Tool ${toolName} blocked because task ${taskLock.data.taskId} is ${taskLock.data.taskStatus}. Reopen or retry the task before mutating files or tools.`,
        );
      }
      if (taskLock?.data.lockKind === "active_source_chat") {
        throw new Error(
          `Tool ${toolName} blocked because source chat is locked by active task ${taskLock.data.taskId}: ${taskLock.data.taskTitle}. Continue in the task thread or wait until the task reaches a terminal state.`,
        );
      }
    };
    const harnessContext = context.deps.harnessContextStore.get(context.id);
    const taskContext = context.deps.getTaskContextImpl?.(context.id) ?? null;
    const applyTaskDirective = context.deps.applyTaskDirectiveImpl;
    const createTask = context.deps.createTaskImpl;
    return await context.deps.runTurnImpl({
      config: context.state.config,
      system: context.state.system,
      messages: context.state.messages,
      allMessages: context.state.allMessages,
      providerState: providerStateOverride,
      harnessContext,
      taskContext,
      getTaskContext: taskContext
        ? () => context.deps.getTaskContextImpl?.(context.id) ?? null
        : undefined,
      getTaskReviewMaterial:
        taskContext && context.deps.getTaskReviewMaterialImpl
          ? async () => (await context.deps.getTaskReviewMaterialImpl?.(context.id)) ?? null
          : undefined,
      applyTaskDirective:
        taskContext && applyTaskDirective
          ? async (directive) => await applyTaskDirective(context.id, directive)
          : undefined,
      createTask:
        !taskContext && createTask
          ? async (input) => await createTask(context.id, input)
          : undefined,
      referencedPlugins: context.state.turnReferencedPlugins,
      prepareStep: async ({ messages }) => steerCoordinator.drainPendingSteers(messages),
      registerSteerHandler: (handler) => {
        context.state.activeSteerHandler = handler;
        return () => {
          if (context.state.activeSteerHandler === handler) {
            context.state.activeSteerHandler = null;
          }
        };
      },
      threadControl: context.deps.getThreadControlImpl?.(context.id) ?? undefined,
      allowThreadManagementTools,
      agentControl:
        context.state.sessionInfo.sessionKind === "agent" || !context.deps.createAgentSessionImpl
          ? undefined
          : {
              spawn: async ({
                message,
                role,
                profileRef,
                model,
                reasoningEffort,
                nickname,
                taskType,
                targetPaths,
                contextMode,
                briefing,
                includeParentTodos,
                includeHarnessContext,
                forkContext,
              }) => {
                assertCanMutate("spawnAgent");
                const createAgentSession = context.deps.createAgentSessionImpl;
                if (!createAgentSession) {
                  throw new Error("Child-agent spawning is unavailable.");
                }
                return await createAgentSession({
                  parentSessionId: context.id,
                  parentConfig: context.state.config,
                  message,
                  ...(role ? { role } : {}),
                  ...(profileRef ? { profileRef } : {}),
                  ...(nickname ? { nickname } : {}),
                  ...(taskType ? { taskType } : {}),
                  ...(targetPaths !== undefined ? { targetPaths } : {}),
                  ...(model ? { model } : {}),
                  ...(reasoningEffort ? { reasoningEffort } : {}),
                  ...(contextMode !== undefined ? { contextMode } : {}),
                  ...(briefing !== undefined ? { briefing } : {}),
                  ...(includeParentTodos !== undefined ? { includeParentTodos } : {}),
                  ...(includeHarnessContext !== undefined ? { includeHarnessContext } : {}),
                  ...(forkContext !== undefined ? { forkContext } : {}),
                  parentDepth:
                    typeof context.state.sessionInfo.depth === "number"
                      ? context.state.sessionInfo.depth
                      : 0,
                });
              },
              list: async () =>
                await (context.deps.listAgentSessionsImpl?.(context.id) ?? Promise.resolve([])),
              sendInput: async ({ agentId, message, interrupt }) => {
                assertCanMutate("sendAgentInput");
                if (!context.deps.sendAgentInputImpl) {
                  throw new Error("Child-agent input is unavailable.");
                }
                await context.deps.sendAgentInputImpl({
                  parentSessionId: context.id,
                  agentId,
                  message,
                  ...(interrupt !== undefined ? { interrupt } : {}),
                });
              },
              wait: async ({ agentIds, timeoutMs, mode, includeFinalMessage, includeReport }) => {
                if (!context.deps.waitForAgentImpl) {
                  throw new Error("Child-agent waiting is unavailable.");
                }
                return await context.deps.waitForAgentImpl({
                  parentSessionId: context.id,
                  agentIds,
                  ...(timeoutMs !== undefined ? { timeoutMs } : {}),
                  ...(mode !== undefined ? { mode } : {}),
                  ...(includeFinalMessage !== undefined ? { includeFinalMessage } : {}),
                  ...(includeReport !== undefined ? { includeReport } : {}),
                });
              },
              inspect: async ({ agentId }) => {
                if (!context.deps.inspectAgentImpl) {
                  throw new Error("Child-agent inspection is unavailable.");
                }
                return await context.deps.inspectAgentImpl({
                  parentSessionId: context.id,
                  agentId,
                });
              },
              resume: async ({ agentId }) => {
                assertCanMutate("resumeAgent");
                if (!context.deps.resumeAgentImpl) {
                  throw new Error("Child-agent resume is unavailable.");
                }
                return await context.deps.resumeAgentImpl({
                  parentSessionId: context.id,
                  agentId,
                });
              },
              close: async ({ agentId }) => {
                if (!context.deps.closeAgentImpl) {
                  throw new Error("Child-agent closing is unavailable.");
                }
                return await context.deps.closeAgentImpl({
                  parentSessionId: context.id,
                  agentId,
                });
              },
            },
      log: (line) => log(line),
      askUser: (q, opts) => askUser(q, opts),
      approveCommand: (cmd, opts) => approveCommand(cmd, opts),
      updateTodos: (todos) => updateTodos(todos),
      discoveredSkills: context.state.discoveredSkills,
      maxSteps,
      yolo: context.state.yolo,
      enableMcp: context.state.config.enableMcp,
      sessionId: context.id,
      onAdvancedMemoryChanged,
      onSkillUsed: (usage) => {
        context.state.currentTurnSkillUsages.push({
          ...usage,
          turnId,
          usedAt: new Date().toISOString(),
        });
      },
      assertCanMutate,
      spawnDepth:
        typeof context.state.sessionInfo.depth === "number" ? context.state.sessionInfo.depth : 0,
      agentRole: context.state.sessionInfo.role,
      agentProfile: context.state.sessionInfo.profile,
      agentTargetPaths:
        context.state.sessionInfo.sessionKind === "agent"
          ? (context.state.sessionInfo.targetPaths ?? null)
          : null,
      shellPolicy: getAgentRoleShellPolicy(context.state.sessionInfo.role),
      telemetryContext: {
        functionId: "session.turn",
        metadata: {
          sessionId: context.id,
          turnId,
        },
      },
      abortSignal,
      includeRawChunks,
      costTracker: context.state.costTracker ?? undefined,
      toolEnv: context.deps.toolEnv,
      onSessionUsageBudgetUpdated: (snapshot) => {
        context.emit({
          type: "session_usage",
          sessionId: context.id,
          usage: context.state.costTracker?.getCompactSnapshot() ?? snapshot,
        });
        context.queuePersistSessionSnapshot("session.usage_budget_updated");
      },
      onMcpLoadErrors: (errors) => {
        // Surface MCP load failures on every turn (including workspace-cache
        // hits, which skip the initial load-time logging) so users see that
        // the turn is running with a degraded tool set.
        for (const err of errors) {
          log(err.startsWith("[MCP]") ? err : `[MCP] ${err}`);
        }
        context.emitTelemetry("agent.mcp.load_errors", "error", {
          sessionId: context.id,
          count: errors.length,
        });
      },
      onModelError: async (error) => {
        tracker.lastStreamError = error;
        context.emitTelemetry("agent.stream.error", "error", {
          sessionId: context.id,
          provider: context.state.config.provider,
          model: context.state.config.model,
          error: context.formatError(error),
        });
      },
      onModelAbort: async () => {
        context.emitTelemetry("agent.stream.aborted", "ok", {
          sessionId: context.id,
          provider: context.state.config.provider,
          model: context.state.config.model,
        });
      },
      onModelRawEvent: async (rawEvent) => {
        if (isTurnAborted()) return;
        const index = tracker.rawStreamEventIndex++;
        const baseEventPayload = {
          type: "model_stream_raw" as const,
          sessionId: context.id,
          turnId,
          index,
          provider: context.state.config.provider,
          model: context.state.config.model,
          format: rawEvent.format,
          normalizerVersion: MODEL_STREAM_NORMALIZER_VERSION,
          event: rawEvent.event,
        };
        const rawTracking = rawToolRetryTracker.track(baseEventPayload);
        for (const toolKey of rawTracking.toolKeys) {
          rawBackedToolKeys.add(toolKey);
        }
        const eventPayload = {
          ...baseEventPayload,
          ...(rawTracking.metadata.length > 0 ? { toolCallMetadata: rawTracking.metadata } : {}),
        };
        context.emit(eventPayload);
        await context.deps.sessionDb?.persistModelStreamChunk({
          sessionId: context.id,
          turnId,
          chunkIndex: index,
          ts: new Date().toISOString(),
          provider: context.state.config.provider,
          model: context.state.config.model,
          rawFormat: rawEvent.format,
          normalizerVersion: MODEL_STREAM_NORMALIZER_VERSION,
          rawEvent: rawEvent.event,
        });
      },
      onModelStreamPart: async (rawPart) => {
        if (isTurnAborted()) return;
        if (isStartStepPart(rawPart)) {
          tracker.startedStepCount += 1;
          setAcceptingSteers(tracker.startedStepCount < context.state.maxSteps);
        }

        const rawRecord = asRecord(rawPart);
        const rawType = asNonEmptyString(rawRecord?.type);
        const toolKey = rawRecord ? rawToolKey(rawRecord) : undefined;
        const toolName = rawRecord ? rawToolName(rawRecord) : "tool";
        let toolMetadata: ToolCallMetadata | null = null;
        if (toolKey && rawType === "tool-input-start" && !rawBackedToolKeys.has(toolKey)) {
          toolRetryTracker.start(toolKey, toolName);
        } else if (toolKey && rawType === "tool-input-delta" && !rawBackedToolKeys.has(toolKey)) {
          toolRetryTracker.appendInput(
            toolKey,
            typeof rawRecord?.delta === "string" ? rawRecord.delta : "",
          );
        } else if (toolKey && rawType === "tool-input-end" && !rawBackedToolKeys.has(toolKey)) {
          toolMetadata = toolRetryTracker.finalizeBuffered(toolKey, toolName);
        } else if (toolKey && rawType === "tool-call" && !rawBackedToolKeys.has(toolKey)) {
          toolMetadata = toolRetryTracker.finalize(toolKey, toolName, rawRecord?.input);
        } else if (toolKey && rawType === "tool-result") {
          const output = rawRecord?.output;
          toolRetryTracker.complete(
            toolKey,
            !isFailedToolOutcome(toolName, "output-available", output),
          );
        } else if (toolKey && (rawType === "tool-error" || rawType === "tool-output-denied")) {
          toolRetryTracker.complete(toolKey, false);
        }

        const partIndex = tracker.streamPartIndex++;
        const normalized = normalizeModelStreamPart(rawPart, {
          provider: context.state.config.provider,
          includeRawPart: includeRawChunks,
          fallbackIdSeed: turnId,
          rawPartMode: process.env.COWORK_MODEL_STREAM_RAW_MODE === "full" ? "full" : "sanitized",
        });
        if (toolMetadata) {
          normalized.part.inputDigest = toolMetadata.inputDigest;
          if (toolMetadata.retryOf !== undefined) {
            normalized.part.retryOf = toolMetadata.retryOf;
          }
        }
        if (normalized.partType === "error") {
          tracker.lastStreamError = normalized.part.error;
        }
        if (
          !tracker.firstOutputObserved &&
          (normalized.partType === "text_delta" || normalized.partType === "reasoning_delta")
        ) {
          tracker.firstOutputObserved = true;
          if (tracker.turnAnnouncedAtMs !== null) {
            context.emitTelemetry(
              "agent.turn.first_output",
              "ok",
              {
                sessionId: context.id,
                turnId,
                provider: context.state.config.provider,
                model: context.state.config.model,
                partType: normalized.partType,
              },
              Date.now() - tracker.turnAnnouncedAtMs,
            );
          }
        }
        if (tracker.rawStreamEventIndex === 0 || !RAW_REPLAY_PART_TYPES.has(normalized.partType)) {
          context.emit({
            type: "model_stream_chunk",
            sessionId: context.id,
            turnId,
            index: partIndex,
            provider: context.state.config.provider,
            model: context.state.config.model,
            normalizerVersion: normalized.normalizerVersion,
            partType: normalized.partType,
            part: normalized.part,
            ...(normalized.rawPart !== undefined ? { rawPart: normalized.rawPart } : {}),
          });
        }
      },
    });
  };
}
