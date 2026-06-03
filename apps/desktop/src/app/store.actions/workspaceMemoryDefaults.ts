import type { WorkspaceDefaultsPatch, WorkspaceRecord, WorkspaceRuntime } from "../types";

type WorkspaceMemoryDefaults = Pick<
  WorkspaceRecord,
  "defaultAdvancedMemory" | "defaultMemoryGenerationModel"
>;

type ApplyMemoryDefaults = {
  advancedMemory?: boolean;
  memoryGenerationModel: string | null;
};

export function normalizeMemoryGenerationModel(
  value: string | null | undefined,
): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

export function resolveWorkspaceMemoryDefaultsFromControl(
  workspace: WorkspaceRecord,
  controlSessionConfig: WorkspaceRuntime["controlSessionConfig"] | null | undefined,
): WorkspaceMemoryDefaults {
  const hasControlMemoryGenerationModel =
    typeof controlSessionConfig?.memoryGenerationModel === "string";

  return {
    defaultAdvancedMemory:
      typeof controlSessionConfig?.advancedMemory === "boolean"
        ? controlSessionConfig.advancedMemory
        : workspace.defaultAdvancedMemory,
    defaultMemoryGenerationModel: hasControlMemoryGenerationModel
      ? normalizeMemoryGenerationModel(controlSessionConfig.memoryGenerationModel)
      : workspace.defaultMemoryGenerationModel,
  };
}

export function resolveControlApplyMemoryDefaults(workspace: WorkspaceRecord): ApplyMemoryDefaults {
  return {
    advancedMemory: workspace.defaultAdvancedMemory,
    memoryGenerationModel:
      normalizeMemoryGenerationModel(workspace.defaultMemoryGenerationModel) ?? null,
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
