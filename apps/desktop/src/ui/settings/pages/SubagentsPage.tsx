import { CopyIcon, PencilIcon, PlusIcon, RefreshCcwIcon, Trash2Icon } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

import type {
  AgentProfileCatalogEntry,
  AgentProfileDefinition,
  AgentProfileScope,
} from "../../../../../../src/shared/agentProfiles";
import type { AgentRole } from "../../../../../../src/shared/agents";
import {
  OPENAI_COMPATIBLE_PROVIDER_NAMES,
  OPENAI_REASONING_EFFORT_VALUES,
} from "../../../../../../src/shared/openaiCompatibleOptions";
import { useAppStore } from "../../../app/store";
import {
  isOneOffChatWorkspace,
  type WorkspaceRecord,
  type WorkspaceRuntime,
} from "../../../app/types";
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
import { Label } from "../../../components/ui/label";
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
import {
  decodeProviderModelSelection,
  encodeProviderModelSelection,
  modelChoicesFromCatalog,
  modelDisplayNamesFromCatalog,
  resolveModelDisplayLabel,
  UI_DISABLED_PROVIDERS,
} from "../../../lib/modelChoices";
import { displayProviderName } from "../../../lib/providerDisplayNames";
import { sortProviderEntriesForSettings } from "../../../lib/providerOrdering";
import { cn } from "../../../lib/utils";
import type { ProviderName, SessionEvent } from "../../../lib/wsProtocol";
import { PROVIDER_NAMES } from "../../../lib/wsProtocol";
import { SettingsEmptyState, SettingsSection, SettingsStatusPill } from "../SettingsPrimitives";

export type DraftProfile = AgentProfileDefinition & {
  scope: AgentProfileScope;
  builtIn?: boolean;
  locked?: boolean;
  originalRef?: {
    scope: AgentProfileScope;
    id: string;
  };
};

const ROLE_LABELS: Record<AgentRole, string> = {
  default: "Default",
  explorer: "Explorer",
  research: "Research",
  worker: "Worker",
  reviewer: "Reviewer",
};

const ROLE_TOOLS: Record<AgentRole, string[]> = {
  default: [
    "bash",
    "read",
    "write",
    "edit",
    "glob",
    "grep",
    "webSearch",
    "webFetch",
    "skill",
    "memory",
    "todoWrite",
  ],
  explorer: ["bash", "read", "glob", "grep"],
  research: ["read", "webSearch", "webFetch"],
  worker: [
    "bash",
    "read",
    "write",
    "edit",
    "glob",
    "grep",
    "webSearch",
    "webFetch",
    "skill",
    "memory",
    "todoWrite",
  ],
  reviewer: ["bash", "read", "glob", "grep"],
};

const ALL_BUILT_IN_TOOLS = Array.from(new Set(Object.values(ROLE_TOOLS).flat()));
const ONE_OFF_CHAT_GLOBAL_PROFILE_NOTE =
  "One-off chats can only use global profiles. Choose Global if this subagent should be available there.";
const INHERIT_MODEL_VALUE = "__inherit_model__";
const REASONING_PROVIDER_SET = new Set<string>(OPENAI_COMPATIBLE_PROVIDER_NAMES);

type ProviderCatalogEntry = Extract<SessionEvent, { type: "provider_catalog" }>["all"][number];
type ProfileModelOption = {
  value: string;
  label: string;
};
type ProfileModelGroup = {
  provider: ProviderName;
  label: string;
  options: ProfileModelOption[];
};

function newDraft(scope: AgentProfileScope): DraftProfile {
  return {
    version: 1,
    scope,
    id: "",
    displayName: "",
    description: "",
    enabled: true,
    baseRole: "worker",
    prompt: "",
    allowedBuiltInTools: ROLE_TOOLS.worker,
    allowedMcpServers: [],
    skillNames: [],
  };
}

