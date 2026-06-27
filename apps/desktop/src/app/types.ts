import type { CoworkRuntimeBootstrapProgress } from "../../../../src/coworkRuntime/types";
import type { ResearchRecord, ResearchSettings } from "../../../../src/server/research/types";
import { DEFAULT_RESEARCH_AGENT_ID } from "../../../../src/server/research/types";
import type { DesktopFeatureFlagOverrides } from "../../../../src/shared/featureFlags";
import type { SessionFeedItem } from "../../../../src/shared/sessionSnapshot";
import type {
  TaskArtifact,
  TaskArtifactDetail,
  TaskArtifactRevision,
  TaskArtifactVersion,
  TaskQuestion,
  TaskQuestionAnswerInput,
  TaskQuestionResumeStatus,
  TaskRecord,
  TaskSummary,
} from "../../../../src/shared/tasks";
import {
  type CloudSyncSettings,
  normalizeCloudSyncSettings,
  type PersistedCloudSyncSettings,
} from "../../../../src/sync/types";
import {
  DEFAULT_PRIVACY_TELEMETRY_SETTINGS,
  normalizePrivacyTelemetrySettings,
  type PersistedPrivacyTelemetrySettings,
  type PrivacyTelemetrySettings,
} from "../../../../src/telemetry/config";
import { normalizeQuickChatShortcutAccelerator } from "../lib/quickChatShortcut";
import type {
  ApprovalRiskCode,
  ChildModelRoutingMode,
  ConfigSubset,
  ImportableItem,
  OpenAiNativeConnector,
  PluginCatalogEntry,
  PluginCatalogSnapshot,
  PluginInstallPreview,
  ProviderName,
  SessionEvent,
  SkillCatalogSnapshot,
  SkillEntry,
  SkillInstallationEntry,
  SkillInstallPreview,
  SkillUpdateCheckResult,
} from "../lib/wsProtocol";
import type { WorkspaceProviderOptions } from "./openaiCompatibleProviderOptions";

export type WorkspaceUserProfile = {
  instructions: string;
  work: string;
  details: string;
};

export function normalizeWorkspaceUserProfile(
  value?: Partial<WorkspaceUserProfile> | null,
): WorkspaceUserProfile {
  return {
    instructions: typeof value?.instructions === "string" ? value.instructions : "",
    work: typeof value?.work === "string" ? value.work : "",
    details: typeof value?.details === "string" ? value.details : "",
  };
}

export type ExplorerEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  isHidden: boolean;
  sizeBytes: number | null;
  modifiedAtMs: number | null;
};

export type WorkspaceExplorerState = {
  rootPath: string | null;
  currentPath: string | null;
  entries: ExplorerEntry[];
  selectedPath: string | null;
  loading: boolean;
  error: string | null;
  requestId: number;
};

export type WorkspaceKind = "project" | "oneOffChat";

export function isOneOffChatWorkspace(
  workspace?: Pick<WorkspaceRecord, "workspaceKind"> | null,
): boolean {
  return workspace?.workspaceKind === "oneOffChat";
}

export type WorkspaceRecord = {
  id: string;
  name: string;
  path: string;
  workspaceKind?: WorkspaceKind;
  createdAt: string;
  lastOpenedAt: string;
  wsProtocol?: "jsonrpc";
  defaultProvider?: ProviderName;
  defaultModel?: string;
  defaultPreferredChildModel?: string;
  defaultChildModelRoutingMode?: ChildModelRoutingMode;
  defaultPreferredChildModelRef?: string;
  defaultAllowedChildModelRefs?: string[];
  defaultToolOutputOverflowChars?: number | null;
  providerOptions?: WorkspaceProviderOptions;
  userName?: string;
  userProfile?: WorkspaceUserProfile;
  defaultEnableMcp: boolean;
  defaultBackupsEnabled: boolean;
  defaultAdvancedMemory?: boolean;
  defaultMemoryGenerationModel?: string;
  yolo: boolean;
};

