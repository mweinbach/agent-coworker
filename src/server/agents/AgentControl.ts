import path from "node:path";

import { isUsableTargetPath } from "../../platform/sandbox/policy";
import {
  type AgentExecutionState,
  type AgentInspectResult,
  type AgentMode,
  agentTaskTypeSchema,
  normalizeAgentTargetPaths,
  type PersistentAgentSummary,
  resolveAgentSpawnContextOptions,
} from "../../shared/agents";
import type { AgentSession } from "../session/AgentSession";
import type { SessionBinding } from "../startServer/types";

import { routeAgentConfig } from "./modelRouter";
import { resolveAgentProfileSnapshot } from "./profiles";
import { inspectChildAgentReport } from "./reportParser";
import { AGENT_ROLE_DEFINITIONS, getAgentRoleDefinition } from "./roles";

// Defense-in-depth caps for child-agent spawning. The primary guard against
// recursive spawning is that child sessions (sessionKind === "agent") are built
// without an AgentControl, so only a root session can spawn. These caps bound a
// runaway or jailbroken root and survive any regression of that guard:
//  - MAX_SPAWN_DEPTH tracks the role definitions (no role currently permits a
//    child to spawn, so the only legitimate child depth is 1) and prevents
//    unbounded recursion.
//  - MAX_ACTIVE_CHILDREN_PER_PARENT bounds a fork-bomb of sibling agents that
//    would otherwise exhaust file descriptors, memory, and MCP loads.
const MAX_SPAWN_DEPTH =
  Math.max(0, ...Object.values(AGENT_ROLE_DEFINITIONS).map((r) => r.maxDepth)) + 1;
const MAX_ACTIVE_CHILDREN_PER_PARENT = 16;
import { StatusBus } from "./StatusBus";
import type {
  AgentCloseOptions,
  AgentControlDeps,
  AgentControlSummaryOverrides,
  AgentInspectOptions,
  AgentResumeOptions,
  AgentSendInputOptions,
  AgentSpawnOptions,
  AgentWaitInspection,
  AgentWaitOptions,
  AgentWaitResult,
} from "./types";

function executionStateForSession(
  session: AgentSession,
  fallback: AgentExecutionState = "pending_init",
): AgentExecutionState {
  const info = session.getSessionInfoEvent();
  if (session.persistenceStatus === "closed") return "closed";
  if (session.isBusy) return "running";
  if (session.currentTurnOutcome === "error") return "errored";
  if (info.executionState === "running" || info.executionState === "pending_init") {
    return session.getLatestAssistantText() !== null ? "completed" : info.executionState;
  }
  if (info.executionState) return info.executionState;
  return fallback;
}

function shouldReadParentSeedContext(
  opts: ReturnType<typeof resolveAgentSpawnContextOptions>,
): boolean {
  return opts.contextMode !== "none" || opts.includeParentTodos || opts.includeHarnessContext;
}

function buildSeedContextForSpawn(
  parentSession: AgentSession,
  opts: ReturnType<typeof resolveAgentSpawnContextOptions>,
) {
  if (opts.contextMode === "full") {
    return parentSession.buildForkContextSeed();
  }
  if (opts.contextMode === "brief") {
    return parentSession.buildContextSeed({
      contextMode: "brief",
      briefing: opts.briefing,
      includeParentTodos: opts.includeParentTodos,
      includeHarnessContext: opts.includeHarnessContext,
    });
  }
  if (!opts.includeParentTodos && !opts.includeHarnessContext) {
    return null;
  }
  return parentSession.buildContextSeed({
    contextMode: "none",
    includeParentTodos: opts.includeParentTodos,
    includeHarnessContext: opts.includeHarnessContext,
  });
}

function normalizeNickname(nickname: string | null | undefined): string | undefined {
  if (nickname === undefined || nickname === null) return undefined;
  const trimmed = nickname.trim();
  if (!trimmed) {
    throw new Error("nickname must not be empty");
  }
  return trimmed;
}

export class AgentControl {
  private readonly statusBus = new StatusBus();
  private readonly inFlightByAgentId = new Map<string, Promise<void>>();
  // Synchronous reservation of concurrency slots per parent. spawn() registers
  // its binding only after several awaits, so without reserving a slot up-front
  // concurrent spawns would all read the same pre-spawn count and blow past
  // MAX_ACTIVE_CHILDREN_PER_PARENT. Reserved at the (synchronous) check, released
  // once the binding is registered (or the spawn fails).
  private readonly inFlightSpawnsByParent = new Map<string, number>();

