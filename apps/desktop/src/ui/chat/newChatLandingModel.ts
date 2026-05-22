import { defaultModelForProvider } from "@cowork/providers/catalog";
import type { WorkspaceRecord } from "../../app/types";
import { type ComposerModelSelection, isChatProviderName } from "./ComposerModelSelector";

export function resolveDefaultNewChatModel(
  workspace: WorkspaceRecord | null,
): ComposerModelSelection {
  const provider =
    workspace?.defaultProvider && isChatProviderName(workspace.defaultProvider)
      ? workspace.defaultProvider
      : "google";
  return {
    provider,
    model: workspace?.defaultModel?.trim() || defaultModelForProvider(provider) || "",
  };
}
