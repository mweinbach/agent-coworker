import type { runTurn } from "../../agent";
import type { connectProvider as connectModelProvider } from "../../connect";
import { getKnownResolvedModelMetadata, isRuntimeDiscoveryProvider } from "../../models/metadata";
import { defaultSupportedModel } from "../../models/registry";
import type { getProviderStatuses } from "../../providerStatus";
import type { getProviderCatalog } from "../../providers/connectionCatalog";
import type { HarnessContextStore } from "../../sessionContext/HarnessContextStore";
import type { SessionSnapshot } from "../../shared/sessionSnapshot";
import type { getAiCoworkerPaths } from "../../store/connections";
import type { AgentConfig } from "../../types";
import { resolveAuthHomeDir } from "../../utils/authHome";
import type { SessionEvent } from "../protocol";
import type { PersistedSessionRecord, SessionDb } from "../sessionDb";
import type { writePersistedSessionSnapshot } from "../sessionStore";
import type { generateSessionTitle } from "../sessionTitleService";
import { AgentSession } from "./AgentSession";
import type {
  HydratedSessionState,
  PersistedModelSelection,
  PersistedProjectConfigPatch,
  SessionBackupFactory,
  SessionDependencies,
  SessionInfoState,
} from "./SessionContext";

export type AgentSessionFromPersistedOptions = {
  persisted: PersistedSessionRecord;
  baseConfig: AgentConfig;
  discoveredSkills?: Array<{ name: string; description: string }>;
  yolo?: boolean;
  emit: (evt: SessionEvent) => void;
  connectProviderImpl?: typeof connectModelProvider;
  getAiCoworkerPathsImpl?: typeof getAiCoworkerPaths;
  getProviderCatalogImpl?: typeof getProviderCatalog;
  getProviderStatusesImpl?: typeof getProviderStatuses;
  sessionBackupFactory?: SessionBackupFactory;
  harnessContextStore?: HarnessContextStore;
  runTurnImpl?: typeof runTurn;
  emitObservabilityEventImpl?: SessionDependencies["emitObservabilityEventImpl"];
  persistModelSelectionImpl?: (selection: PersistedModelSelection) => Promise<void> | void;
  persistProjectConfigPatchImpl?: (patch: PersistedProjectConfigPatch) => Promise<void> | void;
  generateSessionTitleImpl?: typeof generateSessionTitle;
  sessionDb?: SessionDb | null;
  writePersistedSessionSnapshotImpl?: typeof writePersistedSessionSnapshot;
  createAgentSessionImpl?: SessionDependencies["createAgentSessionImpl"];
  listAgentSessionsImpl?: SessionDependencies["listAgentSessionsImpl"];
  sendAgentInputImpl?: SessionDependencies["sendAgentInputImpl"];
  waitForAgentImpl?: SessionDependencies["waitForAgentImpl"];
  inspectAgentImpl?: SessionDependencies["inspectAgentImpl"];
  resumeAgentImpl?: SessionDependencies["resumeAgentImpl"];
  closeAgentImpl?: SessionDependencies["closeAgentImpl"];
  cancelAgentSessionsImpl?: SessionDependencies["cancelAgentSessionsImpl"];
  deleteSessionImpl?: SessionDependencies["deleteSessionImpl"];
  listWorkspaceBackupsImpl?: SessionDependencies["listWorkspaceBackupsImpl"];
  createWorkspaceBackupCheckpointImpl?: SessionDependencies["createWorkspaceBackupCheckpointImpl"];
  restoreWorkspaceBackupImpl?: SessionDependencies["restoreWorkspaceBackupImpl"];
  deleteWorkspaceBackupCheckpointImpl?: SessionDependencies["deleteWorkspaceBackupCheckpointImpl"];
  deleteWorkspaceBackupEntryImpl?: SessionDependencies["deleteWorkspaceBackupEntryImpl"];
  getWorkspaceBackupDeltaImpl?: SessionDependencies["getWorkspaceBackupDeltaImpl"];
  getTaskContextImpl?: SessionDependencies["getTaskContextImpl"];
  getTaskReviewMaterialImpl?: SessionDependencies["getTaskReviewMaterialImpl"];
  applyTaskDirectiveImpl?: SessionDependencies["applyTaskDirectiveImpl"];
  createTaskImpl?: SessionDependencies["createTaskImpl"];
  readSkillCatalogMtimeSnapshotImpl?: SessionDependencies["readSkillCatalogMtimeSnapshotImpl"];
  initialSessionSnapshot?: SessionSnapshot | null;
};

