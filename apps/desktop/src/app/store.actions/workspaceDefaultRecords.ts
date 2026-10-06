import type { OpenAiCompatibleProviderOptionsByProvider } from "@cowork/shared/openaiCompatibleOptions";
import type { ProviderName } from "../../lib/wsProtocol";
import {
  mergeWorkspaceProviderOptions,
  mergeWorkspaceProviderOptionsPreservingSearchSettings,
  normalizeWorkspaceProviderOptions,
} from "../openaiCompatibleProviderOptions";
import {
  normalizeWorkspaceUserProfile,
  type WorkspaceDefaultsPatch,
  type WorkspaceRecord,
  type WorkspaceRuntime,
} from "../types";
import { resolveWorkspaceMemoryDefaultsFromControl } from "./workspaceMemoryDefaults";

export function applyWorkspacePatch(
  workspace: WorkspaceRecord,
  patch: WorkspaceDefaultsPatch,
): WorkspaceRecord {
  const {
    clearDefaultToolOutputOverflowChars,
    userProfile: userProfilePatch,
    ...workspacePatch
  } = patch;
  return {
    ...workspace,
    ...workspacePatch,
    ...(clearDefaultToolOutputOverflowChars ? { defaultToolOutputOverflowChars: undefined } : {}),
    ...(workspacePatch.providerOptions !== undefined
      ? {
          providerOptions: mergeWorkspaceProviderOptions(
            workspace.providerOptions,
            workspacePatch.providerOptions,
          ),
        }
      : {}),
    ...(userProfilePatch !== undefined
      ? {
          userProfile: {
            ...normalizeWorkspaceUserProfile(workspace.userProfile),
            ...userProfilePatch,
          },
        }
      : {}),
  };
}

export function copyWorkspaceSettings(
  target: WorkspaceRecord,
  source: WorkspaceRecord,
): WorkspaceRecord {
  return {
    ...target,
    defaultProvider: source.defaultProvider,
    defaultModel: source.defaultModel,
    defaultPreferredChildModel: source.defaultPreferredChildModel,
    defaultChildModelRoutingMode: source.defaultChildModelRoutingMode,
    defaultPreferredChildModelRef: source.defaultPreferredChildModelRef,
    defaultAllowedChildModelRefs: [...(source.defaultAllowedChildModelRefs ?? [])],
    defaultToolOutputOverflowChars: source.defaultToolOutputOverflowChars,
    defaultWorkflowMaxConcurrentAgents: source.defaultWorkflowMaxConcurrentAgents,
    defaultAdvancedMemory: source.defaultAdvancedMemory,
    defaultMemoryGenerationModel: source.defaultMemoryGenerationModel,
    defaultSkillImprovementEnabled: source.defaultSkillImprovementEnabled,
    defaultSkillImprovementModel: source.defaultSkillImprovementModel,
    defaultSkillImprovementScope: source.defaultSkillImprovementScope,
    defaultSkillImprovementExcludedSkills: source.defaultSkillImprovementExcludedSkills
      ? [...source.defaultSkillImprovementExcludedSkills]
      : undefined,
    providerOptions: source.providerOptions,
    userName: source.userName,
    userProfile: source.userProfile ? normalizeWorkspaceUserProfile(source.userProfile) : undefined,
    defaultEnableMcp: source.defaultEnableMcp,
    defaultBackupsEnabled: source.defaultBackupsEnabled,
    yolo: source.yolo,
  };
}

export function resolveWorkspaceRecordWithControlRuntime(
  workspace: WorkspaceRecord,
  runtime: WorkspaceRuntime | undefined,
  isProviderName: (value: unknown) => value is ProviderName,
): WorkspaceRecord {
  if (!runtime) {
    return workspace;
  }
  const controlConfig = runtime.controlConfig as
    | { provider?: unknown; model?: unknown }
    | null
    | undefined;
  const controlSessionConfig = runtime.controlSessionConfig;
  const provider =
    workspace.defaultProvider && isProviderName(workspace.defaultProvider)
      ? workspace.defaultProvider
      : controlConfig?.provider && isProviderName(controlConfig.provider)
        ? controlConfig.provider
        : workspace.defaultProvider;
  const controlModel = typeof controlConfig?.model === "string" ? controlConfig.model.trim() : "";
  const defaultModel = workspace.defaultModel?.trim() || controlModel || workspace.defaultModel;
  const defaultPreferredChildModel =
    controlSessionConfig?.preferredChildModel?.trim() ||
    workspace.defaultPreferredChildModel?.trim() ||
    defaultModel;
  const defaultPreferredChildModelRef =
    controlSessionConfig?.preferredChildModelRef?.trim() ||
    workspace.defaultPreferredChildModelRef?.trim() ||
    (provider && defaultPreferredChildModel
      ? `${provider}:${defaultPreferredChildModel}`
      : undefined);
  const memoryDefaults = resolveWorkspaceMemoryDefaultsFromControl(workspace, controlSessionConfig);

  return {
    ...workspace,
    defaultProvider: provider,
    defaultModel,
    defaultPreferredChildModel,
    defaultChildModelRoutingMode:
      controlSessionConfig?.childModelRoutingMode ??
      workspace.defaultChildModelRoutingMode ??
      "same-provider",
    defaultPreferredChildModelRef,
    defaultAllowedChildModelRefs:
      controlSessionConfig?.allowedChildModelRefs ?? workspace.defaultAllowedChildModelRefs ?? [],
    defaultToolOutputOverflowChars:
      controlSessionConfig?.defaultToolOutputOverflowChars ??
      workspace.defaultToolOutputOverflowChars,
    defaultWorkflowMaxConcurrentAgents:
      controlSessionConfig?.workflowMaxConcurrentAgents ??
      workspace.defaultWorkflowMaxConcurrentAgents,
    defaultAdvancedMemory: memoryDefaults.defaultAdvancedMemory,
    defaultMemoryGenerationModel: memoryDefaults.defaultMemoryGenerationModel,
    defaultSkillImprovementEnabled: memoryDefaults.defaultSkillImprovementEnabled,
    defaultSkillImprovementModel: memoryDefaults.defaultSkillImprovementModel,
    defaultSkillImprovementScope: memoryDefaults.defaultSkillImprovementScope,
    defaultSkillImprovementExcludedSkills: memoryDefaults.defaultSkillImprovementExcludedSkills,
    providerOptions: mergeWorkspaceProviderOptionsPreservingSearchSettings(
      workspace.providerOptions,
      normalizeWorkspaceProviderOptions(controlSessionConfig?.providerOptions),
    ),
    userName:
      typeof controlSessionConfig?.userName === "string"
        ? controlSessionConfig.userName
        : workspace.userName,
    userProfile: controlSessionConfig?.userProfile
      ? normalizeWorkspaceUserProfile(controlSessionConfig.userProfile)
      : workspace.userProfile
        ? normalizeWorkspaceUserProfile(workspace.userProfile)
        : undefined,
    defaultEnableMcp:
      typeof runtime.controlEnableMcp === "boolean"
        ? runtime.controlEnableMcp
        : workspace.defaultEnableMcp,
    defaultBackupsEnabled:
      typeof controlSessionConfig?.defaultBackupsEnabled === "boolean"
        ? controlSessionConfig.defaultBackupsEnabled
        : workspace.defaultBackupsEnabled,
    yolo:
      typeof controlSessionConfig?.yolo === "boolean" ? controlSessionConfig.yolo : workspace.yolo,
  };
}