export type WorkspaceDefaultsPatch = Partial<Omit<WorkspaceRecord, "userProfile">> & {
  clearDefaultToolOutputOverflowChars?: boolean;
  userProfile?: Partial<WorkspaceUserProfile>;
};

export type ThreadStatus = "active" | "disconnected";
export type ThreadBusyPolicy = "reject" | "steer" | "queue";

export type ThreadTitleSource = "default" | "model" | "heuristic" | "manual";

export type ThreadRecord = {
  id: string;
  workspaceId: string;
  title: string;
  titleSource?: ThreadTitleSource;
  createdAt: string;
  lastMessageAt: string;
  status: ThreadStatus;
  sessionId: string | null;
  messageCount: number;
  lastEventSeq: number;
  legacyTranscriptId?: string | null;
  draft?: boolean;
  archived?: boolean;
  archivedAt?: string;
  taskId?: string;
  taskThreadId?: string;
};

export type ThreadPendingSteer = {
  clientMessageId: string;
  text: string;
  attachmentSignature?: string;
  status: "sending" | "accepted";
};

export type ThreadPendingTurnStart = {
  clientMessageId: string;
  text: string;
  attachmentSignature?: string;
  status: "sending";
};

export type PersistedProviderStatus = Extract<
  SessionEvent,
  { type: "provider_status" }
>["providers"][number];

export type PersistedProviderState = {
  statusByName?: Partial<Record<ProviderName, PersistedProviderStatus>>;
  statusLastUpdatedAt?: string | null;
};

type LmStudioUiState = {
  enabled: boolean;
  hiddenModels: string[];
};

export type PersistedProviderUiState = {
  lmstudio: LmStudioUiState;
};

type OnboardingStatus = "pending" | "dismissed" | "completed";

export type PersistedOnboardingState = {
  status: OnboardingStatus;
  completedAt: string | null;
  dismissedAt: string | null;
};

export type PersistedDesktopSettings = {
  quickChat?: {
    iconEnabled?: boolean;
    shortcutEnabled?: boolean;
    shortcutAccelerator?: string;
  };
  archivedChatsAutoDeleteDays?: number;
  sidebarSectionOrder?: SidebarSectionKey[];
};

export type PersistedProductAnalyticsState = {
  anonymousInstallationId?: string;
  lastAppVersion?: string | null;
};

export type {
  CloudSyncSettings,
  PersistedCloudSyncSettings,
  PersistedPrivacyTelemetrySettings,
  PrivacyTelemetrySettings,
};
export {
  DEFAULT_PRIVACY_TELEMETRY_SETTINGS,
  normalizeCloudSyncSettings,
  normalizePrivacyTelemetrySettings,
};

const SAFE_PRODUCT_ANALYTICS_ID = /^[A-Za-z0-9_-]{16,128}$/;

export function normalizePersistedProductAnalyticsState(
  value?: PersistedProductAnalyticsState | null,
): PersistedProductAnalyticsState | undefined {
  const anonymousInstallationId =
    typeof value?.anonymousInstallationId === "string" &&
    SAFE_PRODUCT_ANALYTICS_ID.test(value.anonymousInstallationId.trim())
      ? value.anonymousInstallationId.trim()
      : undefined;
  const lastAppVersion =
    typeof value?.lastAppVersion === "string" && value.lastAppVersion.trim()
      ? value.lastAppVersion.trim()
      : value?.lastAppVersion === null
        ? null
        : undefined;

  if (!anonymousInstallationId && lastAppVersion === undefined) {
    return undefined;
  }

  return {
    ...(anonymousInstallationId ? { anonymousInstallationId } : {}),
    ...(lastAppVersion !== undefined ? { lastAppVersion } : {}),
  };
}

const SIDEBAR_SECTION_KEYS = ["projects", "chats"] as const;

export type SidebarSectionKey = (typeof SIDEBAR_SECTION_KEYS)[number];

