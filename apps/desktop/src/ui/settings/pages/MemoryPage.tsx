import { useAutoAnimate } from "@formkit/auto-animate/react";
import {
  BrainIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useAppStore } from "../../../app/store";
import type { MemoryListEntry } from "../../../app/types";
import {
  CHATS_WORKSPACE_TARGET_ID,
  resolveWorkspaceDisplayTargets,
  type WorkspaceDisplayTarget,
} from "../../../app/workspaceDisplayTargets";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { Switch } from "../../../components/ui/switch";
import { Textarea } from "../../../components/ui/textarea";
import { confirmAction } from "../../../lib/desktopCommands";
import {
  type CatalogVisibilityOptions,
  configuredProvidersForModelChoices,
  decodeProviderModelSelection,
  encodeProviderModelSelection,
  isProviderUnsupportedOnDesktop,
  isUiDisabledProvider,
  modelChoicesFromCatalog,
  modelDisplayNamesFromCatalog,
  resolveModelDisplayLabel,
} from "../../../lib/modelChoices";
import { displayProviderName } from "../../../lib/providerDisplayNames";
import { sortProviderEntriesForSettings } from "../../../lib/providerOrdering";
import { cn } from "../../../lib/utils";
import { PROVIDER_NAMES, type ProviderName, type SessionEvent } from "../../../lib/wsProtocol";
import { SettingsEmptyState, SettingsRow, SettingsSection } from "../SettingsPrimitives";
import { AdvancedMemoryPanel } from "./AdvancedMemoryPanel";

type DraftMemory = {
  scope: "workspace" | "user";
  id: string;
  content: string;
};

const HOT_MEMORY_ID = "hot";
export const CHATS_MEMORY_TARGET_ID = CHATS_WORKSPACE_TARGET_ID;
export const MEMORY_LOADING_STALL_MS = 1_500;
export { parentDirectoryPath } from "../../../app/workspaceDisplayTargets";

export type MemoryTarget = WorkspaceDisplayTarget;
type ProviderCatalogEntry = Extract<SessionEvent, { type: "provider_catalog" }>["all"][number];

type MemoryGenerationModelOption = {
  value: string;
  label: string;
  title: string;
};

type MemoryGenerationModelGroup = {
  provider: ProviderName;
  label: string;
  options: MemoryGenerationModelOption[];
};

export function resolveDraftMemoryId(rawId: string): string {
  return rawId.trim() || HOT_MEMORY_ID;
}

export function isMemoryLoadStalled(
  memoriesLoading: boolean,
  requestedAt: number | null,
  nowMs: number,
  stallMs = MEMORY_LOADING_STALL_MS,
): boolean {
  if (!memoriesLoading || requestedAt === null) return false;
  return nowMs - requestedAt >= stallMs;
}

function emptyDraft(): DraftMemory {
  return { scope: "workspace", id: "", content: "" };
}

export const resolveMemoryTargets = resolveWorkspaceDisplayTargets;

export function resolveMemoryGenerationModelSelection(
  rawModel: string | undefined,
  fallbackProvider: ProviderName | undefined,
): string {
  const raw = rawModel?.trim() ?? "";
  if (!raw) return "";
  const parsed = decodeProviderModelSelection(raw);
  if (parsed) return encodeProviderModelSelection(parsed.provider, parsed.modelId);
  return fallbackProvider ? encodeProviderModelSelection(fallbackProvider, raw) : raw;
}

