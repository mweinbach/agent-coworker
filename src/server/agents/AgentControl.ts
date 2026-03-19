import type { AgentSession } from "../session/AgentSession";
import type { AgentExecutionState, AgentMode, PersistentAgentSummary } from "../../shared/agents";
import type { SessionBinding } from "../startServer/types";

import { routeAgentConfig } from "./modelRouter";
import { getAgentRoleDefinition } from "./roles";
import { StatusBus } from "./StatusBus";
import type {
  AgentCloseOptions,
  AgentControlDeps,
  AgentControlSummaryOverrides,
  AgentResumeOptions,
  AgentSendInputOptions,
  AgentSpawnOptions,
  AgentWaitOptions,
} from "./types";

function executionStateForSession(session: AgentSession, fallback: AgentExecutionState = "completed"): AgentExecutionState {
  const info = session.getSessionInfoEvent();
  if (session.persistenceStatus === "closed") return "closed";
  if (session.isBusy) return "running";
  if (session.currentTurnOutcome === "error") return "errored";
  if (info.executionState === "running" || info.executionState === "pending_init") return fallback;
  if (info.executionState) return info.executionState;
  return fallback;
}

export class AgentControl {
  private readonly statusBus = new StatusBus();
  private readonly inFlightByAgentId = new Map<string, Promise<void>>();

  constructor(private readonly deps: AgentControlDeps) {}

  private hydrateAgentSession(parentSessionId: string, agentId: string): AgentSession {
    const persisted = this.deps.sessionDb?.getSessionRecord(agentId);
    if (!persisted || persisted.parentSessionId !== parentSessionId || persisted.sessionKind !== "agent") {
      throw new Error(`Unknown child agent: ${agentId}`);
    }

    const binding: SessionBinding = { session: null, socket: null };
    const built = this.deps.buildSession(binding, agentId);
    binding.session = built.session;
    built.session.beginDisconnectedReplayBuffer();
    this.deps.sessionBindings.set(built.session.id, binding);
    return built.session;
  }

  private ensureAgentSession(parentSessionId: string, agentId: string): AgentSession {
    const binding = this.deps.sessionBindings.get(agentId);
    if (binding?.session) {
      if (!binding.session.isAgentOf(parentSessionId)) {
        throw new Error(`Unknown child agent: ${agentId}`);
      }
      return binding.session;
    }
    return this.hydrateAgentSession(parentSessionId, agentId);
  }

  private buildAgentSummary(
    session: AgentSession,
    overrides: AgentControlSummaryOverrides = {},
  ): PersistentAgentSummary {
    if (session.sessionKind !== "agent" || !session.parentSessionId || !session.role) {
      throw new Error(`Session ${session.id} is not a collaborative child agent`);
    }
    const info = session.getSessionInfoEvent();
    const executionState = overrides.executionState ?? executionStateForSession(session);
    const summary: PersistentAgentSummary = {
      agentId: session.id,
      parentSessionId: session.parentSessionId,
      role: session.role,
      mode: (info.mode ?? overrides.mode ?? "collaborative") as AgentMode,
      depth: typeof info.depth === "number" ? info.depth : (overrides.depth ?? 1),
      ...(info.nickname ? { nickname: info.nickname } : {}),
      ...(info.requestedModel ? { requestedModel: info.requestedModel } : {}),
      effectiveModel: info.effectiveModel ?? session.getPublicConfig().model,
      ...(info.requestedReasoningEffort ? { requestedReasoningEffort: info.requestedReasoningEffort } : {}),
      ...(info.effectiveReasoningEffort ? { effectiveReasoningEffort: info.effectiveReasoningEffort } : {}),
      title: info.title,
      provider: info.provider,
      createdAt: info.createdAt,
      updatedAt: info.updatedAt,
      lifecycleState: session.persistenceStatus === "closed" ? "closed" : "active",
      executionState,
      busy: overrides.busy ?? session.isBusy,
      ...(info.lastMessagePreview ?? session.getLatestAssistantText()
        ? { lastMessagePreview: info.lastMessagePreview ?? session.getLatestAssistantText()! }
        : {}),
    };
    return summary;
  }

  private publish(parentSessionId: string, session: AgentSession, overrides: AgentControlSummaryOverrides = {}): PersistentAgentSummary {
    const summary = this.buildAgentSummary(session, overrides);
    this.statusBus.publish(summary);
    this.deps.emitParentAgentStatus(parentSessionId, summary);
    return summary;
  }

  private trackRun(
    parentSessionId: string,
    session: AgentSession,
    message: string,
    displayState: AgentExecutionState,
  ): PersistentAgentSummary {
    const run = session.sendUserMessage(message)
      .catch(() => {
        // Child session surfaces its own error event/history; parent notification is published below.
      })
      .finally(() => {
        this.inFlightByAgentId.delete(session.id);
        this.publish(parentSessionId, session);
      });
    this.inFlightByAgentId.set(session.id, run);
    return this.publish(parentSessionId, session, {
      executionState: displayState,
      busy: displayState === "running" ? true : undefined,
    });
  }