function draftFromEntry(entry: AgentProfileCatalogEntry): DraftProfile {
  return {
    ...entry.profile,
    scope: entry.scope,
    builtIn: entry.builtIn,
    locked: entry.locked,
    originalRef: {
      scope: entry.scope,
      id: entry.profile.id,
    },
    allowedBuiltInTools: [...entry.profile.allowedBuiltInTools],
    allowedMcpServers: [...entry.profile.allowedMcpServers],
    skillNames: [...entry.profile.skillNames],
  };
}

export function resolveSubagentProfilesWorkspace(
  workspaces: WorkspaceRecord[],
  selectedWorkspaceId: string | null,
  preferredWorkspaceId?: string | null,
): WorkspaceRecord | null {
  const choices = listSubagentProfileWorkspaces(workspaces);
  const preferred = preferredWorkspaceId
    ? (choices.find((entry) => entry.id === preferredWorkspaceId) ?? null)
    : null;
  if (preferred) return preferred;

  const selected = selectedWorkspaceId
    ? (workspaces.find((entry) => entry.id === selectedWorkspaceId) ?? null)
    : null;
  if (selected && choices.some((entry) => entry.id === selected.id)) return selected;
  return choices[0] ?? null;
}

export function listSubagentProfileWorkspaces(workspaces: WorkspaceRecord[]): WorkspaceRecord[] {
  const projectWorkspaces = workspaces.filter((entry) => !isOneOffChatWorkspace(entry));
  return projectWorkspaces.length > 0 ? projectWorkspaces : workspaces;
}

