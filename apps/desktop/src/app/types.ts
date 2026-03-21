import type {
  ApprovalRiskCode,
  ChildModelRoutingMode,
  ConfigSubset,
  ProviderName,
  ServerErrorCode,
  ServerErrorSource,
  SkillCatalogSnapshot,
  ServerEvent,
  SkillEntry,
  SkillInstallPreview,
  SkillInstallationEntry,
  SkillUpdateCheckResult,
  TodoItem,
} from "../lib/wsProtocol";
import type { SessionFeedItem } from "../../../../src/shared/sessionSnapshot";
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

export type WorkspaceRecord = {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  lastOpenedAt: string;
  wsProtocol?: "legacy" | "jsonrpc";
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
};

export type ThreadPendingSteer = {
  clientMessageId: string;
  text: string;
  status: "sending" | "accepted";
};

export type PersistedProviderStatus = Extract<ServerEvent, { type: "provider_status" }>["providers"][number];

export type PersistedProviderState = {
  statusByName?: Partial<Record<ProviderName, PersistedProviderStatus>>;
  statusLastUpdatedAt?: string | null;
};

export type LmStudioUiState = {
  enabled: boolean;
  hiddenModels: string[];
};

export type PersistedProviderUiState = {
  lmstudio: LmStudioUiState;
};

export type OnboardingStatus = "pending" | "dismissed" | "completed";

export type PersistedOnboardingState = {
  status: OnboardingStatus;
  completedAt: string | null;
  dismissedAt: string | null;
};

export type OnboardingStep = "welcome" | "workspace" | "provider" | "defaults" | "firstThread";
export type ViewId = "chat" | "skills" | "settings";
export type SettingsPageId = "providers" | "usage" | "workspaces" | "backup" | "mcp" | "memory" | "updates" | "developer";

export type CachedDesktopUiState = {
  selectedWorkspaceId?: string | null;
  selectedThreadId?: string | null;
  view?: ViewId;
  settingsPage?: SettingsPageId;
  lastNonSettingsView?: ViewId;
  sidebarCollapsed?: boolean;
  sidebarWidth?: number;
  contextSidebarCollapsed?: boolean;
  contextSidebarWidth?: number;
  messageBarHeight?: number;
};

export type DesktopStateCache = {
  version: number;
  persistedState: PersistedState;
  ui: CachedDesktopUiState;
  sessionSnapshots?: Record<string, CachedSessionSnapshot>;
};

export type PersistedState = {
  version: number;
  workspaces: WorkspaceRecord[];
  threads: ThreadRecord[];
  developerMode?: boolean;
  showHiddenFiles?: boolean;
  perWorkspaceSettings?: boolean;
  providerState?: PersistedProviderState;
  providerUiState?: PersistedProviderUiState;
  onboarding?: PersistedOnboardingState;
};

export type TranscriptDirection = "server" | "client";

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

export type SessionConfigSubset = Extract<ServerEvent, { type: "session_config" }>["config"];
export type MCPServersEvent = Extract<ServerEvent, { type: "mcp_servers" }>;
export type MCPServerValidationEvent = Extract<ServerEvent, { type: "mcp_server_validation" }>;
export type MCPServerAuthChallengeEvent = Extract<ServerEvent, { type: "mcp_server_auth_challenge" }>;
export type MCPServerAuthResultEvent = Extract<ServerEvent, { type: "mcp_server_auth_result" }>;
export type SessionUsageSnapshot = NonNullable<Extract<ServerEvent, { type: "session_usage" }>["usage"]>;
export type TurnUsageSnapshot = Pick<Extract<ServerEvent, { type: "turn_usage" }>, "turnId" | "usage">;
export type WorkspaceBackupsEvent = Extract<ServerEvent, { type: "workspace_backups" }>;
export type WorkspaceBackupDeltaEvent = Extract<ServerEvent, { type: "workspace_backup_delta" }>;
export type SessionSnapshot = Extract<ServerEvent, { type: "session_snapshot" }>["snapshot"];
export type SessionSnapshotFingerprint = Pick<SessionSnapshot, "updatedAt" | "messageCount" | "lastEventSeq">;
export type CachedSessionSnapshot = {
  fingerprint: SessionSnapshotFingerprint;
  snapshot: SessionSnapshot;
};
export type WorkspaceBackupEntry = WorkspaceBackupsEvent["backups"][number];
export type ThreadAgentSummary = Extract<ServerEvent, { type: "agent_status" }>["agent"];
export type ThreadSessionKind = Extract<ServerEvent, { type: "server_hello" }>["sessionKind"];
export type ThreadAgentRole = Extract<ServerEvent, { type: "server_hello" }>["role"];
export type ThreadAgentMode = Extract<ServerEvent, { type: "server_hello" }>["mode"];
export type ThreadAgentReasoningEffort = Extract<ServerEvent, { type: "server_hello" }>["effectiveReasoningEffort"];
export type ThreadAgentExecutionState = Extract<ServerEvent, { type: "server_hello" }>["executionState"];

export type MemoryListEntry = {
  id: string;
  scope: "workspace" | "user";
  content: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceRuntime = {
  serverUrl: string | null;
  starting: boolean;
  error: string | null;
  controlSessionId: string | null;
  controlConfig: ConfigSubset | null;
  controlSessionConfig: SessionConfigSubset | null;
  controlEnableMcp: boolean | null;
  mcpServers: MCPServersEvent["servers"];
  mcpLegacy: MCPServersEvent["legacy"] | null;
  mcpFiles: MCPServersEvent["files"];
  mcpWarnings: string[];
  mcpValidationByName: Record<string, MCPServerValidationEvent>;
  mcpLastAuthChallenge: MCPServerAuthChallengeEvent | null;
  mcpLastAuthResult: MCPServerAuthResultEvent | null;
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
  memories: MemoryListEntry[];
  memoriesLoading: boolean;
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
  pendingSteer?: ThreadPendingSteer | null;
  feed: FeedItem[];
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

export type ConnectDraft = {
  provider: ProviderName;
  apiKey: string;
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
