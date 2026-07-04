import { CheckIcon, ChevronDownIcon, PlusIcon } from "lucide-react";
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
import { Input } from "../../components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import {
  availableProvidersFromCatalog,
  type CatalogVisibilityOptions,
  customModelPlaceholderForProvider,
  encodeProviderModelSelection,
  modelChoicesFromCatalog,
  modelDescriptionsFromCatalog,
  resolveModelDisplayLabel,
  supportsCustomModelIds,
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
  const addCustomProviderModel = useAppStore((s) => s.addCustomProviderModel);
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
  const [customProvider, setCustomProvider] = useState<ProviderName | null>(null);
  const [customModelVal, setCustomModelVal] = useState("");

  const selectModel = (nextProvider: ProviderName, nextModel: string) => {
    setOpen(false);
    if (nextProvider === provider && nextModel === model) return;
    onChange({ provider: nextProvider, model: nextModel });
  };

  const openCustomModelEditor = (nextProvider: ProviderName, initialModel: string) => {
    setCustomProvider(nextProvider);
    setCustomModelVal(initialModel);
    setCustomDialogOpen(true);
  };

  const saveCustomModel = async () => {
    if (!customProvider) return;
    const customModel = customModelVal.trim();
    if (!customModel) return;
    // Wait for the add to persist before selecting: the model/set path only
    // accepts unknown dynamic IDs once they exist in the custom-model store.
    const added = await addCustomProviderModel(customProvider, customModel);
    if (!added) return;
    onChange({ provider: customProvider, model: customModel });
    setCustomDialogOpen(false);
    setOpen(false);
  };

  return (
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
              const showCustomEntry = supportsCustomModelIds(p);
              if (models.length === 0 && !showCurrentCustom && !showCustomEntry) return null;
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
                  {showCustomEntry ? (
                    <button
                      type="button"
                      data-slot="command-item"
                      key={`${p}-custom-entry`}
                      className={cn(
                        "relative flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground",
                        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
                      )}
                      onClick={() =>
                        openCustomModelEditor(p, p === provider && showCurrentCustom ? model : "")
                      }
                    >
                      <PlusIcon className="mr-2 size-3.5 shrink-0 text-muted-foreground" />
                      <span className="text-xs text-muted-foreground">Custom model ID…</span>
                    </button>
                  ) : null}
                  {customDialogOpen && customProvider === p ? (
                    <div className="mt-1 flex items-center gap-2 rounded-sm border border-border/50 bg-background/70 p-2">
                      <Input
                        autoFocus
                        placeholder={customModelPlaceholderForProvider(p)}
                        value={customModelVal}
                        onInput={(e) => setCustomModelVal(e.currentTarget.value)}
                        onChange={(e) => setCustomModelVal(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && customModelVal.trim()) {
                            void saveCustomModel();
                          }
                        }}
                      />
                      <Button
                        type="button"
                        size="sm"
                        disabled={!customModelVal.trim()}
                        onClick={() => void saveCustomModel()}
                      >
                        Save
                      </Button>
                    </div>
                  ) : null}
                </CommandGroup>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
