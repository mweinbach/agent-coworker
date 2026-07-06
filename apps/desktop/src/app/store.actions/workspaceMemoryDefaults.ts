import type {
  SkillImprovementScope,
  WorkspaceDefaultsPatch,
  WorkspaceRecord,
  WorkspaceRuntime,
} from "../types";

type WorkspaceMemoryDefaults = Pick<
  WorkspaceRecord,
  | "defaultAdvancedMemory"
  | "defaultMemoryGenerationModel"
  | "defaultSkillImprovementEnabled"
  | "defaultSkillImprovementModel"
  | "defaultSkillImprovementScope"
  | "defaultSkillImprovementExcludedSkills"
>;

type ApplyMemoryDefaults = {
  advancedMemory?: boolean;
  memoryGenerationModel: string | null;
  skillImprovementEnabled?: boolean;
  skillImprovementModel: string | null;
  skillImprovementScope?: SkillImprovementScope;
  skillImprovementExcludedSkills?: string[];
};

export function normalizeMemoryGenerationModel(
  value: string | null | undefined,
): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function normalizeSkillImprovementScope(value: unknown): SkillImprovementScope | undefined {
  return value === "user" || value === "all" ? value : undefined;
}

function normalizeExcludedSkills(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = [
    ...new Set(value.map((entry) => (typeof entry === "string" ? entry.trim() : ""))),
  ]
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  return normalized;
}

export function resolveWorkspaceMemoryDefaultsFromControl(
  workspace: WorkspaceRecord,
  controlSessionConfig: WorkspaceRuntime["controlSessionConfig"] | null | undefined,
): WorkspaceMemoryDefaults {
  const hasControlMemoryGenerationModel =
    !!controlSessionConfig && Object.hasOwn(controlSessionConfig, "memoryGenerationModel");
  const hasControlSkillImprovementModel =
    !!controlSessionConfig && Object.hasOwn(controlSessionConfig, "skillImprovementModel");
  const hasControlSkillImprovementExcludedSkills =
    !!controlSessionConfig && Object.hasOwn(controlSessionConfig, "skillImprovementExcludedSkills");

  return {
    defaultAdvancedMemory:
      typeof controlSessionConfig?.advancedMemory === "boolean"
        ? controlSessionConfig.advancedMemory
        : workspace.defaultAdvancedMemory,
    defaultMemoryGenerationModel: hasControlMemoryGenerationModel
      ? normalizeMemoryGenerationModel(controlSessionConfig.memoryGenerationModel)
      : workspace.defaultMemoryGenerationModel,
    defaultSkillImprovementEnabled:
      typeof controlSessionConfig?.skillImprovementEnabled === "boolean"
        ? controlSessionConfig.skillImprovementEnabled
        : workspace.defaultSkillImprovementEnabled,
    defaultSkillImprovementModel: hasControlSkillImprovementModel
      ? normalizeMemoryGenerationModel(controlSessionConfig.skillImprovementModel)
      : workspace.defaultSkillImprovementModel,
    defaultSkillImprovementScope:
      normalizeSkillImprovementScope(controlSessionConfig?.skillImprovementScope) ??
      workspace.defaultSkillImprovementScope,
    defaultSkillImprovementExcludedSkills: hasControlSkillImprovementExcludedSkills
      ? normalizeExcludedSkills(controlSessionConfig.skillImprovementExcludedSkills)
      : workspace.defaultSkillImprovementExcludedSkills,
  };
}

export function resolveControlApplyMemoryDefaults(workspace: WorkspaceRecord): ApplyMemoryDefaults {
  return {
    advancedMemory: workspace.defaultAdvancedMemory,
    memoryGenerationModel:
      normalizeMemoryGenerationModel(workspace.defaultMemoryGenerationModel) ?? null,
    skillImprovementEnabled: workspace.defaultSkillImprovementEnabled,
    skillImprovementModel:
      normalizeMemoryGenerationModel(workspace.defaultSkillImprovementModel) ?? null,
    skillImprovementScope: workspace.defaultSkillImprovementScope,
    skillImprovementExcludedSkills: normalizeExcludedSkills(
      workspace.defaultSkillImprovementExcludedSkills,
    ),
  };
}

export function resolveThreadApplyMemoryDefaults(
  workspace: WorkspaceRecord,
  controlSessionConfig: WorkspaceRuntime["controlSessionConfig"] | null | undefined,
): ApplyMemoryDefaults {
  return {
    advancedMemory:
      typeof workspace.defaultAdvancedMemory === "boolean"
        ? workspace.defaultAdvancedMemory
        : controlSessionConfig?.advancedMemory,
    memoryGenerationModel:
      normalizeMemoryGenerationModel(workspace.defaultMemoryGenerationModel) ??
      normalizeMemoryGenerationModel(controlSessionConfig?.memoryGenerationModel) ??
      null,
    skillImprovementEnabled:
      typeof workspace.defaultSkillImprovementEnabled === "boolean"
        ? workspace.defaultSkillImprovementEnabled
        : controlSessionConfig?.skillImprovementEnabled,
    skillImprovementModel:
      normalizeMemoryGenerationModel(workspace.defaultSkillImprovementModel) ??
      normalizeMemoryGenerationModel(controlSessionConfig?.skillImprovementModel) ??
      null,
    skillImprovementScope:
      workspace.defaultSkillImprovementScope ??
      normalizeSkillImprovementScope(controlSessionConfig?.skillImprovementScope),
    skillImprovementExcludedSkills:
      normalizeExcludedSkills(workspace.defaultSkillImprovementExcludedSkills) ??
      normalizeExcludedSkills(controlSessionConfig?.skillImprovementExcludedSkills),
  };
}

export function buildGlobalMemoryDefaultsPatch(
  patch: WorkspaceDefaultsPatch,
  nextWorkspace: WorkspaceRecord,
): Partial<WorkspaceMemoryDefaults> {
  return {
    ...(patch.defaultAdvancedMemory !== undefined
      ? { defaultAdvancedMemory: nextWorkspace.defaultAdvancedMemory }
      : {}),
    ...(patch.defaultMemoryGenerationModel !== undefined
      ? { defaultMemoryGenerationModel: nextWorkspace.defaultMemoryGenerationModel }
      : {}),
    ...(patch.defaultSkillImprovementEnabled !== undefined
      ? { defaultSkillImprovementEnabled: nextWorkspace.defaultSkillImprovementEnabled }
      : {}),
    ...(patch.defaultSkillImprovementModel !== undefined
      ? { defaultSkillImprovementModel: nextWorkspace.defaultSkillImprovementModel }
      : {}),
    ...(patch.defaultSkillImprovementScope !== undefined
      ? { defaultSkillImprovementScope: nextWorkspace.defaultSkillImprovementScope }
      : {}),
    ...(patch.defaultSkillImprovementExcludedSkills !== undefined
      ? {
          defaultSkillImprovementExcludedSkills:
            nextWorkspace.defaultSkillImprovementExcludedSkills,
        }
      : {}),
  };
}

export function hasGlobalMemoryDefaultsPatch(patch: Partial<WorkspaceMemoryDefaults>): boolean {
  return Object.keys(patch).length > 0;
}

export function applyGlobalMemoryDefaults<T extends WorkspaceMemoryDefaults>(
  workspace: T,
  patch: Partial<WorkspaceMemoryDefaults>,
): T {
  return hasGlobalMemoryDefaultsPatch(patch) ? { ...workspace, ...patch } : workspace;
}
