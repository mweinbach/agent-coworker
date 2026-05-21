import { defaultModelForProvider } from "@cowork/providers/catalog";
import * as desktopCommands from "../../lib/desktopCommands";
import { makeId, nowIso, type StoreGet } from "../store.helpers";
import { isOneOffChatWorkspace, type WorkspaceRecord } from "../types";

function projectWorkspaces(get: StoreGet): WorkspaceRecord[] {
  return get().workspaces.filter((workspace) => !isOneOffChatWorkspace(workspace));
}

function currentProjectDefaultsSource(get: StoreGet): WorkspaceRecord | null {
  const state = get();
  const selected = state.selectedWorkspaceId
    ? (state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId) ?? null)
    : null;
  if (selected && !isOneOffChatWorkspace(selected)) {
    return selected;
  }
  return projectWorkspaces(get)[0] ?? null;
}

export async function createOneOffWorkspaceRecord(
  get: StoreGet,
  titleHint?: string,
): Promise<WorkspaceRecord> {
  const created = await desktopCommands.createOneOffChatWorkspace({ titleHint });
  const source = currentProjectDefaultsSource(get);
  const defaultProvider = source?.defaultProvider ?? "google";
  const defaultModel =
    source?.defaultModel?.trim() ||
    get().providerDefaultModelByProvider[defaultProvider] ||
    defaultModelForProvider(defaultProvider) ||
    "";
  const defaultPreferredChildModel = source?.defaultPreferredChildModel?.trim() || defaultModel;
  const defaultChildModelRoutingMode = source?.defaultChildModelRoutingMode ?? "same-provider";
  const defaultPreferredChildModelRef =
    source?.defaultPreferredChildModelRef?.trim() ||
    `${defaultProvider}:${defaultPreferredChildModel || defaultModel}`;
  const createdAt = nowIso();

  return {
    id: makeId(),
    name: created.name,
    path: created.path,
    workspaceKind: "oneOffChat",
    createdAt,
    lastOpenedAt: createdAt,
    wsProtocol: "jsonrpc",
    defaultProvider,
    defaultModel,
    defaultPreferredChildModel,
    defaultChildModelRoutingMode,
    defaultPreferredChildModelRef,
    defaultAllowedChildModelRefs: source?.defaultAllowedChildModelRefs ?? [],
    defaultToolOutputOverflowChars: source?.defaultToolOutputOverflowChars,
    providerOptions: source?.providerOptions,
    defaultEnableMcp: true,
    defaultBackupsEnabled: false,
    yolo: true,
  };
}
