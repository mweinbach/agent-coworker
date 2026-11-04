import type { SupportedModel } from "../models/registry";
import type { AgentConfig, ProviderName, SkillScope } from "../types";
import type { CatalogReasoningEffort } from "./openaiCompatibleOptions";

type ProviderStatusMode =
  | "missing"
  | "error"
  | "api_key"
  | "oauth"
  | "oauth_pending"
  | "local"
  | "credentials";

type ProviderAccount = {
  email?: string;
  name?: string;
};

type ProviderRateLimitWindow = {
  usedPercent: number;
  windowSeconds: number;
  resetAfterSeconds?: number;
  resetAt?: string;
};

type ProviderCredits = {
  hasCredits: boolean;
  unlimited: boolean;
  balance?: string;
};

type ProviderRateLimitSnapshot = {
  limitId?: string;
  limitName?: string;
  allowed?: boolean;
  limitReached?: boolean;
  primaryWindow?: ProviderRateLimitWindow | null;
  secondaryWindow?: ProviderRateLimitWindow | null;
  credits?: ProviderCredits | null;
};

type ProviderUsageStatus = {
  accountId?: string;
  email?: string;
  planType?: string;
  rateLimits: ProviderRateLimitSnapshot[];
};

export type ProviderStatus = {
  provider: ProviderName;
  authorized: boolean;
  verified: boolean;
  mode: ProviderStatusMode;
  account: ProviderAccount | null;
  message: string;
  checkedAt: string;
  methodId?: string;
  savedApiKeyMasks?: Partial<Record<string, string>>;
  savedFieldMasks?: Partial<Record<string, string>>;
  usage?: ProviderUsageStatus;
  tokenRecoverable?: boolean;
};

export type ProviderAuthChallenge = {
  method: "auto" | "code";
  instructions: string;
  url?: string;
  command?: string;
};

type ProviderCatalogModelEntry = Pick<
  SupportedModel,
  "id" | "displayName" | "knowledgeCutoff" | "supportsImageInput"
> & {
  model?: string;
  description?: string;
  reasoning?: {
    defaultEffort: CatalogReasoningEffort;
    availableEfforts: CatalogReasoningEffort[];
  };
  runtimeOptions?: Record<string, unknown>;
  runtimeOverrides?: Record<string, unknown>;
  enabled?: boolean;
};

export type ProviderCatalogEntry = {
  id: ProviderName;
  name: string;
  models: ProviderCatalogModelEntry[];
  defaultModel: string;
  state?: "ready" | "empty" | "unreachable";
  message?: string;
};

export type MarketplaceListEntry = {
  id: string;
  repo: string;
  ref: string;
  url: string;
  marketplacePath: string;
  builtIn: boolean;
  displayName?: string;
  pluginCount?: number;
  skillCount?: number;
  fetchError?: string;
  addedAt?: string;
};

type MarketplaceDetailPluginEntry = {
  name: string;
  displayName: string;
  category?: string;
  icon?: string;
  installed: boolean;
  enabled?: boolean;
  installSource?: string;
  skills: string[];
  mcpServers: string[];
};

type MarketplaceDetailSkillEntry = {
  name: string;
  displayName: string;
  category?: string;
  icon?: string;
  installed: boolean;
  enabled?: boolean;
  installSource?: string;
};

type MarketplaceDetailConnectorEntry = {
  name: string;
  pluginName: string;
  pluginDisplayName: string;
  installed: boolean;
};

export type MarketplaceDetail = {
  source: MarketplaceListEntry;
  plugins: MarketplaceDetailPluginEntry[];
  skills: MarketplaceDetailSkillEntry[];
  connectors: MarketplaceDetailConnectorEntry[];
};

type SkillImprovementRunHistoryEntry = {
  id: string;
  skillName: string;
  status: "completed" | "failed" | "skipped";
  startedAt: string;
  finishedAt: string;
  message: string;
  usageCount: number;
  error?: string;
};

type SkillImprovementBackupRecord = {
  key: string;
  skillName: string;
  sourceRootDir: string;
  backupRootDir: string;
  createdAt: string;
  restoreMode: "copy-back" | "delete-shadow";
  shadowRootDir?: string;
};

type SkillImprovementEligibility = {
  skillName: string;
  installationId: string;
  scope: SkillScope;
  enabled: boolean;
  effective: boolean;
  eligible: boolean;
  included: boolean;
  excluded: boolean;
  writable: boolean;
  sourceKind: "user" | "marketplace" | "plugin" | "built-in" | "invalid";
  reason?: string;
  rootDir: string;
  skillPath: string;
  hasBackup: boolean;
  pluginName?: string;
};

type SkillImprovementPendingJobSummary = {
  key: string;
  skillName: string;
  runAt: string;
  lastUsageAt: string;
  usageCount: number;
  status: "pending" | "running";
  sources: Array<"skill-tool" | "at-mention">;
  kinds: Array<"tool" | "reference">;
};

export type SkillImprovementStatusEvent = {
  type: "skill_improvement_status";
  sessionId: string;
  enabled: boolean;
  model?: string;
  scope: "user" | "all";
  excludedSkills: string[];
  busy: boolean;
  blockReason: string | null;
  pendingJobs: SkillImprovementPendingJobSummary[];
  runHistory: SkillImprovementRunHistoryEntry[];
  backups: SkillImprovementBackupRecord[];
  skills: SkillImprovementEligibility[];
};

export type AgentWaitMode = "any" | "all";

type SessionBackupCheckpointTrigger = "initial" | "auto" | "manual";

type SessionBackupPublicCheckpoint = {
  id: string;
  index: number;
  createdAt: string;
  trigger: SessionBackupCheckpointTrigger;
  changed: boolean;
  patchBytes: number;
};

export type SessionBackupPublicState = {
  status: "initializing" | "ready" | "disabled" | "failed";
  sessionId: string;
  workingDirectory: string;
  backupDirectory: string | null;
  createdAt: string;
  originalSnapshot: { kind: "pending" | "directory" | "tar_gz" };
  checkpoints: SessionBackupPublicCheckpoint[];
  failureReason?: string;
};

type WorkspaceBackupLifecycle = "active" | "closed" | "deleted";

export type WorkspaceBackupPublicEntry = {
  targetSessionId: string;
  title?: string | null;
  provider?: string | null;
  model?: string | null;
  lifecycle: WorkspaceBackupLifecycle;
  status: SessionBackupPublicState["status"];
  workingDirectory: string;
  backupDirectory: string | null;
  originalSnapshotKind: SessionBackupPublicState["originalSnapshot"]["kind"];
  originalSnapshotBytes: number | null;
  checkpointBytesTotal: number | null;
  totalBytes: number | null;
  checkpoints: SessionBackupPublicCheckpoint[];
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  failureReason?: string;
};

type WorkspaceBackupDeltaFile = {
  path: string;
  change: "added" | "modified" | "deleted";
  kind: "file" | "directory" | "symlink";
};

export type WorkspaceBackupDeltaPreview = {
  targetSessionId: string;
  checkpointId: string;
  baselineLabel: string;
  currentLabel: string;
  counts: {
    added: number;
    modified: number;
    deleted: number;
  };
  files: WorkspaceBackupDeltaFile[];
  truncated: boolean;
};

export type PersistedSessionSummary = {
  sessionId: string;
  title: string;
  titleSource: "default" | "model" | "heuristic" | "manual";
  titleModel: string | null;
  provider: AgentConfig["provider"];
  model: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastEventSeq: number;
  hasPendingAsk: boolean;
  hasPendingApproval: boolean;
};