function formatWorkspaceName(workspace: WorkspaceRecord): string {
  return workspace.name.trim() || workspace.path;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function listIncludes(values: readonly string[], item: string): boolean {
  return values.includes(item);
}

function toggleList(values: readonly string[], item: string, checked: boolean): string[] {
  if (checked) return sortedUnique([...values, item]);
  return values.filter((value) => value !== item);
}

function validBuiltInToolsForProfile(selectedTools: readonly string[]): string[] {
  const selected = new Set(selectedTools);
  return ALL_BUILT_IN_TOOLS.filter((tool) => selected.has(tool));
}

export function profileModelSupportsReasoning(model: string | undefined): boolean {
  const parsed = model ? decodeProviderModelSelection(model.trim()) : null;
  return parsed ? REASONING_PROVIDER_SET.has(parsed.provider) : false;
}

export function buildProfileModelGroups(
  providerCatalog: readonly ProviderCatalogEntry[],
  currentModel?: string | null,
): { groups: ProfileModelGroup[]; customOptions: ProfileModelOption[] } {
  const modelChoices = modelChoicesFromCatalog(providerCatalog);
  const displayNames = modelDisplayNamesFromCatalog(providerCatalog);
  const current = currentModel?.trim() || "";
  const groups = sortProviderEntriesForSettings(
    PROVIDER_NAMES.filter((provider) => !UI_DISABLED_PROVIDERS.has(provider))
      .map((provider) => {
        const options = (modelChoices[provider] ?? []).map((modelId) => ({
          value: encodeProviderModelSelection(provider, modelId),
          label: resolveModelDisplayLabel(provider, modelId, displayNames),
        }));
        return {
          provider,
          label: displayProviderName(provider),
          options,
        };
      })
      .filter((group) => group.options.length > 0),
  );
  const hasCurrent = groups.some((group) =>
    group.options.some((option) => option.value === current),
  );
  if (!current || hasCurrent) {
    return { groups, customOptions: [] };
  }

  const parsed = decodeProviderModelSelection(current);
  if (!parsed) {
    return {
      groups,
      customOptions: [{ value: current, label: `${current} (custom)` }],
    };
  }

  const customOption = {
    value: current,
    label: `${resolveModelDisplayLabel(parsed.provider, parsed.modelId, displayNames)} (custom)`,
  };
  const existingGroup = groups.find((group) => group.provider === parsed.provider);
  if (existingGroup) {
    existingGroup.options = [customOption, ...existingGroup.options];
    return { groups, customOptions: [] };
  }
  return {
    groups: [
      ...groups,
      {
        provider: parsed.provider,
        label: displayProviderName(parsed.provider),
        options: [customOption],
      },
    ],
    customOptions: [],
  };
}

export function providerCatalogForSubagentWorkspace(
  runtime: WorkspaceRuntime | null,
): ProviderCatalogEntry[] {
  return runtime?.providerCatalog ?? [];
}

export async function saveAgentProfileDraft(
  draft: DraftProfile | null,
  upsertAgentProfile: (
    profile: AgentProfileDefinition & { scope: AgentProfileScope },
  ) => Promise<boolean>,
): Promise<"invalid" | "failed" | "saved"> {
  if (!draft) return "invalid";
  const id = draft.id.trim();
  const displayName = draft.displayName.trim();
  if (!id || !displayName) return "invalid";
  const model = draft.model?.trim() || undefined;
  const saved = await upsertAgentProfile({
    version: draft.version,
    id,
    displayName,
    description: draft.description.trim(),
    enabled: draft.locked ? true : draft.enabled,
    baseRole: draft.baseRole,
    prompt: draft.prompt.trim(),
    allowedBuiltInTools: validBuiltInToolsForProfile(draft.allowedBuiltInTools),
    allowedMcpServers: draft.allowedMcpServers,
    skillNames: draft.skillNames,
    model,
    reasoningEffort: profileModelSupportsReasoning(model) ? draft.reasoningEffort : undefined,
    defaultTaskType: undefined,
    defaultContextMode: undefined,
    scope: draft.scope,
  });
  return saved ? "saved" : "failed";
}

export function SubagentsPage() {
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const workspaceRuntimeById = useAppStore((s) => s.workspaceRuntimeById);
  const refreshAgentProfilesCatalog = useAppStore((s) => s.refreshAgentProfilesCatalog);
  const upsertAgentProfile = useAppStore((s) => s.upsertAgentProfile);
  const deleteAgentProfile = useAppStore((s) => s.deleteAgentProfile);
  const copyAgentProfile = useAppStore((s) => s.copyAgentProfile);
  const requestWorkspaceMcpServers = useAppStore((s) => s.requestWorkspaceMcpServers);
  const refreshSkillsCatalog = useAppStore((s) => s.refreshSkillsCatalog);
  const refreshProviderStatus = useAppStore((s) => s.refreshProviderStatus);

  const workspaceChoices = useMemo(() => listSubagentProfileWorkspaces(workspaces), [workspaces]);
  const [profileWorkspaceId, setProfileWorkspaceId] = useState<string | null>(null);
  const workspace = useMemo(
    () => resolveSubagentProfilesWorkspace(workspaces, selectedWorkspaceId, profileWorkspaceId),
    [profileWorkspaceId, selectedWorkspaceId, workspaces],
  );
  const runtime = workspace ? workspaceRuntimeById[workspace.id] : null;
  const catalog = runtime?.agentProfilesCatalog ?? null;
  const providerCatalog = providerCatalogForSubagentWorkspace(runtime);
  const profilesLoading = runtime?.agentProfilesLoading ?? false;
  const [scope, setScope] = useState<AgentProfileScope>("workspace");
  const [draft, setDraft] = useState<DraftProfile | null>(null);
  const [idTouched, setIdTouched] = useState(false);

  useEffect(() => {
    const nextWorkspace = resolveSubagentProfilesWorkspace(
      workspaces,
      selectedWorkspaceId,
      profileWorkspaceId,
    );
    const nextWorkspaceId = nextWorkspace?.id ?? null;
    if (nextWorkspaceId !== profileWorkspaceId) {
      setProfileWorkspaceId(nextWorkspaceId);
    }
  }, [profileWorkspaceId, selectedWorkspaceId, workspaces]);

  useEffect(() => {
    if (!workspace) return;
    void refreshAgentProfilesCatalog(workspace.id);
    void requestWorkspaceMcpServers(workspace.id);
    void refreshSkillsCatalog(workspace.id);
    void refreshProviderStatus({ workspaceId: workspace.id });
  }, [
    workspace?.id,
    workspace,
    refreshAgentProfilesCatalog,
    requestWorkspaceMcpServers,
    refreshSkillsCatalog,
    refreshProviderStatus,
  ]);

  const profileRows = useMemo(
    () =>
      (catalog?.profiles ?? [])
        .filter((entry) => entry.scope === scope)
        .sort((left, right) => left.profile.displayName.localeCompare(right.profile.displayName)),
    [catalog?.profiles, scope],
  );

  const mcpServerNames = useMemo(
    () => sortedUnique((runtime?.mcpServers ?? []).map((server) => server.name)),
    [runtime?.mcpServers],
  );
  const skillNames = useMemo(
    () =>
      sortedUnique(
        (runtime?.skillsCatalog?.effectiveSkills ?? runtime?.skills ?? [])
          .filter((skill) => skill.enabled !== false)
          .map((skill) => skill.name),
      ),
    [runtime?.skills, runtime?.skillsCatalog?.effectiveSkills],
  );

  const startCreate = () => {
    setIdTouched(false);
    setDraft(newDraft(scope));
  };

  const saveDraft = async () => {
    if (!workspace) return;
    const result = await saveAgentProfileDraft(draft, (profile) =>
      upsertAgentProfile(profile, workspace.id),
    );
    if (result === "saved") setDraft(null);
  };
  const copyProfile = async (entry: AgentProfileCatalogEntry) => {
    if (!workspace) return;
    const targetScope: AgentProfileScope = entry.scope === "workspace" ? "global" : "workspace";
    const copied = await copyAgentProfile(
      {
        sourceRef: `${entry.scope}:${entry.profile.id}`,
        targetScope,
      },
      workspace.id,
    );
    if (copied) setScope(targetScope);
  };

  if (!workspace) {
    return (
      <SettingsEmptyState
        title="No workspace selected"
        description="Select or add a workspace to manage subagent profiles."
      />
    );
  }

  return (
    <div className="space-y-5">
      <SettingsSection
        title="Subagents"
        description="Create reusable child-agent profiles for focused work."
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void refreshAgentProfilesCatalog(workspace.id)}
              aria-label="Refresh profiles"
            >
              <RefreshCcwIcon />
            </Button>
            <Button size="sm" onClick={startCreate}>
              <PlusIcon data-icon="inline-start" />
              New
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4 px-4 py-4">
          <div className="flex flex-col gap-2">
            <div className="grid w-full max-w-sm grid-cols-2 rounded-md border border-border/60 bg-muted/25 p-1">
              {(["workspace", "global"] as const).map((value) => (
                <Button
                  key={value}
                  variant={scope === value ? "secondary" : "ghost"}
                  size="sm"
                  className="h-8"
                  onClick={() => setScope(value)}
                >
                  {value === "workspace" ? "Workspace" : "Global"}
                </Button>
              ))}
            </div>
            <p className="max-w-2xl text-xs text-muted-foreground">
              {ONE_OFF_CHAT_GLOBAL_PROFILE_NOTE}
            </p>
          </div>

          <WorkspaceTargetPicker
            workspaces={workspaceChoices}
            value={workspace?.id ?? ""}
            onValueChange={setProfileWorkspaceId}
          />

          {runtime?.agentProfilesError ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {runtime.agentProfilesError}
            </div>
          ) : null}

          {catalog?.diagnostics.length ? (
            <div className="space-y-2">
              {catalog.diagnostics.map((diagnostic) => (
                <div
                  key={`${diagnostic.scope}:${diagnostic.path}`}
                  className="rounded-md border border-warning/35 bg-warning/10 px-3 py-2 text-xs text-warning-foreground"
                >
                  {diagnostic.message}
                </div>
              ))}
            </div>
          ) : null}

          {profilesLoading && !catalog ? (
            <SettingsEmptyState
              title="Loading profiles"
              description="Refreshing the subagent profile catalog."
            />
          ) : profileRows.length === 0 ? (
            <SettingsEmptyState
              title={
                scope === "workspace" && workspace
                  ? `No profiles in ${formatWorkspaceName(workspace)}`
                  : `No ${scope} profiles`
              }
              description="Create a profile to make it available through spawnAgent(profileRef)."
              action={
                <Button size="sm" onClick={startCreate}>
                  <PlusIcon data-icon="inline-start" />
                  Create
                </Button>
              }
            />
          ) : (
            <div className="grid gap-2">
              {profileRows.map((entry) => (
                <ProfileRow
                  key={`${entry.scope}:${entry.profile.id}`}
                  entry={entry}
                  onEdit={() => {
                    setIdTouched(true);
                    setDraft(draftFromEntry(entry));
                  }}
                  onCopy={() => void copyProfile(entry)}
                  onDelete={() =>
                    void deleteAgentProfile(entry.scope, entry.profile.id, workspace.id)
                  }
                />
              ))}
            </div>
          )}
        </div>
      </SettingsSection>

      <ProfileDialog
        draft={draft}
        setDraft={setDraft}
        idTouched={idTouched}
        setIdTouched={setIdTouched}
        mcpServerNames={mcpServerNames}
        skillNames={skillNames}
        providerCatalog={providerCatalog}
        workspace={workspace}
        workspaceChoices={workspaceChoices}
        onWorkspaceChange={setProfileWorkspaceId}
        onSave={() => void saveDraft()}
      />
    </div>
  );
}