export function normalizeSidebarSectionOrder(
  value?: readonly unknown[] | null,
): SidebarSectionKey[] {
  const seen = new Set<SidebarSectionKey>();
  const ordered: SidebarSectionKey[] = [];

  for (const entry of value ?? []) {
    if (entry !== "projects" && entry !== "chats") {
      continue;
    }
    if (seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    ordered.push(entry);
  }

  for (const key of SIDEBAR_SECTION_KEYS) {
    if (!seen.has(key)) {
      ordered.push(key);
    }
  }

  return ordered;
}

export type DesktopSettings = {
  quickChat: {
    iconEnabled: boolean;
    shortcutEnabled: boolean;
    shortcutAccelerator: string;
  };
  archivedChatsAutoDeleteDays: number;
  sidebarSectionOrder: SidebarSectionKey[];
};

export function normalizeDesktopSettings(value?: PersistedDesktopSettings | null): DesktopSettings {
  return {
    quickChat: {
      iconEnabled: value?.quickChat?.iconEnabled !== false,
      shortcutEnabled: value?.quickChat?.shortcutEnabled === true,
      shortcutAccelerator: normalizeQuickChatShortcutAccelerator(
        value?.quickChat?.shortcutAccelerator,
      ),
    },
    archivedChatsAutoDeleteDays:
      typeof value?.archivedChatsAutoDeleteDays === "number"
        ? value.archivedChatsAutoDeleteDays
        : 0,
    sidebarSectionOrder: normalizeSidebarSectionOrder(value?.sidebarSectionOrder),
  };
}

export type OnboardingStep = "welcome" | "workspace" | "provider" | "defaults" | "firstThread";
export type ViewId = "chat" | "task" | "skills" | "research" | "settings";

export type {
  TaskArtifact,
  TaskArtifactDetail,
  TaskArtifactRevision,
  TaskArtifactVersion,
  TaskQuestion,
  TaskQuestionAnswerInput,
  TaskQuestionResumeStatus,
  TaskRecord,
  TaskSummary,
};

type PluginViewMode = "plugins" | "skills";
export type SettingsPageId =
  | "models"
  | "subagents"
  | "toolAccess"
  | "defaults"
  | "profileMemory"
  | "chats"
  | "experiments"
  | "diagnostics"
  | "providers"
  | "openAiNativeConnectors"
  | "privacyTelemetry"
  | "desktop"
  | "usage"
  | "workspaces"
  | "backup"
  | "mcp"
  | "memory"
  | "featureFlags"
  | "updates"
  | "developer"
  | "remoteAccess"
  | "archivedChats";

export type CachedDesktopUiState = {
  selectedWorkspaceId?: string | null;
  pluginManagementWorkspaceId?: string | null;
  pluginManagementMode?: PluginManagementMode;
  selectedThreadId?: string | null;
  selectedTaskId?: string | null;
  view?: ViewId;
  settingsPage?: SettingsPageId;
  lastNonSettingsView?: ViewId;
  sidebarCollapsed?: boolean;
  sidebarWidth?: number;
  contextSidebarCollapsed?: boolean;
  contextSidebarWidth?: number;
  canvasSidebarWidth?: number;
  messageBarHeight?: number;
};

export type DesktopStateCache = {
  version: number;
  persistedState: PersistedState;
  ui: CachedDesktopUiState;
  sessionSnapshots?: Record<string, CachedSessionSnapshot>;
};

export type ResearchSettingsState = ResearchSettings;
export type ResearchCard = ResearchRecord;
export type ResearchDetail = ResearchRecord;

export const DEFAULT_RESEARCH_SETTINGS: ResearchSettingsState = {
  planApproval: false,
  agentId: DEFAULT_RESEARCH_AGENT_ID,
  thinkingSummaries: "auto",
  visualization: "auto",
};

export type PluginManagementMode = "auto" | "global" | "workspace";

export type PersistedState = {
  version: number;
  workspaces: WorkspaceRecord[];
  threads: ThreadRecord[];
  developerMode?: boolean;
  showHiddenFiles?: boolean;
  perWorkspaceSettings?: boolean;
  desktopSettings?: PersistedDesktopSettings;
  privacyTelemetrySettings?: PersistedPrivacyTelemetrySettings;
  cloudSync?: PersistedCloudSyncSettings;
  productAnalytics?: PersistedProductAnalyticsState;
  desktopFeatureFlagOverrides?: DesktopFeatureFlagOverrides;
  providerState?: PersistedProviderState;
  providerUiState?: PersistedProviderUiState;
  onboarding?: PersistedOnboardingState;
};

type TranscriptDirection = "server" | "client";

export type TranscriptEvent = {
  ts: string;
  threadId: string;
  direction: TranscriptDirection;
  payload: unknown;
};

export type ToolFeedState =
  | "input-streaming"
  | "input-available"
  | "approval-requested"
  | "output-available"
  | "output-error"
  | "output-denied";

export type ToolApprovalMetadata = {
  approvalId: string;
  reason?: unknown;
  toolCall?: unknown;
};

export type FeedItem = SessionFeedItem;

export type A2uiChangeKind =
  | "createSurface"
  | "updateComponents"
  | "updateDataModel"
  | "deleteSurface";

/**
 * One captured snapshot of an A2UI surface at a particular revision. The dock
 * keeps these client-side so the user can scrub back through prior revisions.
 */
export type A2uiSurfaceRevision = {
  revision: number;
  ts: string;
  catalogId: string;
  version: "v0.9";
  deleted: boolean;
  theme?: Record<string, unknown>;
  root?: Record<string, unknown>;
  dataModel?: unknown;
  /** Envelope kind that produced this revision, when known. */
  changeKind?: A2uiChangeKind;
  /** Free-form agent-authored explanation that arrived on the tool call. */
  reason?: string;
  /** Tool-call id shared by revisions that came from the same tool call. */
  toolCallId?: string;
};

/** Per-thread state for the floating A2UI dock. */
export type A2uiThreadDock = {
  /** All revisions per surface, oldest → newest. */
  revisionsBySurfaceId: Record<string, A2uiSurfaceRevision[]>;
  /** Which surface the dock is currently showing. Null when no live surface exists. */
  focusedSurfaceId: string | null;
  /** Whether the dock accordion is currently open. */
  expanded: boolean;
  /** Last revision the user saw per surface — drives the unseen-update pulse. */
  lastSeenRevisionBySurfaceId: Record<string, number>;
  /** Active revision per surface (defaults to the latest). */
  activeRevisionBySurfaceId: Record<string, number>;
};

export const MAX_A2UI_REVISIONS_PER_SURFACE = 50;

export function createDefaultA2uiDock(): A2uiThreadDock {
  return {
    revisionsBySurfaceId: {},
    focusedSurfaceId: null,
    expanded: false,
    lastSeenRevisionBySurfaceId: {},
    activeRevisionBySurfaceId: {},
  };
}

type SessionConfigSubset = Extract<SessionEvent, { type: "session_config" }>["config"];
type MCPServersEvent = Extract<SessionEvent, { type: "mcp_servers" }>;
type AgentProfilesCatalogEvent = Extract<SessionEvent, { type: "agent_profiles_catalog" }>;
type MCPServerValidationEvent = Extract<SessionEvent, { type: "mcp_server_validation" }>;
type MCPServerAuthChallengeEvent = Extract<SessionEvent, { type: "mcp_server_auth_challenge" }>;
type MCPServerAuthResultEvent = Extract<SessionEvent, { type: "mcp_server_auth_result" }>;
export type SessionUsageSnapshot = NonNullable<
  Extract<SessionEvent, { type: "session_usage" }>["usage"]
>;
export type TurnUsageSnapshot = Pick<
  Extract<SessionEvent, { type: "turn_usage" }>,
  "turnId" | "usage"
>;
type WorkspaceBackupsEvent = Extract<SessionEvent, { type: "workspace_backups" }>;
export type WorkspaceBackupDeltaEvent = Extract<SessionEvent, { type: "workspace_backup_delta" }>;
export type SessionSnapshot = Extract<SessionEvent, { type: "session_snapshot" }>["snapshot"];
export type SessionSnapshotFingerprint = Pick<
  SessionSnapshot,
  "updatedAt" | "messageCount" | "lastEventSeq"
>;
export type CachedSessionSnapshot = {
  fingerprint: SessionSnapshotFingerprint;
  snapshot: SessionSnapshot;
};
export type WorkspaceBackupEntry = WorkspaceBackupsEvent["backups"][number];
export type ThreadAgentSummary = Extract<SessionEvent, { type: "agent_status" }>["agent"];
type ThreadSessionKind = Extract<SessionEvent, { type: "server_hello" }>["sessionKind"];
type ThreadAgentRole = Extract<SessionEvent, { type: "server_hello" }>["role"];
type ThreadAgentMode = Extract<SessionEvent, { type: "server_hello" }>["mode"];
type ThreadAgentReasoningEffort = Extract<
  SessionEvent,
  { type: "server_hello" }
>["effectiveReasoningEffort"];
type ThreadAgentExecutionState = Extract<SessionEvent, { type: "server_hello" }>["executionState"];

export type MemoryListEntry = {
  id: string;
  scope: "workspace" | "user";
  content: string;
  createdAt: string;
  updatedAt: string;
};

export type AdvancedMemoryEntry = {
  slug: string;
  name: string;
  description: string;
  type: string;
  originSessionId?: string;
  body: string;
  updatedAt: string;
};

export type ImportRuntimeState = {
  items: ImportableItem[];
  homeExists: boolean;
  loading: boolean;
  error: string | null;
};

export type WorkspaceRuntime = {
  serverUrl: string | null;
  starting: boolean;
  startupProgress: CoworkRuntimeBootstrapProgress | null;
  error: string | null;
  controlSessionId: string | null;
  controlConfig: ConfigSubset | null;
  controlSessionConfig: SessionConfigSubset | null;
  controlEnableMcp: boolean | null;
  mcpServers: MCPServersEvent["servers"];
  mcpFiles: MCPServersEvent["files"];
  mcpWarnings: string[];
  mcpValidationByName: Record<string, MCPServerValidationEvent>;
  mcpLastAuthChallenge: MCPServerAuthChallengeEvent | null;
  mcpLastAuthResult: MCPServerAuthResultEvent | null;
  providerCatalog: Extract<SessionEvent, { type: "provider_catalog" }>["all"];
  agentProfilesCatalog: AgentProfilesCatalogEvent["catalog"] | null;
  agentProfilesLoading: boolean;
  agentProfilesError: string | null;
  openAiNativeConnectors: OpenAiNativeConnector[];
  openAiNativeConnectorsLoading: boolean;
  openAiNativeConnectorsError: string | null;
  openAiNativeConnectorsAuthenticated: boolean;
  openAiNativeConnectorsMessage: string | null;
  openAiNativeConnectorsEnabledIds: string[];
  pluginsCatalog: PluginCatalogSnapshot | null;
  selectedPluginId: string | null;
  selectedPluginScope: PluginCatalogEntry["scope"] | null;
  selectedPlugin: PluginCatalogEntry | null;
  selectedPluginPreview: PluginInstallPreview | null;
  pluginsLoading: boolean;
  pluginsError: string | null;
  pluginViewMode: PluginViewMode;
  skills: SkillEntry[];
  skillsCatalog: SkillCatalogSnapshot | null;
  selectedSkillName: string | null;
  selectedSkillContent: string | null;
  selectedSkillInstallationId: string | null;
  selectedSkillInstallation: SkillInstallationEntry | null;
  selectedSkillPreview: SkillInstallPreview | null;
  skillUpdateChecksByInstallationId: Record<string, SkillUpdateCheckResult>;
  skillCatalogLoading: boolean;
  skillCatalogError: string | null;
  skillsMutationBlocked: boolean;
  skillsMutationBlockedReason: string | null;
  skillMutationPendingKeys: Record<string, true>;
  skillMutationError: string | null;
  pluginMutationPendingKeys: Record<string, true>;
  pluginMutationError: string | null;
  importItemsByKey: Record<string, ImportRuntimeState>;
  importPendingKeys: Record<string, true>;
  memories: MemoryListEntry[];
  memoriesLoading: boolean;
  advancedMemories: AdvancedMemoryEntry[];
  advancedMemoryFolders: string[];
  advancedMemoryActiveFolder: string | null;
  advancedMemoriesLoading: boolean;
  workspaceBackupsPath: string | null;
  workspaceBackups: WorkspaceBackupsEvent["backups"];
  workspaceBackupsLoading: boolean;
  workspaceBackupsError: string | null;
  workspaceBackupPendingActionKeys: Record<string, true>;
  workspaceBackupDelta: WorkspaceBackupDeltaEvent | null;
  workspaceBackupDeltaLoading: boolean;
  workspaceBackupDeltaError: string | null;
};

export type ThreadRuntime = {
  wsUrl: string | null;
  connected: boolean;
  sessionId: string | null;
  config: ConfigSubset | null;
  sessionConfig: SessionConfigSubset | null;
  sessionKind: ThreadSessionKind | null;
  parentSessionId: string | null;
  role: ThreadAgentRole | null;
  mode: ThreadAgentMode | null;
  depth: number;
  nickname: string | null;
  requestedModel: string | null;
  effectiveModel: string | null;
  requestedReasoningEffort: ThreadAgentReasoningEffort | null;
  effectiveReasoningEffort: ThreadAgentReasoningEffort | null;
  executionState: ThreadAgentExecutionState | null;
  lastMessagePreview: string | null;
  agents: ThreadAgentSummary[];
  sessionUsage: SessionUsageSnapshot | null;
  lastTurnUsage: TurnUsageSnapshot | null;
  enableMcp: boolean | null;
  busy: boolean;
  busySince: string | null;
  activeTurnId: string | null;
  pendingTurnStart?: ThreadPendingTurnStart | null;
  pendingSteer?: ThreadPendingSteer | null;
  feed: FeedItem[];
  a2uiDock: A2uiThreadDock;
  hydrating?: boolean;
  transcriptOnly: boolean;
  /** Draft-thread composer model (no session yet). Cleared on server_hello. */
  draftComposerProvider?: ProviderName | null;
  draftComposerModel?: string | null;
};

export type HydratedTranscriptSnapshot = {
  feed: FeedItem[];
  agents: ThreadAgentSummary[];
  sessionUsage: SessionUsageSnapshot | null;
  lastTurnUsage: TurnUsageSnapshot | null;
};

export type AskPrompt = {
  requestId: string;
  question: string;
  options?: string[];
};

export type ApprovalPrompt = {
  requestId: string;
  command: string;
  dangerous: boolean;
  reasonCode: ApprovalRiskCode;
};

/**
 * A pending sandbox-denial escalation rendered inline in the chat feed (not the
 * modal): the OS sandbox blocked a command and the agent is asking whether to
 * re-run it with full access. `detail`/`category` come from the harness so the
 * inline card can explain why the command was blocked.
 */
export type SandboxApprovalPrompt = {
  requestId: string;
  command: string;
  receivedSequence?: number;
  detail?: string;
  category?: "filesystem" | "network";
};

export type PromptModalState =
  | { kind: "ask"; threadId: string; prompt: AskPrompt }
  | { kind: "approval"; threadId: string; prompt: ApprovalPrompt }
  | null;

export type Notification = {
  id: string;
  ts: string;
  kind: "info" | "error";
  title: string;
  detail?: string;
};
