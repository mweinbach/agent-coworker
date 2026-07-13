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
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import {
  availableProvidersFromCatalog,
  type CatalogVisibilityOptions,
  encodeProviderModelSelection,
  isCustomCatalogModelEntry,
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
  // A selected model can drop out of the filtered choices either because it is
  // a user-added custom ID or because it is a built-in that is currently
  // disabled. Only the former should be labeled "(custom)".
  const currentModelIsCustom = useMemo(() => {
    if (!model) return false;
    const entry = providerCatalog
      .find((e) => e.id === provider)
      ?.models.find((m) => m.id === model);
    // Absent from the catalog entirely → a typed custom/unknown id.
    return entry ? isCustomCatalogModelEntry(entry) : true;
  }, [providerCatalog, provider, model]);

  const [open, setOpen] = useState(defaultOpen);

  const selectModel = (nextProvider: ProviderName, nextModel: string) => {
    setOpen(false);
    if (nextProvider === provider && nextModel === model) return;
    onChange({ provider: nextProvider, model: nextModel });
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
          className="h-7 min-w-0 max-w-[220px] gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-muted/30 hover:text-foreground"
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
              if (models.length === 0 && !showCurrentCustom) return null;
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
                      value={`${selectedValue}${currentModelIsCustom ? " custom" : ""} ${displayProviderName(p)}`}
                      title={model}
                      onSelect={() => selectModel(p, model)}
                    >
                      <ComposerModelOption
                        label={`${resolveModelDisplayLabel(p, model, modelDisplayNames)}${currentModelIsCustom ? " (custom)" : ""}`}
                        selected
                      />
                    </CommandItem>
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
