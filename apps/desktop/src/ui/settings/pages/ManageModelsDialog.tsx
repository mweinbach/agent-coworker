import { PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useAppStore } from "../../../app/store";
import { operationKey } from "../../../app/store.helpers";
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
import { isImeComposing } from "../../../lib/keyboard";
import {
  customModelPlaceholderForProvider,
  isCatalogModelEnabled,
  isCustomCatalogModelEntry,
  staticCatalogModelsForProvider,
  supportsCustomModelIds,
} from "../../../lib/modelChoices";
import { displayProviderName } from "../../../lib/providerDisplayNames";
import type { ProviderName } from "../../../lib/wsProtocol";
import { OperationFeedback } from "../../OperationFeedback";

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
  const operationsByKey = useAppStore((s) => s.operationsByKey);

  const [search, setSearch] = useState("");
  const [customDraft, setCustomDraft] = useState("");
  const [pendingById, setPendingById] = useState<Record<string, boolean>>({});

  const catalogEntry = provider
    ? providerCatalog.find((entry) => entry.id === provider)
    : undefined;
  const models = useMemo(() => {
    const catalogModels = Array.isArray(catalogEntry?.models) ? catalogEntry.models : [];
    if (catalogModels.length > 0 || !provider) return catalogModels;
    // The catalog can lag behind (not loaded yet, or an entry without models);
    // fall back to the static registry so the dialog is never a dead end.
    return staticCatalogModelsForProvider(provider);
  }, [catalogEntry, provider]);

  // The catalog event is the source of truth; local pending flags only bridge
  // the round-trip so checkboxes respond instantly. Reconcile instead of
  // clearing wholesale: one toggle's refresh must not wipe optimistic state
  // for other toggles still in flight.
  useEffect(() => {
    setPendingById((current) => {
      const ids = Object.keys(current);
      if (ids.length === 0) return current;
      const entry = provider ? providerCatalog.find((e) => e.id === provider) : undefined;
      const enabledInCatalog = new Map(
        (Array.isArray(entry?.models) ? entry.models : []).map(
          (model) => [model.id, isCatalogModelEnabled(model)] as const,
        ),
      );
      const next = { ...current };
      let changed = false;
      for (const id of ids) {
        const landed = enabledInCatalog.get(id);
        // Drop entries the catalog now agrees with (round-trip landed) and
        // entries for models that no longer exist; keep in-flight disagreements.
        if (landed === undefined || landed === next[id]) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [providerCatalog, provider]);

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
  const normalizedCustomDraft = customDraft.trim();
  const addOperation =
    operationsByKey[
      operationKey("provider", `model-add:${normalizedCustomDraft || "missing"}`, provider)
    ];
  const resetOperation = operationsByKey[operationKey("provider", "models-reset", provider)];
  const addPending = addOperation?.status === "pending";
  const resetPending = resetOperation?.status === "pending";
  const modelMutationPending = Object.keys(pendingById).length > 0;

  const isModelChecked = (modelId: string, fallback: boolean) => pendingById[modelId] ?? fallback;

  const dropPending = (modelIds: readonly string[]) => {
    setPendingById((s) => {
      const next = { ...s };
      for (const id of modelIds) delete next[id];
      return next;
    });
  };

  const toggleModel = (modelId: string, enabled: boolean) => {
    if (Object.hasOwn(pendingById, modelId)) return;
    setPendingById((s) => ({ ...s, [modelId]: enabled }));
    // The response carries the refreshed catalog, so once the call settles the
    // optimistic entry is stale either way (applied, rejected, or overridden).
    void setProviderModelsEnabled(provider, [{ id: modelId, enabled }]).then(() => {
      dropPending([modelId]);
    });
  };

  const setAllVisible = (enabled: boolean) => {
    if (visibleModels.length === 0 || modelMutationPending) return;
    const modelIds = visibleModels.map((model) => model.id);
    setPendingById((s) => ({
      ...s,
      ...Object.fromEntries(modelIds.map((id) => [id, enabled])),
    }));
    void setProviderModelsEnabled(
      provider,
      visibleModels.map((model) => ({ id: model.id, enabled })),
    ).then(() => {
      dropPending(modelIds);
    });
  };

  const resetToDefaults = () => {
    if (resetPending || modelMutationPending) return;
    // Reset discards local intent, so clear optimistic state immediately;
    // otherwise a still-pending toggle would survive the reconcile and show a
    // stale checkbox after the server restores defaults.
    setPendingById({});
    void resetProviderModelPreferences(provider);
  };

  const submitCustomModel = async () => {
    const modelId = customDraft.trim();
    if (!modelId || addPending) return;
    const added = await addCustomProviderModel(provider, modelId);
    if (added.ok) {
      setCustomDraft((current) => (current.trim() === modelId ? "" : current));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !addPending) onOpenChange(false);
      }}
    >
      <DialogContent
        aria-busy={addPending}
        className="flex max-h-[80vh] flex-col gap-0 p-0 sm:max-w-2xl"
      >
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
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={modelMutationPending || resetPending}
            onClick={() => setAllVisible(true)}
          >
            Enable all
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={modelMutationPending || resetPending}
            onClick={() => setAllVisible(false)}
          >
            Disable all
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={modelMutationPending || resetPending}
            onClick={resetToDefaults}
          >
            {resetPending ? "Resetting..." : "Reset to defaults"}
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
                const togglePending = Object.hasOwn(pendingById, model.id);
                const deleteOperation =
                  operationsByKey[operationKey("provider", `model-delete:${model.id}`, provider)];
                return (
                  <div
                    key={model.id}
                    className="flex items-center gap-3 rounded-sm px-1.5 py-1.5 hover:bg-muted/40"
                  >
                    <Checkbox
                      checked={checked}
                      disabled={togglePending}
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
                        disabled={deleteOperation?.status === "pending"}
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
                if (
                  event.key === "Enter" &&
                  !isImeComposing(event.nativeEvent) &&
                  customDraft.trim()
                ) {
                  void submitCustomModel();
                }
              }}
              disabled={addPending}
              aria-label={`${providerLabel} custom model ID`}
            />
            <Button
              type="button"
              variant="outline"
              disabled={!customDraft.trim() || addPending}
              onClick={() => void submitCustomModel()}
            >
              <PlusIcon data-icon="inline-start" />
              {addPending ? "Adding..." : "Add"}
            </Button>
            <OperationFeedback operation={addOperation} className="basis-full" />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
