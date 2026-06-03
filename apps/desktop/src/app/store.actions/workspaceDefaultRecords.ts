import { mergeWorkspaceProviderOptions } from "../openaiCompatibleProviderOptions";
import {
  normalizeWorkspaceUserProfile,
  type WorkspaceDefaultsPatch,
  type WorkspaceRecord,
} from "../types";

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
    defaultAdvancedMemory: source.defaultAdvancedMemory,
    defaultMemoryGenerationModel: source.defaultMemoryGenerationModel,
    providerOptions: source.providerOptions,
    userName: source.userName,
    userProfile: source.userProfile ? normalizeWorkspaceUserProfile(source.userProfile) : undefined,
    defaultEnableMcp: source.defaultEnableMcp,
    defaultBackupsEnabled: source.defaultBackupsEnabled,
    yolo: source.yolo,
  };
}
