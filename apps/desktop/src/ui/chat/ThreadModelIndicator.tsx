import { Badge } from "../../components/ui/badge";
import { resolveModelDisplayLabel } from "../../lib/modelChoices";
import { displayProviderName } from "../../lib/providerDisplayNames";
import type { ProviderName } from "../../lib/wsProtocol";

export function ThreadModelIndicator({
  provider,
  model,
  modelDisplayNames,
}: {
  provider: ProviderName;
  model: string;
  modelDisplayNames: Record<ProviderName, Record<string, string>>;
}) {
  const id = model.trim();
  if (!id) return null;
  const friendly = resolveModelDisplayLabel(provider, id, modelDisplayNames);
  const title =
    friendly !== id
      ? `${displayProviderName(provider)} / ${friendly} (${id})`
      : `${displayProviderName(provider)} / ${id}`;

  return (
    <Badge
      variant="outline"
      className="h-7 max-w-[220px] rounded-md border-none bg-transparent px-2 text-xs font-medium text-foreground/80 shadow-none"
    >
      <span className="truncate" title={title}>
        {friendly}
      </span>
    </Badge>
  );
}
