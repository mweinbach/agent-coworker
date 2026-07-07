import { useAppStore } from "../../app/store";
import type { ProviderName } from "../../lib/wsProtocol";
import { ComposerModelSelector } from "./ComposerModelSelector";

export function ThreadModelSelector({
  threadId,
  provider,
  model,
  modelDisplayNames,
  disabled,
  defaultOpen,
}: {
  threadId: string;
  provider: ProviderName;
  model: string;
  modelDisplayNames: Record<ProviderName, Record<string, string>>;
  disabled?: boolean;
  defaultOpen?: boolean;
}) {
  const setThreadModel = useAppStore((s) => s.setThreadModel);

  return (
    <ComposerModelSelector
      provider={provider}
      model={model}
      modelDisplayNames={modelDisplayNames}
      disabled={disabled}
      defaultOpen={defaultOpen}
      onChange={(selection) => setThreadModel(threadId, selection.provider, selection.model)}
    />
  );
}