  constructor(private readonly deps: AgentControlDeps) {}

  private hydrateAgentSession(parentSessionId: string, agentId: string): AgentSession {
    const persisted = this.deps.sessionDb?.getSessionRecord(agentId);
    if (
      !persisted ||
      persisted.parentSessionId !== parentSessionId ||
      persisted.sessionKind !== "agent"
    ) {
      throw new Error(`Unknown child agent: ${agentId}`);
    }

    const binding: SessionBinding = {
      session: null,
      runtime: null,
      socket: null,
      sinks: new Map(),
    };
    const built = this.deps.buildSession(binding, agentId);
    binding.session = built.session;
    binding.runtime = built.runtime;
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
    const sessionUsage = session.getCompactUsageSnapshot();
    const lastTurnUsage = session.getLastTurnUsage();
    const summary: PersistentAgentSummary = {
      agentId: session.id,
      parentSessionId: session.parentSessionId,
      role: session.role,
      mode: (info.mode ?? overrides.mode ?? "collaborative") as AgentMode,
      depth: typeof info.depth === "number" ? info.depth : (overrides.depth ?? 1),
      ...(info.nickname ? { nickname: info.nickname } : {}),
      ...(info.taskType ? { taskType: info.taskType } : {}),
      ...(info.targetPaths !== undefined ? { targetPaths: info.targetPaths } : {}),
      ...(info.profile ? { profile: info.profile } : {}),
      ...(info.requestedModel ? { requestedModel: info.requestedModel } : {}),
      effectiveModel: info.effectiveModel ?? session.getPublicConfig().model,
      ...(info.requestedReasoningEffort
        ? { requestedReasoningEffort: info.requestedReasoningEffort }
        : {}),
      ...(info.effectiveReasoningEffort
        ? { effectiveReasoningEffort: info.effectiveReasoningEffort }
        : {}),
      title: info.title,
      provider: info.provider,
      createdAt: info.createdAt,
      updatedAt: info.updatedAt,
      lifecycleState: session.persistenceStatus === "closed" ? "closed" : "active",
      executionState,
      busy: overrides.busy ?? session.isBusy,
      ...(() => {
        const lastMessagePreview =
          info.lastMessagePreview ?? session.getLatestAssistantText() ?? null;
        return lastMessagePreview ? { lastMessagePreview } : {};
      })(),
      ...(sessionUsage ? { sessionUsage } : {}),
      ...(lastTurnUsage ? { lastTurnUsage } : {}),
    };
    return summary;
  }

  private publish(
    parentSessionId: string,
    session: AgentSession,
    overrides: AgentControlSummaryOverrides = {},
  ): PersistentAgentSummary {
    const summary = this.buildAgentSummary(session, overrides);
    this.statusBus.publish(summary);
    this.deps.emitParentAgentStatus(parentSessionId, summary);
    return summary;
  }

  private buildAgentInspection(session: AgentSession): AgentInspectResult {
    const latestAssistantText = session.getLatestAssistantText() ?? null;
    const reportInspection = inspectChildAgentReport(latestAssistantText);
    return {
      agent: this.buildAgentSummary(session),
      latestAssistantText,
      parsedReport: reportInspection.parsedReport,
      reportRequired: reportInspection.reportRequired,
      reportFound: reportInspection.reportFound,
      reportValid: reportInspection.reportValid,
      reportBlockCount: reportInspection.reportBlockCount,
      reportDiagnostic: reportInspection.reportDiagnostic,
      sessionUsage: session.getCompactUsageSnapshot(),
      lastTurnUsage: session.getLastTurnUsage(),
    };
  }

  private buildWaitInspection(
    session: AgentSession,
    opts: Pick<AgentWaitOptions, "includeFinalMessage" | "includeReport">,
  ): AgentWaitInspection {
    const latestAssistantText = session.getLatestAssistantText() ?? null;
    const inspection: AgentWaitInspection = {
      agentId: session.id,
      ...(opts.includeFinalMessage ? { latestAssistantText } : {}),
    };

    if (opts.includeReport) {
      const reportInspection = inspectChildAgentReport(latestAssistantText);
      inspection.parsedReport = reportInspection.parsedReport;
      inspection.reportRequired = reportInspection.reportRequired;
      inspection.reportFound = reportInspection.reportFound;
      inspection.reportValid = reportInspection.reportValid;
      inspection.reportBlockCount = reportInspection.reportBlockCount;
      inspection.reportDiagnostic = reportInspection.reportDiagnostic;
    }

    return inspection;
  }