export function buildMemoryGenerationModelGroups(
  catalog: readonly ProviderCatalogEntry[],
  currentSelection: string,
  visibility?: CatalogVisibilityOptions,
): MemoryGenerationModelGroup[] {
  const choices = modelChoicesFromCatalog(catalog, visibility);
  const displayNames = modelDisplayNamesFromCatalog(catalog);
  const groups = sortProviderEntriesForSettings(
    PROVIDER_NAMES.filter(
      (provider) =>
        !isUiDisabledProvider(provider) &&
        (visibility?.includedProviders ? visibility.includedProviders.includes(provider) : true) &&
        !visibility?.hiddenProviders?.includes(provider),
    )
      .map((provider) => ({
        provider,
        label: displayProviderName(provider),
        options: (choices[provider] ?? []).map((modelId) => ({
          value: encodeProviderModelSelection(provider, modelId),
          label: resolveModelDisplayLabel(provider, modelId, displayNames),
          title: modelId,
        })),
      }))
      .filter((group) => group.options.length > 0),
  );

  const current = currentSelection.trim();
  if (!current) return groups;
  const hasCurrent = groups.some((group) =>
    group.options.some((option) => option.value === current),
  );
  if (hasCurrent) return groups;

  const parsed = decodeProviderModelSelection(current);
  if (parsed && isProviderUnsupportedOnDesktop(parsed.provider)) return groups;
  const customOption = parsed
    ? {
        value: current,
        label: `${resolveModelDisplayLabel(parsed.provider, parsed.modelId, displayNames)} (custom)`,
        title: parsed.modelId,
      }
    : { value: current, label: `${current} (custom)`, title: current };
  if (parsed) {
    const existingGroup = groups.find((group) => group.provider === parsed.provider);
    if (existingGroup) {
      existingGroup.options = [customOption, ...existingGroup.options];
      return groups;
    }
    return sortProviderEntriesForSettings([
      ...groups,
      {
        provider: parsed.provider,
        label: displayProviderName(parsed.provider),
        options: [customOption],
      },
    ]);
  }

  const fallbackGroup = groups[0];
  if (fallbackGroup) {
    fallbackGroup.options = [customOption, ...fallbackGroup.options];
    return groups;
  }
  return [{ provider: "google", label: "Custom", options: [customOption] }];
}

function relativeTime(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;

  if (diffMs < 60_000) return "just now";

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(diffMs / 86_400_000);
  if (days === 1) return "yesterday";

  const date = new Date(isoString);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function futureRelativeTime(isoString: string): string {
  const diffMs = new Date(isoString).getTime() - Date.now();
  if (diffMs <= 0) return "now";

  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 60) return `in ${minutes}m`;

  const hours = Math.ceil(diffMs / 3_600_000);
  if (hours < 24) return `in ${hours}h`;

  const days = Math.ceil(diffMs / 86_400_000);
  return `in ${days}d`;
}