  async spawn(opts: AgentSpawnOptions): Promise<PersistentAgentSummary> {
    const role = opts.role ?? "default";
    const roleDefinition = getAgentRoleDefinition(role);
    const depth = (opts.parentDepth ?? 0) + 1;
    const parentSession = opts.forkContext
      ? this.deps.sessionBindings.get(opts.parentSessionId)?.session
      : null;
    if (opts.forkContext && !parentSession) {
      throw new Error(`Unknown parent session: ${opts.parentSessionId}`);
    }
    const routed = routeAgentConfig(opts.parentConfig, {
      role: roleDefinition,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
      connectedProviders: await this.deps.getConnectedProviders(opts.parentConfig),
    });
    if (routed.fallbackLine) {
      this.deps.emitParentLog(opts.parentSessionId, routed.fallbackLine);
    }
    const childSystem = await this.deps.loadAgentPrompt(routed.config, role);
    const binding: SessionBinding = { session: null, socket: null };
    const built = this.deps.buildSession(binding, undefined, {
      config: routed.config,
      system: childSystem,
      ...(parentSession ? { seedContext: parentSession.buildForkContextSeed() } : {}),
      sessionInfoPatch: {
        sessionKind: "agent",
        parentSessionId: opts.parentSessionId,
        role,
        mode: roleDefinition.defaultMode,
        depth,
        requestedModel: routed.requestedModel ?? null,
        effectiveModel: routed.effectiveModel,
        requestedReasoningEffort: routed.requestedReasoningEffort ?? null,
        effectiveReasoningEffort: routed.effectiveReasoningEffort ?? null,
        executionState: "pending_init",
      },
    });
    binding.session = built.session;
    built.session.beginDisconnectedReplayBuffer();
    this.deps.sessionBindings.set(built.session.id, binding);
    this.publish(opts.parentSessionId, built.session, {
      mode: roleDefinition.defaultMode,
      depth,
      requestedModel: routed.requestedModel,
      requestedReasoningEffort: routed.requestedReasoningEffort,
      effectiveReasoningEffort: routed.effectiveReasoningEffort,
      executionState: "pending_init",
    });
    return this.trackRun(opts.parentSessionId, built.session, opts.message, "running");
  }

  async list(parentSessionId: string): Promise<PersistentAgentSummary[]> {
    const summaries = new Map<string, PersistentAgentSummary>();
    if (this.deps.sessionDb) {
      for (const persisted of this.deps.sessionDb.listAgentSessions(parentSessionId)) {
        summaries.set(persisted.agentId, persisted);
      }
    }
    for (const binding of this.deps.sessionBindings.values()) {
      const session = binding.session;
      if (!session?.isAgentOf(parentSessionId)) continue;
      summaries.set(session.id, this.publish(parentSessionId, session));
    }
    return [...summaries.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async sendInput(opts: AgentSendInputOptions): Promise<void> {
    const session = this.ensureAgentSession(opts.parentSessionId, opts.agentId);
    if (session.persistenceStatus === "closed") {
      session.reopenForHistory();
    }
    if (opts.interrupt && session.isBusy) {
      session.cancel();
      await this.inFlightByAgentId.get(opts.agentId);
    } else if (session.isBusy) {
      throw new Error(`Child agent ${opts.agentId} is busy`);
    }
    this.trackRun(opts.parentSessionId, session, opts.message, "running");
  }

  async wait(opts: AgentWaitOptions): Promise<{ timedOut: boolean; agents: PersistentAgentSummary[] }> {
    for (const agentId of opts.agentIds) {
      const session = this.ensureAgentSession(opts.parentSessionId, agentId);
      this.publish(opts.parentSessionId, session);
    }
    return await this.statusBus.wait(opts.agentIds, opts.timeoutMs);
  }

  async resume(opts: AgentResumeOptions): Promise<PersistentAgentSummary> {
    const session = this.ensureAgentSession(opts.parentSessionId, opts.agentId);
    if (session.persistenceStatus === "closed") {
      session.reopenForHistory();
    }
    return this.publish(opts.parentSessionId, session);
  }

  async close(opts: AgentCloseOptions): Promise<PersistentAgentSummary> {
    const session = this.ensureAgentSession(opts.parentSessionId, opts.agentId);
    const binding = this.deps.sessionBindings.get(session.id);
    if (!binding?.session || !binding.session.isAgentOf(opts.parentSessionId)) {
      throw new Error(`Unknown child agent: ${opts.agentId}`);
    }
    binding.session.cancel();
    await this.inFlightByAgentId.get(opts.agentId);
    await binding.session.closeForHistory();
    this.deps.disposeBinding(binding, "parent closed child agent");
    this.deps.sessionBindings.delete(binding.session.id);
    return this.publish(opts.parentSessionId, binding.session, { executionState: "closed" });
  }

  cancelAll(parentSessionId: string): void {
    for (const binding of this.deps.sessionBindings.values()) {
      const session = binding.session;
      if (!session?.isAgentOf(parentSessionId)) continue;
      try {
        session.cancel();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.emitParentLog(parentSessionId, `Failed to cancel child agent ${session.id}: ${message}`);
      }
    }
  }
}