  private trackRun(
    parentSessionId: string,
    session: AgentSession,
    message: string,
    displayState: AgentExecutionState,
  ): PersistentAgentSummary {
    const run = session
      .sendUserMessage(message)
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

  /** Count live (non-closed) child sessions of a parent, bounding fork-bombs. */
  private countActiveChildren(parentSessionId: string): number {
    let count = 0;
    for (const binding of this.deps.sessionBindings.values()) {
      const session = binding.session;
      if (!session?.isAgentOf?.(parentSessionId)) continue;
      if (session.persistenceStatus === "closed") continue;
      count += 1;
    }
    return count;
  }

  async spawn(opts: AgentSpawnOptions): Promise<PersistentAgentSummary> {
    const depth = (opts.parentDepth ?? 0) + 1;
    // Reject runaway recursion and fork-bombs before doing any spawn work.
    if (depth > MAX_SPAWN_DEPTH) {
      throw new Error(
        `Child agent depth ${depth} exceeds the maximum spawn depth of ${MAX_SPAWN_DEPTH}; ` +
          "recursive sub-delegation is disabled.",
      );
    }
    // Count registered children PLUS slots reserved by concurrent in-flight
    // spawns, then reserve a slot — all synchronously, so parallel spawn() calls
    // cannot race past the cap before their bindings are registered below.
    const parentId = opts.parentSessionId;
    const reserved = this.inFlightSpawnsByParent.get(parentId) ?? 0;
    const activeChildren = this.countActiveChildren(parentId) + reserved;
    if (activeChildren >= MAX_ACTIVE_CHILDREN_PER_PARENT) {
      throw new Error(
        `Cannot spawn another child agent: this session already has ${activeChildren} active ` +
          `child agents (limit ${MAX_ACTIVE_CHILDREN_PER_PARENT}). Close or wait on existing ` +
          "agents before spawning more.",
      );
    }
    this.inFlightSpawnsByParent.set(parentId, reserved + 1);
    try {
      return await this.spawnReserved(opts, depth);
    } finally {
      const remaining = (this.inFlightSpawnsByParent.get(parentId) ?? 1) - 1;
      if (remaining <= 0) this.inFlightSpawnsByParent.delete(parentId);
      else this.inFlightSpawnsByParent.set(parentId, remaining);
    }
  }

  /** The reservation-protected body of spawn(); see spawn() for the slot guard. */
  private async spawnReserved(
    opts: AgentSpawnOptions,
    depth: number,
  ): Promise<PersistentAgentSummary> {
    const profile = opts.profileRef
      ? await resolveAgentProfileSnapshot(opts.parentConfig, opts.profileRef)
      : undefined;
    const role = profile?.baseRole ?? opts.role ?? "default";
    const roleDefinition = getAgentRoleDefinition(role);
    const resolvedContext = resolveAgentSpawnContextOptions({
      ...opts,
      contextMode: opts.contextMode ?? profile?.defaultContextMode,
    });
    const parentSession = shouldReadParentSeedContext(resolvedContext)
      ? this.deps.sessionBindings.get(opts.parentSessionId)?.session
      : null;
    if (shouldReadParentSeedContext(resolvedContext) && !parentSession) {
      throw new Error(`Unknown parent session: ${opts.parentSessionId}`);
    }
    const seedContext = parentSession
      ? buildSeedContextForSpawn(parentSession, resolvedContext)
      : null;
    const routed = routeAgentConfig(opts.parentConfig, {
      role: roleDefinition,
      ...(opts.model || profile?.model ? { model: opts.model ?? profile?.model } : {}),
      ...(opts.reasoningEffort || profile?.reasoningEffort
        ? { reasoningEffort: opts.reasoningEffort ?? profile?.reasoningEffort }
        : {}),
      connectedProviders: await this.deps.getConnectedProviders(opts.parentConfig),
    });
    if (routed.fallbackLine) {
      this.deps.emitParentLog(opts.parentSessionId, routed.fallbackLine);
    }
    const nickname = normalizeNickname(opts.nickname);
    const taskType =
      opts.taskType === undefined && profile?.defaultTaskType === undefined
        ? undefined
        : agentTaskTypeSchema.parse(opts.taskType ?? profile?.defaultTaskType);
    const targetPaths = normalizeAgentTargetPaths(opts.targetPaths);
    if (targetPaths !== undefined) {
      // Validate child scope here so BOTH the spawnAgent tool and the JSON-RPC
      // agent-spawn path are covered. The stored targetPaths feed the built-in
      // file tools (write/edit/read) AND the OS sandbox, so an empty,
      // out-of-workspace, escaping, or `.git`/`.cowork` scope must be rejected
      // before the child runs. Children inherit the parent workspace.
      if (targetPaths.length === 0) {
        throw new Error(
          "Child agent targetPaths must not be empty; omit it for whole-workspace scope.",
        );
      }
      const invalid = targetPaths.filter(
        (p) =>
          !isUsableTargetPath(
            routed.config.workingDirectory,
            p,
            path.dirname(routed.config.projectCoworkDir),
          ),
      );
      if (invalid.length > 0) {
        throw new Error(
          "Child agent targetPaths must be inside the workspace and outside .git/.cowork; " +
            `invalid: ${invalid.join(", ")}`,
        );
      }
    }
    const childSystem = await this.deps.loadAgentPrompt(routed.config, role, profile);
    const binding: SessionBinding = {
      session: null,
      runtime: null,
      socket: null,
      sinks: new Map(),
    };
    const built = this.deps.buildSession(binding, undefined, {
      config: routed.config,
      system: childSystem,
      ...(seedContext ? { seedContext } : {}),
      sessionInfoPatch: {
        sessionKind: "agent",
        parentSessionId: opts.parentSessionId,
        role,
        mode: roleDefinition.defaultMode,
        depth,
        ...(nickname ? { nickname } : {}),
        ...(taskType ? { taskType } : {}),
        ...(targetPaths !== undefined ? { targetPaths } : {}),
        ...(profile ? { profile } : {}),
        requestedModel: routed.requestedModel ?? null,
        effectiveModel: routed.effectiveModel,
        requestedReasoningEffort: routed.requestedReasoningEffort ?? null,
        effectiveReasoningEffort: routed.effectiveReasoningEffort ?? null,
        executionState: "pending_init",
      },
    });
    binding.session = built.session;
    binding.runtime = built.runtime;
    built.session.beginDisconnectedReplayBuffer();
    this.deps.sessionBindings.set(built.session.id, binding);
    this.publish(opts.parentSessionId, built.session, {
      mode: roleDefinition.defaultMode,
      depth,
      ...(nickname ? { nickname } : {}),
      ...(taskType ? { taskType } : {}),
      ...(targetPaths !== undefined ? { targetPaths } : {}),
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

  async wait(opts: AgentWaitOptions): Promise<AgentWaitResult> {
    for (const agentId of opts.agentIds) {
      const session = this.ensureAgentSession(opts.parentSessionId, agentId);
      this.publish(
        opts.parentSessionId,
        session,
        this.inFlightByAgentId.has(agentId) ? { executionState: "running", busy: true } : {},
      );
    }
    const result = await this.statusBus.wait(opts.agentIds, opts.timeoutMs, opts.mode);
    if (opts.includeFinalMessage !== true && opts.includeReport !== true) {
      return result;
    }

    const inspections = result.agents.map((agent) => {
      const session = this.ensureAgentSession(opts.parentSessionId, agent.agentId);
      return this.buildWaitInspection(session, opts);
    });
    return { ...result, inspections };
  }

  async inspect(opts: AgentInspectOptions): Promise<AgentInspectResult> {
    const session = this.ensureAgentSession(opts.parentSessionId, opts.agentId);
    const result = this.buildAgentInspection(session);
    this.statusBus.publish(result.agent);
    this.deps.emitParentAgentStatus(opts.parentSessionId, result.agent);
    return result;
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
    if (!binding?.session?.isAgentOf(opts.parentSessionId)) {
      throw new Error(`Unknown child agent: ${opts.agentId}`);
    }
    binding.session.cancel();
    await this.inFlightByAgentId.get(opts.agentId);
    await binding.session.closeForHistory({ closeSharedCodexClient: false });
    this.deps.disposeBinding(binding, "parent closed child agent", {
      closeSharedCodexClient: false,
    });
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
        this.deps.emitParentLog(
          parentSessionId,
          `Failed to cancel child agent ${session.id}: ${message}`,
        );
      }
    }
  }
}