export function syncWorkspaceControlRuntimeToRecord(
  runtime: WorkspaceRuntime,
  source: WorkspaceRecord,
  isProviderName: (value: unknown) => value is ProviderName,
): WorkspaceRuntime {
  const provider =
    source.defaultProvider && isProviderName(source.defaultProvider)
      ? source.defaultProvider
      : undefined;
  const model = source.defaultModel?.trim() || undefined;
  const nextControlConfig =
    runtime.controlConfig && provider && model
      ? {
          ...runtime.controlConfig,
          provider,
          model,
        }
      : runtime.controlConfig;
  const nextControlEnableMcp =
    runtime.controlEnableMcp !== null || runtime.controlSessionId !== null
      ? source.defaultEnableMcp
      : runtime.controlEnableMcp;
  if (!runtime.controlSessionConfig) {
    return {
      ...runtime,
      controlConfig: nextControlConfig,
      controlEnableMcp: nextControlEnableMcp,
    };
  }
  const preferredChildModel =
    source.defaultPreferredChildModel?.trim() ||
    model ||
    runtime.controlSessionConfig.preferredChildModel;
  const preferredChildModelRef =
    source.defaultPreferredChildModelRef?.trim() ||
    (provider && preferredChildModel ? `${provider}:${preferredChildModel}` : undefined) ||
    runtime.controlSessionConfig.preferredChildModelRef;
  const normalizedProviderOptions = normalizeWorkspaceProviderOptions(source.providerOptions);
  const {
    defaultToolOutputOverflowChars: _prevOverflow,
    memoryGenerationModel: _prevMemoryModel,
    skillImprovementModel: _prevSkillModel,
    ...restControlSessionConfig
  } = runtime.controlSessionConfig;
  const nextSessionConfig: NonNullable<WorkspaceRuntime["controlSessionConfig"]> = {
    ...restControlSessionConfig,
    yolo: source.yolo,
    defaultBackupsEnabled: source.defaultBackupsEnabled,
    preferredChildModel,
    childModelRoutingMode: source.defaultChildModelRoutingMode ?? "same-provider",
    preferredChildModelRef,
    allowedChildModelRefs: [...(source.defaultAllowedChildModelRefs ?? [])],
    ...(source.defaultToolOutputOverflowChars !== undefined
      ? { defaultToolOutputOverflowChars: source.defaultToolOutputOverflowChars }
      : {}),
    workflowMaxConcurrentAgents:
      source.defaultWorkflowMaxConcurrentAgents ??
      runtime.controlSessionConfig.workflowMaxConcurrentAgents,
    advancedMemory:
      typeof source.defaultAdvancedMemory === "boolean"
        ? source.defaultAdvancedMemory
        : runtime.controlSessionConfig.advancedMemory,
    ...(source.defaultMemoryGenerationModel?.trim()
      ? { memoryGenerationModel: source.defaultMemoryGenerationModel.trim() }
      : {}),
    skillImprovementEnabled:
      typeof source.defaultSkillImprovementEnabled === "boolean"
        ? source.defaultSkillImprovementEnabled
        : runtime.controlSessionConfig.skillImprovementEnabled,
    ...(source.defaultSkillImprovementModel?.trim()
      ? { skillImprovementModel: source.defaultSkillImprovementModel.trim() }
      : {}),
    skillImprovementScope:
      source.defaultSkillImprovementScope ?? runtime.controlSessionConfig.skillImprovementScope,
    skillImprovementExcludedSkills: source.defaultSkillImprovementExcludedSkills
      ? [...source.defaultSkillImprovementExcludedSkills]
      : [],
    providerOptions: (normalizedProviderOptions ?? {}) as OpenAiCompatibleProviderOptionsByProvider,
    userName: source.userName ?? "",
    userProfile: normalizeWorkspaceUserProfile(source.userProfile),
  };

  return {
    ...runtime,
    controlConfig: nextControlConfig,
    controlEnableMcp: nextControlEnableMcp,
    controlSessionConfig: nextSessionConfig,
  };
}
