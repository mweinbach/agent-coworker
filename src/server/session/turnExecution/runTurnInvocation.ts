import { resolveExperimentalA2uiConfig } from "../../../experimental/a2ui/flags";
import type { AgentExecutionState } from "../../../shared/agents";
import type { TodoItem } from "../../../types";
import { getAgentRoleShellPolicy } from "../../agents/roles";
import { MODEL_STREAM_NORMALIZER_VERSION, normalizeModelStreamPart } from "../../modelStream";
import type { SessionContext } from "../SessionContext";
import type { SteerCoordinator } from "./steerCoordinator";
import { isStartStepPart } from "./userMessageTurnHelpers";

export type A2uiSurfaceManagerProvider = () => {
  applyUnknown: (
    value: unknown,
    meta?: { reason?: string; toolCallId?: string },
  ) => {
    ok: boolean;
    surfaceId?: string;
    error?: string;
  };
};

export type TurnStreamTracker = {
  startedStepCount: number;
  streamPartIndex: number;
  rawStreamEventIndex: number;
  lastStreamError: unknown;
};

export type RunTurnInvocationDeps = {
  context: SessionContext;
  turnId: string;
  steerCoordinator: SteerCoordinator;
  getA2uiSurfaceManager?: A2uiSurfaceManagerProvider;
  log: (line: string) => void;
  askUser: (question: string, options?: string[]) => Promise<string>;
  approveCommand: (command: string) => Promise<boolean>;
  updateTodos: (todos: TodoItem[]) => void;
  tracker: TurnStreamTracker;
  includeRawChunks: boolean;
  setAcceptingSteers: (accepting: boolean) => void;
};

export function createRunTurnInvocation(deps: RunTurnInvocationDeps) {
  const {
    context,
    turnId,
    steerCoordinator,
    getA2uiSurfaceManager,
    log,
    askUser,
    approveCommand,
    updateTodos,
    tracker,
    includeRawChunks,
    setAcceptingSteers,
  } = deps;

  return async (maxSteps: number, providerStateOverride = context.state.providerState) => {
    const harnessContext = context.deps.harnessContextStore.get(context.id);
    return await context.deps.runTurnImpl({
      config: context.state.config,
      system: context.state.system,
      messages: context.state.messages,
      allMessages: context.state.allMessages,
      providerState: providerStateOverride,
      harnessContext,
      prepareStep: async ({ messages }) => steerCoordinator.drainPendingSteers(messages),
      registerSteerHandler: (handler) => {
        context.state.activeSteerHandler = handler;
        return () => {
          if (context.state.activeSteerHandler === handler) {
            context.state.activeSteerHandler = null;
          }
        };
      },
      agentControl:
        context.state.sessionInfo.sessionKind === "agent" || !context.deps.createAgentSessionImpl
          ? undefined
          : {
              spawn: async ({
                message,
                role,
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
                const createAgentSession = context.deps.createAgentSessionImpl;
                if (!createAgentSession) {
                  throw new Error("Child-agent spawning is unavailable.");
                }
                return await createAgentSession({
                  parentSessionId: context.id,
                  parentConfig: context.state.config,
                  message,
                  ...(role ? { role } : {}),
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
              wait: async ({ agentIds, timeoutMs, mode }) => {
                if (!context.deps.waitForAgentImpl) {
                  throw new Error("Child-agent waiting is unavailable.");
                }
                return await context.deps.waitForAgentImpl({
                  parentSessionId: context.id,
                  agentIds,
                  ...(timeoutMs !== undefined ? { timeoutMs } : {}),
                  ...(mode !== undefined ? { mode } : {}),
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
      approveCommand: (cmd) => approveCommand(cmd),
      updateTodos: (todos) => updateTodos(todos),
      discoveredSkills: context.state.discoveredSkills,
      maxSteps,
      yolo: context.state.yolo,
      enableMcp: context.state.config.enableMcp,
      sessionId: context.id,
      spawnDepth:
        typeof context.state.sessionInfo.depth === "number" ? context.state.sessionInfo.depth : 0,
      agentRole: context.state.sessionInfo.role,
      shellPolicy: getAgentRoleShellPolicy(context.state.sessionInfo.role),
      telemetryContext: {
        functionId: "session.turn",
        metadata: {
          sessionId: context.id,
          turnId,
        },
      },
      abortSignal: context.state.abortController?.signal,
      includeRawChunks,
      costTracker: context.state.costTracker ?? undefined,
      toolEnv: context.deps.toolEnv,
      ...(resolveExperimentalA2uiConfig(context.state.config) && getA2uiSurfaceManager
        ? {
            applyA2uiEnvelope: (
              envelope: unknown,
              meta?: { reason?: string; toolCallId?: string },
            ) => {
              const manager = getA2uiSurfaceManager?.();
              return (
                manager?.applyUnknown(envelope, meta) ?? {
                  ok: false,
                  error: "A2UI surface manager is unavailable",
                }
              );
            },
          }
        : {}),
      onSessionUsageBudgetUpdated: (snapshot) => {
        context.emit({
          type: "session_usage",
          sessionId: context.id,
          usage: context.state.costTracker?.getCompactSnapshot() ?? snapshot,
        });
        context.queuePersistSessionSnapshot("session.usage_budget_updated");
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
        const index = tracker.rawStreamEventIndex++;
        const eventPayload = {
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
        if (isStartStepPart(rawPart)) {
          tracker.startedStepCount += 1;
          setAcceptingSteers(tracker.startedStepCount < context.state.maxSteps);
        }

        const partIndex = tracker.streamPartIndex++;
        const normalized = normalizeModelStreamPart(rawPart, {
          provider: context.state.config.provider,
          includeRawPart: includeRawChunks,
          fallbackIdSeed: turnId,
          rawPartMode: process.env.COWORK_MODEL_STREAM_RAW_MODE === "full" ? "full" : "sanitized",
        });
        if (normalized.partType === "error") {
          tracker.lastStreamError = normalized.part.error;
        }
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
      },
    });
  };
}