function WorkspaceTargetPicker({
  workspaces,
  value,
  onValueChange,
  disabled = false,
}: {
  workspaces: WorkspaceRecord[];
  value: string;
  onValueChange: (workspaceId: string) => void;
  disabled?: boolean;
}) {
  const selectedWorkspace = workspaces.find((entry) => entry.id === value) ?? workspaces[0] ?? null;
  if (!selectedWorkspace) return null;

  return (
    <div className="grid gap-3 rounded-md border border-border/60 bg-background/55 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(220px,320px)] sm:items-center">
      <div className="flex min-w-0 flex-col gap-1">
        <Label className="text-xs text-muted-foreground">Profile workspace</Label>
        <div className="truncate text-sm font-medium">{formatWorkspaceName(selectedWorkspace)}</div>
        <div className="truncate text-xs text-muted-foreground">{selectedWorkspace.path}</div>
      </div>
      <Select
        value={selectedWorkspace.id}
        disabled={disabled || workspaces.length <= 1}
        onValueChange={onValueChange}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {workspaces.map((workspace) => (
              <SelectItem key={workspace.id} value={workspace.id}>
                {formatWorkspaceName(workspace)}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}

function ProfileRow({
  entry,
  onEdit,
  onCopy,
  onDelete,
}: {
  entry: AgentProfileCatalogEntry;
  onEdit: () => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  const ref = `${entry.scope}:${entry.profile.id}`;
  return (
    <div className="grid gap-3 rounded-lg border border-border/60 bg-background/55 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <div className="truncate text-sm font-medium">{entry.profile.displayName}</div>
          <SettingsStatusPill tone={entry.profile.enabled ? "success" : "neutral"}>
            {entry.profile.enabled ? "Enabled" : "Disabled"}
          </SettingsStatusPill>
          {entry.builtIn ? <SettingsStatusPill>Built-in</SettingsStatusPill> : null}
          {entry.locked ? <SettingsStatusPill>Main</SettingsStatusPill> : null}
          {entry.shadowed ? <SettingsStatusPill tone="warning">Shadowed</SettingsStatusPill> : null}
          {entry.effective && entry.profile.enabled ? (
            <SettingsStatusPill>Effective</SettingsStatusPill>
          ) : null}
        </div>
        <div className="text-xs text-muted-foreground">
          <code>{ref}</code> · {ROLE_LABELS[entry.profile.baseRole]}
          {entry.profile.model ? ` · ${entry.profile.model}` : ""}
        </div>
        {entry.profile.description ? (
          <div className="line-clamp-2 text-xs text-muted-foreground">
            {entry.profile.description}
          </div>
        ) : null}
      </div>
      <div className="flex items-center justify-end gap-1">
        <Button variant="ghost" size="icon" aria-label="Edit profile" onClick={onEdit}>
          <PencilIcon />
        </Button>
        <Button variant="ghost" size="icon" aria-label="Copy profile" onClick={onCopy}>
          <CopyIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Delete profile"
          disabled={entry.builtIn && !entry.path}
          onClick={onDelete}
        >
          <Trash2Icon />
        </Button>
      </div>
    </div>
  );
}

export function ProfileDialog({
  draft,
  setDraft,
  idTouched,
  setIdTouched,
  mcpServerNames,
  skillNames,
  providerCatalog = [],
  workspace,
  workspaceChoices,
  onWorkspaceChange,
  onSave,
}: {
  draft: DraftProfile | null;
  setDraft: (draft: DraftProfile | null) => void;
  idTouched: boolean;
  setIdTouched: (value: boolean) => void;
  mcpServerNames: string[];
  skillNames: string[];
  providerCatalog?: ProviderCatalogEntry[];
  workspace: WorkspaceRecord | null;
  workspaceChoices: WorkspaceRecord[];
  onWorkspaceChange: (workspaceId: string) => void;
  onSave: () => void;
}) {
  const tools = ALL_BUILT_IN_TOOLS;
  const { groups: modelGroups, customOptions } = useMemo(
    () => buildProfileModelGroups(providerCatalog, draft?.model),
    [draft?.model, providerCatalog],
  );
  const modelSupportsReasoning = profileModelSupportsReasoning(draft?.model);
  const canSave = !!draft?.id.trim() && !!draft.displayName.trim();
  const editingExisting = draft?.originalRef !== undefined;
  const disableEnabledSwitch = draft?.locked === true;

  return (
    <Dialog open={draft !== null} onOpenChange={(open) => !open && setDraft(null)}>
      <DialogContent className="max-h-[86vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editingExisting ? "Edit subagent" : "New subagent"}</DialogTitle>
          <DialogDescription className="sr-only">Configure the subagent profile.</DialogDescription>
        </DialogHeader>
        {draft ? (
          <div className="flex flex-col gap-5 py-2">
            <div className="flex flex-col gap-2">
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Scope">
                  <Select
                    value={draft.scope}
                    disabled={editingExisting}
                    onValueChange={(value) =>
                      setDraft({ ...draft, scope: value as AgentProfileScope })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="workspace">Workspace</SelectItem>
                        <SelectItem value="global">Global</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Base role">
                  <Select
                    value={draft.baseRole}
                    onValueChange={(value) => {
                      const baseRole = value as AgentRole;
                      setDraft({
                        ...draft,
                        baseRole,
                        allowedBuiltInTools: ROLE_TOOLS[baseRole],
                      });
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {Object.entries(ROLE_LABELS).map(([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Enabled">
                  <div className="flex h-9 items-center">
                    <Switch
                      checked={draft.locked ? true : draft.enabled}
                      disabled={disableEnabledSwitch}
                      onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
                    />
                  </div>
                </Field>
              </div>

              <p className="text-xs text-muted-foreground">{ONE_OFF_CHAT_GLOBAL_PROFILE_NOTE}</p>
            </div>

            {draft.scope === "workspace" && workspace ? (
              <WorkspaceTargetPicker
                workspaces={workspaceChoices}
                value={workspace.id}
                onValueChange={onWorkspaceChange}
                disabled={editingExisting}
              />
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Display name">
                <Input
                  value={draft.displayName}
                  onChange={(event) => {
                    const displayName = event.target.value;
                    setDraft({
                      ...draft,
                      displayName,
                      id: idTouched ? draft.id : slugify(displayName),
                    });
                  }}
                />
              </Field>
              <Field label="Profile id">
                <Input
                  value={draft.id}
                  disabled={editingExisting}
                  onChange={(event) => {
                    setIdTouched(true);
                    setDraft({ ...draft, id: slugify(event.target.value) });
                  }}
                />
              </Field>
            </div>

            <Field label="Description">
              <Input
                value={draft.description}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              />
            </Field>

            <Field label="Prompt">
              <Textarea
                value={draft.prompt}
                className="min-h-32"
                placeholder="Add instructions this subagent should follow."
                onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                Profile instructions are appended after the base role prompt.
              </p>
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Model target">
                <Select
                  value={draft.model?.trim() || INHERIT_MODEL_VALUE}
                  onValueChange={(value) => {
                    const model = value === INHERIT_MODEL_VALUE ? undefined : value;
                    setDraft({
                      ...draft,
                      model,
                      reasoningEffort: profileModelSupportsReasoning(model)
                        ? draft.reasoningEffort
                        : undefined,
                    });
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Inherit parent model" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    <SelectGroup>
                      <SelectItem value={INHERIT_MODEL_VALUE}>Inherit parent model</SelectItem>
                    </SelectGroup>
                    {customOptions.length > 0 ? (
                      <SelectGroup>
                        <SelectLabel>Current target</SelectLabel>
                        {customOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ) : null}
                    {modelGroups.map((group) => (
                      <SelectGroup key={group.provider}>
                        <SelectLabel>{group.label}</SelectLabel>
                        {group.options.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {modelSupportsReasoning ? (
                <Field label="Reasoning">
                  <Select
                    value={draft.reasoningEffort ?? "inherit"}
                    onValueChange={(value) =>
                      setDraft({
                        ...draft,
                        reasoningEffort:
                          value === "inherit"
                            ? undefined
                            : (value as DraftProfile["reasoningEffort"]),
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="inherit">Inherit</SelectItem>
                        {OPENAI_REASONING_EFFORT_VALUES.map((effort) => (
                          <SelectItem key={effort} value={effort}>
                            {effort}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              ) : null}
            </div>

            <Checklist
              title="Built-in tools"
              values={tools}
              selected={draft.allowedBuiltInTools}
              emptyLabel="No built-in tools are available."
              onChange={(item, checked) =>
                setDraft({
                  ...draft,
                  allowedBuiltInTools: toggleList(draft.allowedBuiltInTools, item, checked),
                })
              }
            />
            <Checklist
              title="MCP servers"
              values={mcpServerNames}
              selected={draft.allowedMcpServers}
              emptyLabel="No MCP servers configured."
              onChange={(item, checked) =>
                setDraft({
                  ...draft,
                  allowedMcpServers: toggleList(draft.allowedMcpServers, item, checked),
                })
              }
            />
            <Checklist
              title="Skills"
              values={skillNames}
              selected={draft.skillNames}
              emptyLabel="No enabled skills available."
              onChange={(item, checked) =>
                setDraft({
                  ...draft,
                  skillNames: toggleList(draft.skillNames, item, checked),
                })
              }
            />
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => setDraft(null)}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={!canSave}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function Checklist({
  title,
  values,
  selected,
  emptyLabel,
  onChange,
}: {
  title: string;
  values: string[];
  selected: string[];
  emptyLabel: string;
  onChange: (item: string, checked: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Label className="text-xs text-muted-foreground">{title}</Label>
        <Badge variant="outline" className="rounded-md text-[11px]">
          {selected.length}
        </Badge>
      </div>
      {values.length === 0 ? (
        <div className="rounded-md border border-dashed border-border/60 px-3 py-3 text-xs text-muted-foreground">
          {emptyLabel}
        </div>
      ) : (
        <div className="grid max-h-44 gap-1 overflow-y-auto rounded-md border border-border/60 p-2 sm:grid-cols-2">
          {values.map((value) => {
            const checkboxId = `subagent-profile-${slugify(title)}-${slugify(value)}`;
            return (
              <label
                key={value}
                htmlFor={checkboxId}
                className={cn(
                  "flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-xs hover:bg-muted/60",
                  listIncludes(selected, value) && "bg-muted/70",
                )}
              >
                <Checkbox
                  id={checkboxId}
                  checked={listIncludes(selected, value)}
                  onCheckedChange={(checked) => onChange(value, checked === true)}
                />
                <span className="truncate">{value}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