export function createAgentSessionFromPersisted(
  opts: AgentSessionFromPersistedOptions,
): AgentSession {
  const { persisted } = opts;
  // A root system prompt is derived from the current app version, workspace
  // configuration, and discovered skill/plugin catalog. Do not reuse the
  // persisted copy after a restart: files or prompt templates may have changed
  // while the session was closed. An empty prompt makes AgentSession rebuild it
  // before the next turn. Agent sessions keep their persisted role-specific
  // prompt because loadSystemPromptWithSkills only builds the root prompt.
  const regenerateRootSystemPrompt = persisted.sessionKind === "root";
  // Resolve against the session's auth home (not the process home) so custom
  // model IDs configured under a non-default homedir survive resume.
  const resolvedPersistedModel = getKnownResolvedModelMetadata(
    persisted.provider,
    persisted.model,
    {
      home: resolveAuthHomeDir(opts.baseConfig),
    },
  );
  const resumedModel = resolvedPersistedModel ?? defaultSupportedModel(persisted.provider);
  const migratedUnsupportedModel =
    resolvedPersistedModel === null && !isRuntimeDiscoveryProvider(persisted.provider);
  const migratedAliasedModel =
    resolvedPersistedModel !== null &&
    resolvedPersistedModel.id !== persisted.model &&
    !isRuntimeDiscoveryProvider(persisted.provider);
  const migratedLegacyModel = migratedUnsupportedModel || migratedAliasedModel;
  const clearedContinuationState = migratedLegacyModel && persisted.providerState !== null;
  const config: AgentConfig = {
    ...opts.baseConfig,
    provider: persisted.provider,
    model: resumedModel.id,
    workingDirectory: persisted.workingDirectory,
    enableMcp: persisted.enableMcp,
    outputDirectory: persisted.outputDirectory,
    uploadsDirectory: persisted.uploadsDirectory,
    ...(persisted.providerOptions !== undefined
      ? { providerOptions: structuredClone(persisted.providerOptions) }
      : {}),
    ...(persisted.sandbox !== undefined ? { sandbox: structuredClone(persisted.sandbox) } : {}),
  };

  const sessionInfo: SessionInfoState = {
    title: persisted.title,
    titleSource: persisted.titleSource,
    titleModel: persisted.titleModel,
    createdAt: persisted.createdAt,
    updatedAt: persisted.updatedAt,
    provider: persisted.provider,
    model: resumedModel.id,
    sessionKind: persisted.sessionKind,
    ...(persisted.parentSessionId ? { parentSessionId: persisted.parentSessionId } : {}),
    ...(persisted.role ? { role: persisted.role } : {}),
    ...(persisted.mode ? { mode: persisted.mode } : {}),
    ...(typeof persisted.depth === "number" ? { depth: persisted.depth } : {}),
    ...(persisted.nickname ? { nickname: persisted.nickname } : {}),
    ...(persisted.taskType ? { taskType: persisted.taskType } : {}),
    ...(persisted.targetPaths !== undefined && persisted.targetPaths !== null
      ? { targetPaths: persisted.targetPaths }
      : {}),
    ...(persisted.profile ? { profile: persisted.profile } : {}),
    ...(persisted.requestedModel ? { requestedModel: persisted.requestedModel } : {}),
    ...(persisted.effectiveModel ? { effectiveModel: persisted.effectiveModel } : {}),
    ...(persisted.requestedReasoningEffort
      ? { requestedReasoningEffort: persisted.requestedReasoningEffort }
      : {}),
    ...(persisted.effectiveReasoningEffort
      ? { effectiveReasoningEffort: persisted.effectiveReasoningEffort }
      : {}),
    ...(persisted.executionState ? { executionState: persisted.executionState } : {}),
    ...(persisted.lastMessagePreview ? { lastMessagePreview: persisted.lastMessagePreview } : {}),
  };

  const hydratedState: HydratedSessionState = {
    sessionId: persisted.sessionId,
    sessionInfo,
    status: persisted.status,
    hasGeneratedTitle: persisted.titleSource !== "default" || persisted.messageCount > 0,
    messages: persisted.messages,
    lastMemoryGeneratedIndex: persisted.lastMemoryGeneratedIndex,
    providerState: migratedLegacyModel ? null : persisted.providerState,
    todos: persisted.todos,
    harnessContext: persisted.harnessContext,
    backupsEnabledOverride: persisted.backupsEnabledOverride,
    costTracker: persisted.costTracker,
  };

  const session = new AgentSession({
    config,
    system: regenerateRootSystemPrompt ? "" : persisted.systemPrompt,
    discoveredSkills: regenerateRootSystemPrompt ? undefined : opts.discoveredSkills,
    yolo: opts.yolo,
    emit: opts.emit,
    connectProviderImpl: opts.connectProviderImpl,
    getAiCoworkerPathsImpl: opts.getAiCoworkerPathsImpl,
    getProviderCatalogImpl: opts.getProviderCatalogImpl,
    getProviderStatusesImpl: opts.getProviderStatusesImpl,
    sessionBackupFactory: opts.sessionBackupFactory,
    harnessContextStore: opts.harnessContextStore,
    runTurnImpl: opts.runTurnImpl,
    emitObservabilityEventImpl: opts.emitObservabilityEventImpl,
    persistModelSelectionImpl: opts.persistModelSelectionImpl,
    persistProjectConfigPatchImpl: opts.persistProjectConfigPatchImpl,
    generateSessionTitleImpl: opts.generateSessionTitleImpl,
    sessionDb: opts.sessionDb,
    writePersistedSessionSnapshotImpl: opts.writePersistedSessionSnapshotImpl,
    createAgentSessionImpl: opts.createAgentSessionImpl,
    listAgentSessionsImpl: opts.listAgentSessionsImpl,
    sendAgentInputImpl: opts.sendAgentInputImpl,
    waitForAgentImpl: opts.waitForAgentImpl,
    inspectAgentImpl: opts.inspectAgentImpl,
    resumeAgentImpl: opts.resumeAgentImpl,
    closeAgentImpl: opts.closeAgentImpl,
    cancelAgentSessionsImpl: opts.cancelAgentSessionsImpl,
    deleteSessionImpl: opts.deleteSessionImpl,
    listWorkspaceBackupsImpl: opts.listWorkspaceBackupsImpl,
    createWorkspaceBackupCheckpointImpl: opts.createWorkspaceBackupCheckpointImpl,
    restoreWorkspaceBackupImpl: opts.restoreWorkspaceBackupImpl,
    deleteWorkspaceBackupCheckpointImpl: opts.deleteWorkspaceBackupCheckpointImpl,
    deleteWorkspaceBackupEntryImpl: opts.deleteWorkspaceBackupEntryImpl,
    getWorkspaceBackupDeltaImpl: opts.getWorkspaceBackupDeltaImpl,
    getTaskContextImpl: opts.getTaskContextImpl,
    getTaskReviewMaterialImpl: opts.getTaskReviewMaterialImpl,
    applyTaskDirectiveImpl: opts.applyTaskDirectiveImpl,
    createTaskImpl: opts.createTaskImpl,
    readSkillCatalogMtimeSnapshotImpl: opts.readSkillCatalogMtimeSnapshotImpl,
    ...(opts.initialSessionSnapshot ? { initialSessionSnapshot: opts.initialSessionSnapshot } : {}),
    initialLastEventSeq: persisted.lastEventSeq,
    hydratedState,
    skipInitialPersist: !migratedLegacyModel,
  });

  if (migratedLegacyModel) {
    const migrationDescriptor = migratedUnsupportedModel
      ? "unsupported model"
      : "legacy model alias";
    opts.emit({
      type: "log",
      sessionId: persisted.sessionId,
      line: `[session] Resumed legacy session using ${migrationDescriptor} "${persisted.model}" for provider ${persisted.provider}; migrated to "${resumedModel.id}".${clearedContinuationState ? " Cleared saved continuation state for the old model." : ""}`,
    });
  }

  return session;
}
