import { useMemo, useState } from "react";
import { useAppStore } from "../../app/store";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import {
  availableProvidersFromCatalog,
  type CatalogVisibilityOptions,
  decodeProviderModelSelection,
  encodeProviderModelSelection,
  modelChoicesFromCatalog,
  resolveModelDisplayLabel,
} from "../../lib/modelChoices";
import { displayProviderName } from "../../lib/providerDisplayNames";
import { PROVIDER_NAMES, type ProviderName } from "../../lib/wsProtocol";

export function isChatProviderName(value: unknown): value is ProviderName {
  return typeof value === "string" && (PROVIDER_NAMES as readonly string[]).includes(value);
}

export type ComposerModelSelection = {
  provider: ProviderName;
  model: string;
};

export function ComposerModelSelector({
  provider,
  model,
  modelDisplayNames,
  disabled,
  onChange,
}: {
  provider: ProviderName;
  model: string;
  modelDisplayNames: Record<ProviderName, Record<string, string>>;
  disabled?: boolean;
  onChange: (selection: ComposerModelSelection) => void;
}) {
  const providerCatalog = useAppStore((s) => s.providerCatalog);
  const providerConnected = useAppStore((s) => s.providerConnected);
  const providerUiState = useAppStore((s) => s.providerUiState);
  const chatCatalogVisibility = useMemo<CatalogVisibilityOptions>(
    () => ({
      hiddenProviders: providerUiState.lmstudio.enabled ? [] : (["lmstudio"] as const),
      hiddenModelsByProvider: {
        lmstudio: providerUiState.lmstudio.hiddenModels,
      },
    }),
    [providerUiState],
  );
  const choices = useMemo(
    () => modelChoicesFromCatalog(providerCatalog, chatCatalogVisibility),
    [providerCatalog, chatCatalogVisibility],
  );
  const providers = useMemo(
    () =>
      availableProvidersFromCatalog(providerCatalog, providerConnected, provider, {
        ...chatCatalogVisibility,
        visibleModelsByProvider: choices,
      }),
    [providerCatalog, providerConnected, provider, chatCatalogVisibility, choices],
  );
  const value = encodeProviderModelSelection(provider, model);
  const bedrockCustomSelection = encodeProviderModelSelection("bedrock", "__custom__");

  const [customDialogOpen, setCustomDialogOpen] = useState(false);
  const [customModelVal, setCustomModelVal] = useState("");

  return (
    <>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(val) => {
          if (val === bedrockCustomSelection) {
            setCustomModelVal(provider === "bedrock" ? model : "");
            setCustomDialogOpen(true);
            return;
          }
          const parsed = decodeProviderModelSelection(val);
          if (!parsed) return;
          onChange({ provider: parsed.provider, model: parsed.modelId });
        }}
      >
        <SelectTrigger
          size="sm"
          className="h-7 w-auto min-w-0 max-w-[220px] rounded-md border-none bg-transparent px-2 text-xs font-medium text-muted-foreground/85 shadow-none transition-colors hover:bg-muted/30 hover:text-foreground focus:ring-0"
        >
          <span className="truncate">
            <SelectValue placeholder="Model" />
          </span>
        </SelectTrigger>
        <SelectContent>
          {providers.map((p) => (
            <SelectGroup key={p}>
              <SelectLabel className="px-2 py-1.5 text-xs font-semibold">
                {displayProviderName(p)}
              </SelectLabel>
              {(choices[p] ?? []).map((m) => {
                const sel = encodeProviderModelSelection(p, m);
                const label = resolveModelDisplayLabel(p, m, modelDisplayNames);
                return (
                  <SelectItem key={sel} value={sel} className="pl-6 text-xs">
                    <span title={m}>{label}</span>
                  </SelectItem>
                );
              })}
              {p === provider && model && !(choices[p] ?? []).includes(model) ? (
                <SelectItem
                  key={encodeProviderModelSelection(p, model)}
                  value={encodeProviderModelSelection(p, model)}
                  className="pl-6 text-xs"
                >
                  <span title={model}>
                    {resolveModelDisplayLabel(p, model, modelDisplayNames)} (custom)
                  </span>
                </SelectItem>
              ) : null}
              {p === "bedrock" ? (
                <SelectItem
                  key={bedrockCustomSelection}
                  value={bedrockCustomSelection}
                  className="pl-6 text-xs"
                >
                  <span>Custom model ID / ARN...</span>
                </SelectItem>
              ) : null}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>

      <Dialog open={customDialogOpen} onOpenChange={setCustomDialogOpen}>
        <DialogContent showCloseButton className="max-w-md">
          <DialogHeader>
            <DialogTitle>Custom Bedrock Model</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Enter a Bedrock model ID or ARN to use as the custom model.
            </p>
            <div className="space-y-2">
              <Input
                placeholder="e.g. us.amazon.nova-pro-v1:0"
                value={customModelVal}
                onChange={(e) => setCustomModelVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && customModelVal.trim()) {
                    onChange({ provider: "bedrock", model: customModelVal.trim() });
                    setCustomDialogOpen(false);
                  }
                }}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setCustomDialogOpen(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                disabled={!customModelVal.trim()}
                onClick={() => {
                  onChange({ provider: "bedrock", model: customModelVal.trim() });
                  setCustomDialogOpen(false);
                }}
              >
                Save
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
