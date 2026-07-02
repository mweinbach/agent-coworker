import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useAppStore } from "../../app/store";
import { Button } from "../../components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../../components/ui/command";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import {
  availableProvidersFromCatalog,
  type CatalogVisibilityOptions,
  encodeProviderModelSelection,
  modelChoicesFromCatalog,
  modelDescriptionsFromCatalog,
  resolveModelDisplayLabel,
} from "../../lib/modelChoices";
import { displayProviderName } from "../../lib/providerDisplayNames";
import { cn } from "../../lib/utils";
import { PROVIDER_NAMES, type ProviderName } from "../../lib/wsProtocol";

export function isChatProviderName(value: unknown): value is ProviderName {
  return typeof value === "string" && (PROVIDER_NAMES as readonly string[]).includes(value);
}

export type ComposerModelSelection = {
  provider: ProviderName;
  model: string;
};

function ComposerModelOption({
  label,
  description,
  selected,
}: {
  label: string;
  description?: string;
  selected: boolean;
}) {
  return (
    <>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-xs font-medium text-foreground">{label}</span>
        {description ? (
          <span className="truncate text-[11px] leading-4 text-muted-foreground">
            {description}
          </span>
        ) : null}
      </div>
      <CheckIcon
        className={cn("ml-2 size-3.5 shrink-0", selected ? "opacity-100" : "opacity-0")}
        aria-hidden
      />
    </>
  );
}

export function ComposerModelSelector({
  provider,
  model,
  modelDisplayNames,
  disabled,
  defaultOpen = false,
  onChange,
}: {
  provider: ProviderName;
  model: string;
  modelDisplayNames: Record<ProviderName, Record<string, string>>;
  disabled?: boolean;
  defaultOpen?: boolean;
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
  const modelDescriptions = useMemo(
    () => modelDescriptionsFromCatalog(providerCatalog),
    [providerCatalog],
  );
  const providers = useMemo(
    () =>
      availableProvidersFromCatalog(providerCatalog, providerConnected, provider, {
        ...chatCatalogVisibility,
        visibleModelsByProvider: choices,
      }),
    [providerCatalog, providerConnected, provider, chatCatalogVisibility, choices],
  );
  const selectedValue = encodeProviderModelSelection(provider, model);
  const triggerLabel = model ? resolveModelDisplayLabel(provider, model, modelDisplayNames) : "";

  const [open, setOpen] = useState(defaultOpen);
  const [customDialogOpen, setCustomDialogOpen] = useState(false);
  const [customModelVal, setCustomModelVal] = useState("");

  const selectModel = (nextProvider: ProviderName, nextModel: string) => {
    setOpen(false);
    if (nextProvider === provider && nextModel === model) return;
    onChange({ provider: nextProvider, model: nextModel });
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            aria-label="Model"
            data-slot="composer-model-selector"
            title={model ? `${triggerLabel} (${model})` : "Choose a model"}
            className="h-7 min-w-0 max-w-[220px] gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground/85 hover:bg-muted/30 hover:text-foreground"
          >
            <span className="truncate">{triggerLabel || "Model"}</span>
            <ChevronDownIcon className="size-3 shrink-0 opacity-60" aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-[300px] overflow-hidden rounded-xl border-border/45 p-1 shadow-xl shadow-foreground/10 outline-none"
        >
          <Command className="rounded-lg bg-transparent [&_[data-slot=command-input-wrapper]]:border-b-border/50 [&_[data-slot=command-input-wrapper]]:bg-background/60 [&_[data-slot=command-input-wrapper]]:px-3">
            <CommandInput placeholder="Search models…" />
            <CommandList>
              <CommandEmpty>No models found.</CommandEmpty>
              {providers.map((p) => {
                const models = choices[p] ?? [];
                const showCurrentCustom = p === provider && !!model && !models.includes(model);
                const showBedrockCustom = p === "bedrock";
                if (models.length === 0 && !showCurrentCustom && !showBedrockCustom) return null;
                return (
                  <CommandGroup key={p} heading={displayProviderName(p)}>
                    {models.map((m) => {
                      const sel = encodeProviderModelSelection(p, m);
                      const label = resolveModelDisplayLabel(p, m, modelDisplayNames);
                      return (
                        <CommandItem
                          key={sel}
                          value={`${sel} ${label} ${displayProviderName(p)}`}
                          title={m}
                          onSelect={() => selectModel(p, m)}
                        >
                          <ComposerModelOption
                            label={label}
                            description={modelDescriptions[p]?.[m]}
                            selected={sel === selectedValue}
                          />
                        </CommandItem>
                      );
                    })}
                    {showCurrentCustom ? (
                      <CommandItem
                        key={selectedValue}
                        value={`${selectedValue} custom ${displayProviderName(p)}`}
                        title={model}
                        onSelect={() => selectModel(p, model)}
                      >
                        <ComposerModelOption
                          label={`${resolveModelDisplayLabel(p, model, modelDisplayNames)} (custom)`}
                          selected
                        />
                      </CommandItem>
                    ) : null}
                    {showBedrockCustom ? (
                      <CommandItem
                        key="bedrock-custom-entry"
                        value="bedrock custom model id arn"
                        onSelect={() => {
                          setOpen(false);
                          setCustomModelVal(provider === "bedrock" ? model : "");
                          setCustomDialogOpen(true);
                        }}
                      >
                        <span className="text-xs text-muted-foreground">
                          Custom model ID / ARN…
                        </span>
                      </CommandItem>
                    ) : null}
                  </CommandGroup>
                );
              })}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

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