export function MemoryPage() {
  const desktopFeatures = useAppStore((s) => s.desktopFeatureFlags);
  const workspacePickerEnabled = desktopFeatures.workspacePicker !== false;
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const workspaceRuntimeById = useAppStore((s) => s.workspaceRuntimeById);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);

  const requestWorkspaceMemories = useAppStore((s) => s.requestWorkspaceMemories);
  const upsertWorkspaceMemory = useAppStore((s) => s.upsertWorkspaceMemory);
  const deleteWorkspaceMemory = useAppStore((s) => s.deleteWorkspaceMemory);
  const setWorkspaceAdvancedMemory = useAppStore((s) => s.setWorkspaceAdvancedMemory);
  const setWorkspaceMemoryGenerationModel = useAppStore((s) => s.setWorkspaceMemoryGenerationModel);
  const requestSkillImprovementStatus = useAppStore((s) => s.requestSkillImprovementStatus);
  const runSkillImprovement = useAppStore((s) => s.runSkillImprovement);
  const restoreSkillImprovement = useAppStore((s) => s.restoreSkillImprovement);
  const setWorkspaceSkillImprovementEnabled = useAppStore(
    (s) => s.setWorkspaceSkillImprovementEnabled,
  );
  const setWorkspaceSkillImprovementModel = useAppStore((s) => s.setWorkspaceSkillImprovementModel);
  const setWorkspaceSkillImprovementScope = useAppStore((s) => s.setWorkspaceSkillImprovementScope);
  const setWorkspaceSkillImprovementExcludedSkills = useAppStore(
    (s) => s.setWorkspaceSkillImprovementExcludedSkills,
  );
  const providerCatalog = useAppStore((s) => s.providerCatalog);
  const providerConnected = useAppStore((s) => s.providerConnected);
  const providerStatusByName = useAppStore((s) => s.providerStatusByName);
  const providerUiState = useAppStore((s) => s.providerUiState);

  const { targets: memoryTargets, activeTarget } = useMemo(
    () => resolveMemoryTargets(workspaces, selectedWorkspaceId),
    [workspaces, selectedWorkspaceId],
  );
  const runtime = activeTarget ? workspaceRuntimeById[activeTarget.workspaceId] : null;
  const memories = runtime?.memories ?? [];
  const memoriesLoading = runtime?.memoriesLoading ?? false;

  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === activeTarget?.workspaceId) ?? null,
    [workspaces, activeTarget?.workspaceId],
  );
  // Prefer the live control-session config (server's effective setting) over the
  // persisted workspace record so the toggle never disagrees with the server.
  const liveSessionConfig = runtime?.controlSessionConfig ?? null;
  const advancedMemoryEnabled =
    liveSessionConfig?.advancedMemory ?? activeWorkspace?.defaultAdvancedMemory ?? false;
  const memoryGenerationModel = liveSessionConfig
    ? (liveSessionConfig.memoryGenerationModel ?? "")
    : (activeWorkspace?.defaultMemoryGenerationModel ?? "");
  const MEMORY_MODEL_DEFAULT_VALUE = "__default__";
  const fallbackMemoryModelProvider =
    activeWorkspace?.defaultProvider &&
    (PROVIDER_NAMES as readonly string[]).includes(activeWorkspace.defaultProvider)
      ? activeWorkspace.defaultProvider
      : undefined;
  const memoryGenerationModelSelection =
    resolveMemoryGenerationModelSelection(memoryGenerationModel, fallbackMemoryModelProvider) ||
    MEMORY_MODEL_DEFAULT_VALUE;
  const modelSelectorVisibility = useMemo<CatalogVisibilityOptions>(
    () => ({
      hiddenProviders: providerUiState.lmstudio.enabled ? [] : (["lmstudio"] as const),
      hiddenModelsByProvider: {
        lmstudio: providerUiState.lmstudio.hiddenModels,
      },
    }),
    [providerUiState],
  );
  const configuredModelProviders = useMemo(
    () =>
      configuredProvidersForModelChoices({
        catalog: providerCatalog,
        connected: providerConnected,
        providerStatusByName,
        visibility: modelSelectorVisibility,
      }),
    [modelSelectorVisibility, providerCatalog, providerConnected, providerStatusByName],
  );
  const generationModelGroups = useMemo(
    () =>
      buildMemoryGenerationModelGroups(
        providerCatalog,
        memoryGenerationModelSelection === MEMORY_MODEL_DEFAULT_VALUE
          ? ""
          : memoryGenerationModelSelection,
        {
          ...modelSelectorVisibility,
          includedProviders: configuredModelProviders,
        },
      ),
    [
      configuredModelProviders,
      modelSelectorVisibility,
      providerCatalog,
      memoryGenerationModelSelection,
    ],
  );
  const skillImprovementStatus = runtime?.skillImprovementStatus ?? null;
  const skillImprovementLoading = runtime?.skillImprovementLoading ?? false;
  const skillImprovementPendingActionKeys = runtime?.skillImprovementPendingActionKeys ?? {};
  const skillImprovementEnabled =
    liveSessionConfig?.skillImprovementEnabled ??
    activeWorkspace?.defaultSkillImprovementEnabled ??
    false;
  const skillImprovementModel = liveSessionConfig
    ? (liveSessionConfig.skillImprovementModel ?? "")
    : (activeWorkspace?.defaultSkillImprovementModel ?? "");
  const skillImprovementScope =
    liveSessionConfig?.skillImprovementScope ??
    activeWorkspace?.defaultSkillImprovementScope ??
    "user";
  const skillImprovementExcludedSkills =
    liveSessionConfig?.skillImprovementExcludedSkills ??
    activeWorkspace?.defaultSkillImprovementExcludedSkills ??
    [];
  const skillImprovementModelSelection =
    resolveMemoryGenerationModelSelection(skillImprovementModel, fallbackMemoryModelProvider) ||
    MEMORY_MODEL_DEFAULT_VALUE;
  const skillImprovementModelGroups = useMemo(
    () =>
      buildMemoryGenerationModelGroups(
        providerCatalog,
        skillImprovementModelSelection === MEMORY_MODEL_DEFAULT_VALUE
          ? ""
          : skillImprovementModelSelection,
        {
          ...modelSelectorVisibility,
          includedProviders: configuredModelProviders,
        },
      ),
    [
      configuredModelProviders,
      modelSelectorVisibility,
      providerCatalog,
      skillImprovementModelSelection,
    ],
  );
  const skillImprovementSkills = useMemo(
    () =>
      (skillImprovementStatus?.skills ?? [])
        .filter(
          (skill) =>
            skill.eligible &&
            (skillImprovementScope === "all" || skill.sourceKind === "user" || skill.excluded),
        )
        .sort((left, right) => left.skillName.localeCompare(right.skillName)),
    [skillImprovementScope, skillImprovementStatus?.skills],
  );
  const skillImprovementPendingJobs = skillImprovementStatus?.pendingJobs ?? [];
  const skillImprovementHistory = skillImprovementStatus?.runHistory.slice(0, 5) ?? [];
  const skillImprovementBackups = skillImprovementStatus?.backups ?? [];
  const skillImprovementBusy = skillImprovementStatus?.busy ?? false;

  const [draft, setDraft] = useState<DraftMemory>(emptyDraft);
  const [editingEntry, setEditingEntry] = useState<MemoryListEntry | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [filterScope, setFilterScope] = useState<"all" | "workspace" | "user">("all");
  const [memoryLoadRequestedAt, setMemoryLoadRequestedAt] = useState<number | null>(null);
  const [memoryLoadStalled, setMemoryLoadStalled] = useState(false);

  const [parent] = useAutoAnimate();

  const requestMemories = useCallback(
    (target: MemoryTarget) => {
      setMemoryLoadRequestedAt(Date.now());
      setMemoryLoadStalled(false);
      void requestWorkspaceMemories(target.workspaceId, { cwd: target.targetPath });
    },
    [requestWorkspaceMemories],
  );

  useEffect(() => {
    if (!activeTarget) return;
    setEditingEntry(null);
    setDraft(emptyDraft());
    setDialogOpen(false);
    // Advanced and legacy memory are mutually exclusive; don't fetch the legacy
    // SQLite list when the advanced (file-based) view is active.
    if (advancedMemoryEnabled) return;
    requestMemories(activeTarget);
  }, [activeTarget, requestMemories, advancedMemoryEnabled]);

  useEffect(() => {
    if (!activeTarget) return;
    void requestSkillImprovementStatus(activeTarget.workspaceId, { cwd: activeTarget.targetPath });
  }, [activeTarget, requestSkillImprovementStatus]);

  useEffect(() => {
    if (!memoriesLoading) {
      setMemoryLoadRequestedAt(null);
      setMemoryLoadStalled(false);
      return;
    }

    const requestedAt = memoryLoadRequestedAt ?? Date.now();
    if (memoryLoadRequestedAt === null) {
      setMemoryLoadRequestedAt(requestedAt);
    }

    if (isMemoryLoadStalled(true, requestedAt, Date.now())) {
      setMemoryLoadStalled(true);
      return;
    }

    const timer = window.setTimeout(
      () => {
        setMemoryLoadStalled(true);
      },
      Math.max(0, MEMORY_LOADING_STALL_MS - (Date.now() - requestedAt)),
    );
    return () => window.clearTimeout(timer);
  }, [memoriesLoading, memoryLoadRequestedAt]);

  const filtered =
    filterScope === "all" ? memories : memories.filter((m) => m.scope === filterScope);
  const showMemoryLoading = memoriesLoading && !memoryLoadStalled;

  const toggleExpand = (key: string) => {
    setExpandedIds((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const entryKey = (entry: MemoryListEntry) => `${entry.scope}:${entry.id}`;

  const openCreateDialog = () => {
    setEditingEntry(null);
    setDraft(emptyDraft());
    setDialogOpen(true);
  };

  const openEditDialog = (entry: MemoryListEntry) => {
    setEditingEntry(entry);
    setDraft({ scope: entry.scope, id: entry.id, content: entry.content });
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingEntry(null);
    setDraft(emptyDraft());
  };

  const isDraftDirty = (): boolean => {
    if (editingEntry) {
      return (
        draft.scope !== editingEntry.scope ||
        draft.id !== editingEntry.id ||
        draft.content !== editingEntry.content
      );
    }
    const fresh = emptyDraft();
    return draft.scope !== fresh.scope || draft.id !== fresh.id || draft.content !== fresh.content;
  };

  const handleSave = () => {
    if (!activeTarget || !draft.content.trim()) return;
    const id = resolveDraftMemoryId(draft.id);
    void upsertWorkspaceMemory(activeTarget.workspaceId, draft.scope, id, draft.content.trim(), {
      cwd: activeTarget.targetPath,
    });
    closeDialog();
  };

  const handleDelete = async (entry: MemoryListEntry) => {
    if (!activeTarget) return;
    const confirmed = await confirmAction({
      title: "Delete memory",
      message: `Delete "${entry.id}"?`,
      detail: "This memory will be permanently removed.",
      kind: "warning",
      confirmLabel: "Delete",
      cancelLabel: "Cancel",
    });
    if (!confirmed) return;
    void deleteWorkspaceMemory(activeTarget.workspaceId, entry.scope, entry.id, {
      cwd: activeTarget.targetPath,
    });
  };

  const scopeLabel = (scope: "workspace" | "user") =>
    scope === "workspace"
      ? activeTarget?.kind === "chats"
        ? "Chats"
        : "This workspace"
      : "Everywhere";
  const memoryTitle = (entry: MemoryListEntry) =>
    entry.id === HOT_MEMORY_ID ? "Always include" : entry.id;
  const handleTargetChange = (targetId: string) => {
    const target = memoryTargets.find((entry) => entry.id === targetId);
    if (!target) return;
    void selectWorkspace(target.workspaceId);
  };

  const toggleExcludedSkill = (skillName: string, included: boolean) => {
    if (!activeTarget) return;
    const next = included
      ? skillImprovementExcludedSkills.filter((entry) => entry !== skillName)
      : [...skillImprovementExcludedSkills, skillName];
    void setWorkspaceSkillImprovementExcludedSkills(activeTarget.workspaceId, next, {
      cwd: activeTarget.targetPath,
    });
  };

  const handleRestoreSkill = async (skillName: string) => {
    if (!activeTarget) return;
    const confirmed = await confirmAction({
      title: "Restore skill",
      message: `Restore "${skillName}" from its pre-improvement backup?`,
      detail: "Current local changes in that skill will be replaced by the stored backup.",
      kind: "warning",
      confirmLabel: "Restore",
      cancelLabel: "Cancel",
    });
    if (!confirmed) return;
    void restoreSkillImprovement(activeTarget.workspaceId, skillName, {
      cwd: activeTarget.targetPath,
    });
  };

  return (
    <>
      <SettingsSection
        title="Advanced memory"
        description="Agent-driven memory that summarizes each turn into indexed files Cowork can recall."
      >
        <SettingsRow
          title="Enable advanced memory"
          description="Replaces the manual remembered-facts list with agent-maintained memory files."
          control={
            <Switch
              checked={advancedMemoryEnabled}
              disabled={!activeTarget}
              onCheckedChange={(value) => {
                if (!activeTarget) return;
                void setWorkspaceAdvancedMemory(activeTarget.workspaceId, value, {
                  cwd: activeTarget.targetPath,
                });
              }}
              aria-label="Advanced memory"
            />
          }
        />
        {advancedMemoryEnabled ? (
          <SettingsRow
            title="Memory generation model"
            description="Model used to summarize turns into memory files."
            control={
              <Select
                value={memoryGenerationModelSelection}
                onValueChange={(value) => {
                  if (!activeTarget) return;
                  void setWorkspaceMemoryGenerationModel(
                    activeTarget.workspaceId,
                    value === MEMORY_MODEL_DEFAULT_VALUE ? "" : value,
                    { cwd: activeTarget.targetPath },
                  );
                }}
              >
                <SelectTrigger className="max-w-72" aria-label="Memory generation model">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={MEMORY_MODEL_DEFAULT_VALUE}>Default (economical)</SelectItem>
                  {generationModelGroups.map((group) => (
                    <SelectGroup key={group.provider}>
                      <SelectLabel className="px-2 py-1.5 text-xs font-semibold">
                        {group.label}
                      </SelectLabel>
                      {group.options.map((option) => (
                        <SelectItem key={option.value} value={option.value} className="pl-6">
                          <span title={option.title}>{option.label}</span>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            }
          />
        ) : null}
      </SettingsSection>

      <SettingsSection
        title="Skill Improvement (Beta)"
        description="Uses recent skill usage to keep local skill instructions sharper over time."
      >
        <SettingsRow
          title="Enable skill improvement"
          description="Queues improvement runs after skill usage and keeps a restore backup for each changed skill."
          control={
            <Switch
              checked={skillImprovementEnabled}
              disabled={!activeTarget}
              onCheckedChange={(value) => {
                if (!activeTarget) return;
                void setWorkspaceSkillImprovementEnabled(activeTarget.workspaceId, value, {
                  cwd: activeTarget.targetPath,
                });
              }}
              aria-label="Skill improvement"
            />
          }
        />
        {skillImprovementEnabled ? (
          <>
            <SettingsRow
              title="Improvement model"
              description="Model used by the headless skill improver."
              control={
                <Select
                  value={skillImprovementModelSelection}
                  onValueChange={(value) => {
                    if (!activeTarget) return;
                    void setWorkspaceSkillImprovementModel(
                      activeTarget.workspaceId,
                      value === MEMORY_MODEL_DEFAULT_VALUE ? "" : value,
                      { cwd: activeTarget.targetPath },
                    );
                  }}
                >
                  <SelectTrigger className="max-w-72" aria-label="Skill improvement model">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={MEMORY_MODEL_DEFAULT_VALUE}>
                      Default (session model)
                    </SelectItem>
                    {skillImprovementModelGroups.map((group) => (
                      <SelectGroup key={group.provider}>
                        <SelectLabel className="px-2 py-1.5 text-xs font-semibold">
                          {group.label}
                        </SelectLabel>
                        {group.options.map((option) => (
                          <SelectItem key={option.value} value={option.value} className="pl-6">
                            <span title={option.title}>{option.label}</span>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
              }
            />
            <SettingsRow
              title="Improvement scope"
              description="Choose whether only user-authored skills or all eligible local skills can be updated."
              control={
                <Select
                  value={skillImprovementScope}
                  onValueChange={(value) => {
                    if (!activeTarget || (value !== "user" && value !== "all")) return;
                    void setWorkspaceSkillImprovementScope(activeTarget.workspaceId, value, {
                      cwd: activeTarget.targetPath,
                    });
                  }}
                >
                  <SelectTrigger className="max-w-56" aria-label="Skill improvement scope">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="user">User skills</SelectItem>
                    <SelectItem value="all">All eligible skills</SelectItem>
                  </SelectContent>
                </Select>
              }
            />
            <SettingsRow
              title="Included skills"
              description="Checked skills can be improved when they are used."
              control={
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  disabled={!activeTarget || skillImprovementLoading}
                  onClick={() =>
                    activeTarget &&
                    requestSkillImprovementStatus(activeTarget.workspaceId, {
                      cwd: activeTarget.targetPath,
                    })
                  }
                >
                  <RefreshCwIcon data-icon="inline-start" />
                  {skillImprovementLoading ? "Refreshing" : "Refresh"}
                </Button>
              }
            >
              {skillImprovementLoading && !skillImprovementStatus ? (
                <div className="rounded-md border border-dashed border-border/60 px-3 py-3 text-xs text-muted-foreground">
                  Loading eligible skills…
                </div>
              ) : skillImprovementSkills.length === 0 ? (
                <div className="rounded-md border border-dashed border-border/60 px-3 py-3 text-xs text-muted-foreground">
                  No eligible skills found for this scope.
                </div>
              ) : (
                <div className="grid max-h-48 gap-1 overflow-y-auto rounded-md border border-border/60 p-2 sm:grid-cols-2">
                  {skillImprovementSkills.map((skill) => {
                    const checkboxId = `skill-improvement-${skill.skillName.replace(/[^A-Za-z0-9_-]/g, "-")}`;
                    const checked = !skillImprovementExcludedSkills.includes(skill.skillName);
                    return (
                      <label
                        key={skill.installationId}
                        htmlFor={checkboxId}
                        className={cn(
                          "flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-xs hover:bg-muted/60",
                          checked && "bg-muted/70",
                        )}
                      >
                        <Checkbox
                          id={checkboxId}
                          checked={checked}
                          onCheckedChange={(value) =>
                            toggleExcludedSkill(skill.skillName, value === true)
                          }
                        />
                        <span className="min-w-0 flex-1 truncate">{skill.skillName}</span>
                        <span className="shrink-0 text-[10px] uppercase text-muted-foreground/70">
                          {skill.scope}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </SettingsRow>
            <SettingsRow
              title="Queued jobs"
              description={
                skillImprovementStatus?.blockReason ??
                "Queued jobs run after the debounce window or when started manually."
              }
              control={
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  disabled={
                    !activeTarget ||
                    skillImprovementBusy ||
                    !!skillImprovementPendingActionKeys["run:queued"]
                  }
                  onClick={() =>
                    activeTarget &&
                    runSkillImprovement(activeTarget.workspaceId, undefined, {
                      cwd: activeTarget.targetPath,
                    })
                  }
                >
                  <PlayIcon data-icon="inline-start" />
                  {skillImprovementPendingActionKeys["run:queued"] ? "Running" : "Run queued"}
                </Button>
              }
            >
              {skillImprovementPendingJobs.length === 0 ? (
                <div className="text-xs text-muted-foreground">No queued skill jobs.</div>
              ) : (
                <div className="space-y-2">
                  {skillImprovementPendingJobs.map((job) => (
                    <div
                      key={job.skillName}
                      className="flex flex-wrap items-center justify-between gap-2 text-xs"
                    >
                      <span className="font-medium text-foreground">{job.skillName}</span>
                      <span className="text-muted-foreground">
                        {job.usageCount} use{job.usageCount === 1 ? "" : "s"} · due{" "}
                        {futureRelativeTime(job.runAt)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </SettingsRow>
            <SettingsRow title="History" description="Most recent improvement outcomes.">
              {skillImprovementHistory.length === 0 ? (
                <div className="text-xs text-muted-foreground">No skill improvement runs yet.</div>
              ) : (
                <div className="space-y-2">
                  {skillImprovementHistory.map((entry) => (
                    <div
                      key={entry.id}
                      className="flex flex-wrap items-center justify-between gap-2 text-xs"
                    >
                      <div className="min-w-0">
                        <span className="font-medium text-foreground">{entry.skillName}</span>
                        <span className="ml-2 text-muted-foreground">{entry.message}</span>
                      </div>
                      <Badge
                        variant={entry.status === "completed" ? "default" : "secondary"}
                        className="h-5 text-[10px] uppercase"
                      >
                        {entry.status}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </SettingsRow>
            <SettingsRow
              title="Restore backups"
              description="Backups are created before a skill is changed."
            >
              {skillImprovementBackups.length === 0 ? (
                <div className="text-xs text-muted-foreground">No restore backups available.</div>
              ) : (
                <div className="space-y-2">
                  {skillImprovementBackups.map((backup) => {
                    const restoreKey = `restore:${backup.skillName}`;
                    return (
                      <div
                        key={backup.key}
                        className="flex flex-wrap items-center justify-between gap-2 text-xs"
                      >
                        <div className="min-w-0">
                          <div className="font-medium text-foreground">{backup.skillName}</div>
                          <div className="truncate text-muted-foreground">
                            Saved {relativeTime(backup.createdAt)}
                          </div>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          type="button"
                          disabled={!!skillImprovementPendingActionKeys[restoreKey]}
                          onClick={() => handleRestoreSkill(backup.skillName)}
                        >
                          <RotateCcwIcon data-icon="inline-start" />
                          {skillImprovementPendingActionKeys[restoreKey] ? "Restoring" : "Restore"}
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
            </SettingsRow>
          </>
        ) : null}
      </SettingsSection>

      {advancedMemoryEnabled && activeTarget ? (
        <>
          {workspacePickerEnabled && memoryTargets.length > 1 ? (
            <Select value={activeTarget.id} onValueChange={handleTargetChange}>
              <SelectTrigger className="max-w-48" aria-label="Memory target">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {memoryTargets.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <AdvancedMemoryPanel
            workspaceId={activeTarget.workspaceId}
            cwd={activeTarget.targetPath}
          />
        </>
      ) : (
        <>
          <SettingsSection
            title="Remembered facts"
            description="Facts Cowork keeps in mind across chats for this target."
            action={
              <>
                {workspacePickerEnabled && memoryTargets.length > 1 && activeTarget ? (
                  <Select value={activeTarget.id} onValueChange={handleTargetChange}>
                    <SelectTrigger className="max-w-48" aria-label="Memory target">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {memoryTargets.map((entry) => (
                        <SelectItem key={entry.id} value={entry.id}>
                          {entry.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}

                <div className="flex rounded-md border border-border/70 overflow-hidden">
                  {(["all", "workspace", "user"] as const).map((scope) => (
                    <Button
                      key={scope}
                      className={cn(
                        "h-auto rounded-none border-0 px-3 py-1.5 text-xs font-medium shadow-none transition-colors first:rounded-l-none last:rounded-r-none",
                        filterScope === scope
                          ? "bg-primary text-primary-foreground"
                          : "bg-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                      )}
                      onClick={() => setFilterScope(scope)}
                      type="button"
                      variant="ghost"
                    >
                      {scope === "all" ? "All" : scopeLabel(scope)}
                    </Button>
                  ))}
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  disabled={showMemoryLoading}
                  onClick={() => activeTarget && requestMemories(activeTarget)}
                >
                  {showMemoryLoading ? "Loading..." : "Refresh"}
                </Button>

                {activeTarget ? (
                  <Button variant="outline" size="sm" type="button" onClick={openCreateDialog}>
                    <PlusIcon data-icon="inline-start" />
                    Add memory
                  </Button>
                ) : null}
              </>
            }
          >
            {filtered.length === 0 ? (
              <SettingsEmptyState
                className="rounded-none border-0 bg-transparent"
                icon={<BrainIcon />}
                title={
                  memoryLoadStalled
                    ? "Still loading…"
                    : showMemoryLoading
                      ? "Loading…"
                      : "No remembered facts yet"
                }
                action={
                  memoryLoadStalled && activeTarget ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => requestMemories(activeTarget)}
                    >
                      Retry
                    </Button>
                  ) : !memoryLoadStalled && !showMemoryLoading && activeTarget ? (
                    <Button variant="outline" size="sm" onClick={openCreateDialog}>
                      Add your first memory
                    </Button>
                  ) : null
                }
              />
            ) : (
              <div ref={parent} className="divide-y divide-border/45">
                {filtered.map((entry) => {
                  const key = entryKey(entry);
                  const isExpanded = expandedIds[key] ?? false;

                  return (
                    <div key={key} className={cn(isExpanded && "bg-card/40")}>
                      <button
                        type="button"
                        className="flex w-full items-center justify-between px-4 py-3.5 text-left transition-colors hover:bg-card/60"
                        onClick={() => toggleExpand(key)}
                      >
                        <div className="flex items-center gap-3">
                          {isExpanded ? (
                            <ChevronDownIcon className="w-4 h-4 text-muted-foreground" />
                          ) : (
                            <ChevronRightIcon className="w-4 h-4 text-muted-foreground" />
                          )}
                          <span className="font-medium text-foreground text-sm">
                            {memoryTitle(entry)}
                          </span>
                          <Badge
                            variant={entry.scope === "workspace" ? "default" : "secondary"}
                            className="text-[10px] uppercase h-5"
                          >
                            {scopeLabel(entry.scope)}
                          </Badge>
                        </div>
                        <span className="text-xs text-muted-foreground/60">
                          Updated {relativeTime(entry.updatedAt)}
                        </span>
                      </button>

                      {isExpanded && (
                        <div className="px-10 pb-4 text-xs space-y-3">
                          <pre className="whitespace-pre-wrap text-muted-foreground font-sans text-[13px] leading-relaxed">
                            {entry.content}
                          </pre>
                          <div className="flex items-center gap-2">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 text-xs text-muted-foreground hover:text-foreground"
                              onClick={(event) => {
                                event.stopPropagation();
                                openEditDialog(entry);
                              }}
                            >
                              <PencilIcon className="w-3.5 h-3.5 mr-1" />
                              Edit
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 text-xs text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                              onClick={(event) => {
                                event.stopPropagation();
                                void handleDelete(entry);
                              }}
                            >
                              <Trash2Icon className="w-3.5 h-3.5 mr-1" />
                              Delete
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </SettingsSection>

          <Dialog
            open={dialogOpen}
            onOpenChange={async (open) => {
              if (!open && isDraftDirty()) {
                const confirmed = await confirmAction({
                  title: "Discard changes?",
                  message: "You have unsaved changes to this remembered fact.",
                  confirmLabel: "Discard",
                  cancelLabel: "Keep editing",
                  kind: "warning",
                  defaultAction: "cancel",
                });
                if (!confirmed) return;
              }
              if (!open) closeDialog();
            }}
          >
            <DialogContent className="flex max-h-[min(88vh,36rem)] w-[min(92vw,34rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
              <DialogHeader className="shrink-0 border-b border-border/60 px-5 py-4 pr-12">
                <DialogTitle>
                  {editingEntry ? `Edit remembered fact` : "Add remembered fact"}
                </DialogTitle>
                <DialogDescription className="sr-only">
                  Edit the remembered fact title, scope, and content.
                </DialogDescription>
              </DialogHeader>
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <label htmlFor="memory-title" className="text-xs font-medium text-foreground">
                      Title
                    </label>
                    <Input
                      id="memory-title"
                      placeholder="Optional. Leave blank to always include it."
                      value={draft.id}
                      disabled={!!editingEntry}
                      onChange={(event) =>
                        setDraft((prev) => ({ ...prev, id: event.target.value }))
                      }
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="memory-scope" className="text-xs font-medium text-foreground">
                      Scope
                    </label>
                    <Select
                      value={draft.scope}
                      disabled={!!editingEntry}
                      onValueChange={(value) =>
                        setDraft((prev) => ({ ...prev, scope: value as "workspace" | "user" }))
                      }
                    >
                      <SelectTrigger id="memory-scope" aria-label="Memory scope">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="workspace">{scopeLabel("workspace")}</SelectItem>
                        <SelectItem value="user">Everywhere</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="memory-content" className="text-xs font-medium text-foreground">
                      Content
                    </label>
                    <Textarea
                      id="memory-content"
                      placeholder="What should Cowork remember?"
                      className="h-[min(32vh,16rem)] min-h-[8rem] resize-y overflow-auto [field-sizing:fixed]"
                      value={draft.content}
                      onChange={(event) =>
                        setDraft((prev) => ({ ...prev, content: event.target.value }))
                      }
                    />
                  </div>
                </div>
              </div>
              <DialogFooter className="shrink-0 border-t border-border/60 px-5 py-4">
                <Button type="button" variant="outline" onClick={closeDialog}>
                  Cancel
                </Button>
                <Button type="button" onClick={handleSave} disabled={!draft.content.trim()}>
                  {editingEntry ? "Save changes" : "Add remembered fact"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </>
  );
}
