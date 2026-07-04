import { PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useAppStore } from "../../../app/store";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import {
  customModelPlaceholderForProvider,
  isCatalogModelEnabled,
  isCustomCatalogModelEntry,
  supportsCustomModelIds,
} from "../../../lib/modelChoices";
import { displayProviderName } from "../../../lib/providerDisplayNames";
import type { ProviderName } from "../../../lib/wsProtocol";

type ManageModelsDialogProps = {
  provider: ProviderName | null;
  onOpenChange: (open: boolean) => void;
};

export function ManageModelsDialog({ provider, onOpenChange }: ManageModelsDialogProps) {
  const providerCatalog = useAppStore((s) => s.providerCatalog);
  const setProviderModelsEnabled = useAppStore((s) => s.setProviderModelsEnabled);
  const resetProviderModelPreferences = useAppStore((s) => s.resetProviderModelPreferences);
  const addCustomProviderModel = useAppStore((s) => s.addCustomProviderModel);
  const deleteCustomProviderModel = useAppStore((s) => s.deleteCustomProviderModel);

  const [search, setSearch] = useState("");
  const [customDraft, setCustomDraft] = useState("");
  const [pendingById, setPendingById] = useState<Record<string, boolean>>({});

  const catalogEntry = provider
    ? providerCatalog.find((entry) => entry.id === provider)
    : undefined;
  const models = useMemo(
    () => (Array.isArray(catalogEntry?.models) ? catalogEntry.models : []),
    [catalogEntry],
  );

  // The catalog event is the source of truth; local pending flags only bridge
  // the round-trip so checkboxes respond instantly.
  // biome-ignore lint/correctness/useExhaustiveDependencies: providerCatalog changes signal a completed round-trip
  useEffect(() => {
    setPendingById({});
  }, [providerCatalog]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset transient state when the target provider changes
  useEffect(() => {
    setSearch("");
    setCustomDraft("");
    setPendingById({});
  }, [provider]);

  if (!provider) return null;

  const providerLabel = catalogEntry?.name ?? displayProviderName(provider);
  const normalizedSearch = search.trim().toLowerCase();
  const visibleModels = normalizedSearch
    ? models.filter(
        (model) =>
          model.id.toLowerCase().includes(normalizedSearch) ||
          model.displayName.toLowerCase().includes(normalizedSearch),
      )
    : models;
  const enabledCount = models.filter(
    (model) => pendingById[model.id] ?? isCatalogModelEnabled(model),
  ).length;
  const canUseCustomModels = supportsCustomModelIds(provider);

  const isModelChecked = (modelId: string, fallback: boolean) => pendingById[modelId] ?? fallback;

  const toggleModel = (modelId: string, enabled: boolean) => {
    setPendingById((s) => ({ ...s, [modelId]: enabled }));
    void setProviderModelsEnabled(provider, [{ id: modelId, enabled }]);
  };

  const setAllVisible = (enabled: boolean) => {
    if (visibleModels.length === 0) return;
    setPendingById((s) => ({
      ...s,
      ...Object.fromEntries(visibleModels.map((model) => [model.id, enabled])),
    }));
    void setProviderModelsEnabled(
      provider,
      visibleModels.map((model) => ({ id: model.id, enabled })),
    );
  };

  const submitCustomModel = () => {
    const modelId = customDraft.trim();
    if (!modelId) return;
    setCustomDraft("");
    void addCustomProviderModel(provider, modelId);
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-border/50 px-6 py-4">
          <DialogTitle>Manage {providerLabel} models</DialogTitle>
          <DialogDescription>
            {enabledCount} of {models.length} enabled. Enabled models appear in model pickers;
            disabling never blocks a model that is already selected.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2 border-b border-border/50 px-6 py-3">
          <Input
            className="min-w-0 flex-1 sm:min-w-48"
            placeholder="Search models"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            aria-label={`Search ${providerLabel} models`}
          />
          <Button type="button" variant="outline" size="sm" onClick={() => setAllVisible(true)}>
            Enable all
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setAllVisible(false)}>
            Disable all
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void resetProviderModelPreferences(provider)}
          >
            Reset to defaults
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-3">
          {visibleModels.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {models.length === 0 ? "No models discovered yet." : "No models match your search."}
            </div>
          ) : (
            <div className="space-y-0.5">
              {visibleModels.map((model) => {
                const custom = isCustomCatalogModelEntry(model);
                const checked = isModelChecked(model.id, isCatalogModelEnabled(model));
                return (
                  <div
                    key={model.id}
                    className="flex items-center gap-3 rounded-sm px-1.5 py-1.5 hover:bg-muted/40"
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(next) => toggleModel(model.id, next === true)}
                      aria-label={`${checked ? "Disable" : "Enable"} ${model.id}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-foreground" title={model.id}>
                        {model.displayName || model.id}
                      </div>
                      {model.displayName && model.displayName !== model.id ? (
                        <div className="truncate text-xs text-muted-foreground" title={model.id}>
                          {model.id}
                        </div>
                      ) : null}
                    </div>
                    {custom ? (
                      <Badge variant="outline" className="shrink-0 rounded-sm text-[10px]">
                        Custom
                      </Badge>
                    ) : null}
                    {custom ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-6 shrink-0 rounded-sm text-muted-foreground hover:text-destructive"
                        aria-label={`Remove custom model ${model.id}`}
                        onClick={() => void deleteCustomProviderModel(provider, model.id)}
                      >
                        <Trash2Icon className="size-3" aria-hidden />
                      </Button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {canUseCustomModels ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-border/50 px-6 py-3">
            <Input
              className="min-w-0 flex-1 sm:min-w-64"
              placeholder={customModelPlaceholderForProvider(provider)}
              value={customDraft}
              onChange={(event) => setCustomDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && customDraft.trim()) submitCustomModel();
              }}
              aria-label={`${providerLabel} custom model ID`}
            />
            <Button
              type="button"
              variant="outline"
              disabled={!customDraft.trim()}
              onClick={submitCustomModel}
            >
              <PlusIcon data-icon="inline-start" />
              Add
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
