import type { ModelMessage, SkillScope } from "../types";

export const SKILL_IMPROVEMENT_DEBOUNCE_MS = 10 * 60 * 1000;
export const SKILL_IMPROVEMENT_SCHEDULER_INTERVAL_MS = 60 * 1000;

export type SkillImprovementScope = "user" | "all";

export type SkillUsageKind = "tool" | "reference";

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

export type SkillImprovementUsageEvent = SkillUsageRecord & {
  sessionId: string;
  workingDirectory: string;
  messageStartIndex: number;
  messageEndIndex: number;
  transcript: string;
};

export type SkillImprovementJob = {
  skillName: string;
  runAt: string;
  lastUsageAt: string;
  usageEvents: SkillImprovementUsageEvent[];
  status?: "pending" | "running";
  startedAt?: string;
  updatedAt: string;
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
  skillPath: string | null;
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
  allSkills: Array<{ name: string; description: string }>;
  transcriptMessages?: ModelMessage[];
};
