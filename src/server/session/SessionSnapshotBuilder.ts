import type { AgentExecutionState } from "../../shared/agents";
import type { HarnessContextStore } from "../../harness/contextStore";
import type { PersistedSessionMutation } from "../sessionDb";
import type { PersistedSessionSnapshot } from "../sessionStore";
import type { SessionRuntimeState } from "./SessionContext";

export class SessionSnapshotBuilder {
  constructor(
    private readonly opts: {
      sessionId: string;
      state: SessionRuntimeState;
      harnessContextStore: HarnessContextStore;
      getEnableMcp: () => boolean;
      hasPendingAsk: () => boolean;
      hasPendingApproval: () => boolean;
    }
  ) {}

  private resolvePersistedExecutionState(): AgentExecutionState | null {
    if ((this.opts.state.sessionInfo.sessionKind ?? "root") !== "agent") {
      return this.opts.state.sessionInfo.executionState ?? null;
    }
    if (this.opts.state.persistenceStatus === "closed") return "closed";
    if (this.opts.state.running) return "running";
    if (this.opts.state.currentTurnOutcome === "error") return "errored";
    return "completed";
  }

  buildPersistedSnapshotAt(updatedAt: string): PersistedSessionSnapshot {
    const executionState = this.resolvePersistedExecutionState();
    return {
      version: 7,
      sessionId: this.opts.sessionId,
      createdAt: this.opts.state.sessionInfo.createdAt,
      updatedAt,
      session: {
        title: this.opts.state.sessionInfo.title,
        titleSource: this.opts.state.sessionInfo.titleSource,
        titleModel: this.opts.state.sessionInfo.titleModel,
        provider: this.opts.state.sessionInfo.provider,
        model: this.opts.state.sessionInfo.model,
        sessionKind: this.opts.state.sessionInfo.sessionKind ?? "root",
        parentSessionId: this.opts.state.sessionInfo.parentSessionId ?? null,
        role: this.opts.state.sessionInfo.role ?? null,
        mode: this.opts.state.sessionInfo.mode ?? null,
        depth: this.opts.state.sessionInfo.depth ?? null,
        nickname: this.opts.state.sessionInfo.nickname ?? null,
        requestedModel: this.opts.state.sessionInfo.requestedModel ?? null,
        effectiveModel: this.opts.state.sessionInfo.effectiveModel ?? null,
        requestedReasoningEffort: this.opts.state.sessionInfo.requestedReasoningEffort ?? null,
        effectiveReasoningEffort: this.opts.state.sessionInfo.effectiveReasoningEffort ?? null,
        executionState,
        lastMessagePreview: this.opts.state.sessionInfo.lastMessagePreview ?? null,
      },
      config: {
        provider: this.opts.state.config.provider,
        model: this.opts.state.config.model,
        enableMcp: this.opts.getEnableMcp(),
        backupsEnabledOverride: this.opts.state.backupsEnabledOverride,
        workingDirectory: this.opts.state.config.workingDirectory,
        ...(this.opts.state.config.outputDirectory ? { outputDirectory: this.opts.state.config.outputDirectory } : {}),
        ...(this.opts.state.config.uploadsDirectory ? { uploadsDirectory: this.opts.state.config.uploadsDirectory } : {}),
        ...(this.opts.state.config.providerOptions !== undefined
          ? { providerOptions: structuredClone(this.opts.state.config.providerOptions) }
          : {}),
      },
      context: {
        system: this.opts.state.system,
        messages: this.opts.state.allMessages,
        providerState: this.opts.state.providerState,
        todos: this.opts.state.todos,
        harnessContext: this.opts.harnessContextStore.get(this.opts.sessionId),
        costTracker: this.opts.state.costTracker?.getSnapshot() ?? null,
      },
    };
  }

  buildCanonicalSnapshot(updatedAt: string): PersistedSessionMutation["snapshot"] {
    const executionState = this.resolvePersistedExecutionState();
    return {
      sessionKind: this.opts.state.sessionInfo.sessionKind ?? "root",
      parentSessionId: this.opts.state.sessionInfo.parentSessionId ?? null,
      role: this.opts.state.sessionInfo.role ?? null,
      mode: this.opts.state.sessionInfo.mode ?? null,
      depth: this.opts.state.sessionInfo.depth ?? null,
      nickname: this.opts.state.sessionInfo.nickname ?? null,
      requestedModel: this.opts.state.sessionInfo.requestedModel ?? null,
      effectiveModel: this.opts.state.sessionInfo.effectiveModel ?? null,
      requestedReasoningEffort: this.opts.state.sessionInfo.requestedReasoningEffort ?? null,
      effectiveReasoningEffort: this.opts.state.sessionInfo.effectiveReasoningEffort ?? null,
      executionState,
      lastMessagePreview: this.opts.state.sessionInfo.lastMessagePreview ?? null,
      title: this.opts.state.sessionInfo.title,
      titleSource: this.opts.state.sessionInfo.titleSource,
      titleModel: this.opts.state.sessionInfo.titleModel,
      provider: this.opts.state.config.provider,
      model: this.opts.state.config.model,
      workingDirectory: this.opts.state.config.workingDirectory,
      ...(this.opts.state.config.outputDirectory ? { outputDirectory: this.opts.state.config.outputDirectory } : {}),
      ...(this.opts.state.config.uploadsDirectory ? { uploadsDirectory: this.opts.state.config.uploadsDirectory } : {}),
      ...(this.opts.state.config.providerOptions !== undefined
        ? { providerOptions: structuredClone(this.opts.state.config.providerOptions) }
        : {}),
      enableMcp: this.opts.getEnableMcp(),
      backupsEnabledOverride: this.opts.state.backupsEnabledOverride,
      createdAt: this.opts.state.sessionInfo.createdAt,
      updatedAt,
      status: this.opts.state.persistenceStatus,
      hasPendingAsk: this.opts.hasPendingAsk(),
      hasPendingApproval: this.opts.hasPendingApproval(),
      systemPrompt: this.opts.state.system,
      messages: this.opts.state.allMessages,
      providerState: this.opts.state.providerState,
      todos: this.opts.state.todos,
      harnessContext: this.opts.harnessContextStore.get(this.opts.sessionId),
      costTracker: this.opts.state.costTracker?.getSnapshot() ?? null,
    };
  }
}
