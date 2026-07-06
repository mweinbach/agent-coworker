import { useAppStore } from "../../app/store";
import type { ProviderName } from "../../lib/wsProtocol";
import { ComposerModelSelector } from "./ComposerModelSelector";

export function ThreadModelSelector({
  threadId,
  provider,
  model,
  modelDisplayNames,
  disabled,
}: {
  threadId: string;
  provider: ProviderName;
  model: string;
  modelDisplayNames: Record<ProviderName, Record<string, string>>;
  disabled?: boolean;
}) {
  const setThreadModel = useAppStore((s) => s.setThreadModel);

  return (
    <ComposerModelSelector
      provider={provider}
      model={model}
      modelDisplayNames={modelDisplayNames}
      disabled={disabled}
      onChange={(selection) => setThreadModel(threadId, selection.provider, selection.model)}
    />
  );
}
