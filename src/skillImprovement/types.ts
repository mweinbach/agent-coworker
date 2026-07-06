import type { SkillScope } from "../types";

export const SKILL_IMPROVEMENT_DEBOUNCE_MS = 10 * 60 * 1000;
export const SKILL_IMPROVEMENT_SCHEDULER_INTERVAL_MS = 60 * 1000;
/** A claimed job whose run is older than this is treated as crashed and reclaimed. */
export const SKILL_IMPROVEMENT_STALE_RUNNING_MS = 30 * 60 * 1000;
/** A cross-process lock older than this is treated as abandoned and broken. */
export const SKILL_IMPROVEMENT_STALE_LOCK_MS = 30 * 60 * 1000;
/** Per-job caps so state.json cannot grow without bound between runs. */
export const SKILL_IMPROVEMENT_MAX_TRANSCRIPTS_PER_JOB = 10;
export const SKILL_IMPROVEMENT_MAX_USAGES_PER_JOB = 50;

type SkillImprovementScope = "user" | "all";

type SkillUsageKind = "tool" | "reference";

export type SkillUsageRecord = {
  skillName: string;
  kind: SkillUsageKind;
  source: "skill-tool" | "at-mention";
  turnId: string;
  usedAt: string;
  skillPath?: string;
  skillSource?: SkillScope;
};

export type CompletedTurnSkillUsage = {
  sessionId: string;
  turnId: string;
  workingDirectory: string;
  messageStartIndex: number;
  messageEndIndex: number;
  transcript: string;
  usages: SkillUsageRecord[];
};

type SkillImprovementUsageEvent = SkillUsageRecord & {
  sessionId: string;
  workingDirectory: string;
};

/** One serialized turn transcript, stored once per (session, turn) instead of per usage. */
type SkillImprovementTranscriptRecord = {
  sessionId: string;
  turnId: string;
  workingDirectory: string;
  messageStartIndex: number;
  messageEndIndex: number;
  transcript: string;
};

export type SkillImprovementJob = {
  skillName: string;
  /**
   * Set for project-scope skills, which only exist inside one workspace. The
   * runner resolves the skill catalog against this directory; global/user/
   * built-in skills resolve identically everywhere and leave it unset.
   */
  workingDirectory?: string;
  runAt: string;
  lastUsageAt: string;
  usageEvents: SkillImprovementUsageEvent[];
  transcripts: SkillImprovementTranscriptRecord[];
  status?: "pending" | "running";
  startedAt?: string;
  updatedAt: string;
};

export type ClaimedSkillImprovementJob = {
  key: string;
  job: SkillImprovementJob;
};

export type SkillImprovementRunHistoryEntry = {
  id: string;
  skillName: string;
  status: "completed" | "failed" | "skipped";
  startedAt: string;
  finishedAt: string;
  message: string;
  usageCount: number;
  error?: string;
};

export type SkillImprovementBackupRecord = {
  key: string;
  skillName: string;
  sourceRootDir: string;
  backupRootDir: string;
  createdAt: string;
  restoreMode: "copy-back" | "delete-shadow";
  shadowRootDir?: string;
};

export type SkillImprovementState = {
  version: 1;
  pendingJobs: Record<string, SkillImprovementJob>;
  runHistory: SkillImprovementRunHistoryEntry[];
  backups: Record<string, SkillImprovementBackupRecord>;
};

export type SkillImprovementEligibility = {
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

export type SkillImprovementPendingJobSummary = {
  skillName: string;
  runAt: string;
  lastUsageAt: string;
  usageCount: number;
  status: "pending" | "running";
  sources: Array<SkillUsageRecord["source"]>;
  kinds: SkillUsageKind[];
};

export type SkillImprovementStatusEvent = {
  type: "skill_improvement_status";
  sessionId: string;
  enabled: boolean;
  model?: string;
  scope: SkillImprovementScope;
  excludedSkills: string[];
  busy: boolean;
  blockReason: string | null;
  pendingJobs: SkillImprovementPendingJobSummary[];
  runHistory: SkillImprovementRunHistoryEntry[];
  backups: SkillImprovementBackupRecord[];
  skills: SkillImprovementEligibility[];
};

export type SkillImproverRunInput = {
  skillName: string;
  skillRootDir: string;
  skillPath: string;
  sourceKind: SkillImprovementEligibility["sourceKind"];
  usageEvents: SkillImprovementUsageEvent[];
  transcripts: SkillImprovementTranscriptRecord[];
  allSkills: Array<{ name: string; description: string }>;
};

export type SkillImproverRunResult = {
  ok: boolean;
  /** True when any file inside the skill directory was written or edited. */
  changed: boolean;
  message: string;
  error?: string;
};
