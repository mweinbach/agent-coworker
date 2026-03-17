import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";

import { defaultModelForProvider } from "@cowork/providers/catalog";

import {
  getWorkspaceReasoningEffort,
  getWorkspaceReasoningSummary,
  getWorkspaceTextVerbosity,
  mergeWorkspaceProviderOptions,
  REASONING_EFFORT_VALUES,
  REASONING_SUMMARY_VALUES,
  TEXT_VERBOSITY_VALUES,
  type OpenAICompatibleProviderName,
  type ReasoningEffortValue,
  type ReasoningSummaryValue,
  type TextVerbosityValue,
} from "../../../app/openaiCompatibleProviderOptions";
import {
  normalizeWorkspaceUserProfile,
  type WorkspaceRecord,
  type WorkspaceUserProfile,
} from "../../../app/types";
import { useAppStore } from "../../../app/store";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { Checkbox } from "../../../components/ui/checkbox";
import { Input } from "../../../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { Textarea } from "../../../components/ui/textarea";
import { confirmAction } from "../../../lib/desktopCommands";
import {
  availableProvidersFromCatalog,
  modelChoicesFromCatalog,
  modelOptionsFromCatalog,
  UI_DISABLED_PROVIDERS,
} from "../../../lib/modelChoices";
import type { ProviderName } from "../../../lib/wsProtocol";
import { PROVIDER_NAMES } from "../../../lib/wsProtocol";
import { cn } from "../../../lib/utils";

function displayProviderName(provider: ProviderName): string {
  const names: Partial<Record<ProviderName, string>> = {
    google: "Google",
    openai: "OpenAI",
    anthropic: "Anthropic",
    baseten: "Baseten",
    together: "Together AI",
    nvidia: "NVIDIA",
    "opencode-go": "OpenCode Go",
    "opencode-zen": "OpenCode Zen",
    "codex-cli": "Codex CLI",
  };
  return names[provider] ?? provider;
}

function toBoolean(checked: boolean | "indeterminate"): boolean {
  return checked === true;
}

function updateProviderOption(
  providerOptions: ReturnType<typeof mergeWorkspaceProviderOptions>,
  provider: OpenAICompatibleProviderName,
  patch: {
    reasoningEffort?: ReasoningEffortValue;
    reasoningSummary?: ReasoningSummaryValue;
    textVerbosity?: TextVerbosityValue;
  }
) {
  return mergeWorkspaceProviderOptions(providerOptions, {
    [provider]: patch,
  });
}

type ChildTargetGroup = {
  provider: ProviderName;
  refs: string[];
};

function childTargetGroupsFromCatalog(
  catalog: Parameters<typeof modelChoicesFromCatalog>[0],
  preserveRefs: readonly string[],
): ChildTargetGroup[] {
  const choices = modelChoicesFromCatalog(catalog);
  const preserveByProvider = new Map<ProviderName, Set<string>>();
  for (const ref of preserveRefs) {
    const colonIndex = ref.indexOf(":");
    if (colonIndex <= 0) continue;
    const provider = ref.slice(0, colonIndex) as ProviderName;
    const model = ref.slice(colonIndex + 1).trim();
    if (!model || UI_DISABLED_PROVIDERS.has(provider)) continue;
    const set = preserveByProvider.get(provider) ?? new Set<string>();
    set.add(model);
    preserveByProvider.set(provider, set);
  }

  return PROVIDER_NAMES
    .filter((provider) => !UI_DISABLED_PROVIDERS.has(provider))
    .map((provider) => {
      const models = new Set(choices[provider] ?? []);
      for (const model of preserveByProvider.get(provider) ?? []) {
        models.add(model);
      }
      return {
        provider,
        refs: [...models].map((model) => `${provider}:${model}`),
      };
    })
    .filter((group) => group.refs.length > 0);
}

function childTargetLabel(ref: string): string {
  const colonIndex = ref.indexOf(":");
  if (colonIndex <= 0) return ref;
  return ref.slice(colonIndex + 1);
}

type OpenAiCompatibleModelSettingsCardProps = {
  workspace: Pick<WorkspaceRecord, "id" | "providerOptions">;
  updateWorkspaceDefaults: (
    workspaceId: string,
    patch: { providerOptions?: ReturnType<typeof mergeWorkspaceProviderOptions> },
  ) => Promise<unknown> | void;
  providerStatusByName: Record<string, any>;
};

export function OpenAiCompatibleModelSettingsCard({
  workspace,
  updateWorkspaceDefaults,
  providerStatusByName,
}: OpenAiCompatibleModelSettingsCardProps) {
  const openAiVerbosity = getWorkspaceTextVerbosity(workspace.providerOptions, "openai");
  const openAiReasoningEffort = getWorkspaceReasoningEffort(workspace.providerOptions, "openai");
  const openAiReasoningSummary = getWorkspaceReasoningSummary(workspace.providerOptions, "openai");
  const codexVerbosity = getWorkspaceTextVerbosity(workspace.providerOptions, "codex-cli");
  const codexReasoningEffort = getWorkspaceReasoningEffort(workspace.providerOptions, "codex-cli");
  const codexReasoningSummary = getWorkspaceReasoningSummary(workspace.providerOptions, "codex-cli");

  const sections = ([
    {
      key: "openai",
      label: "OpenAI API",
      verbosity: openAiVerbosity,
      reasoningEffort: openAiReasoningEffort,
      reasoningSummary: openAiReasoningSummary,
    },
    {
      key: "codex-cli",
      label: "Codex CLI",
      verbosity: codexVerbosity,
      reasoningEffort: codexReasoningEffort,
      reasoningSummary: codexReasoningSummary,
    },
  ] as const).filter((section) => {
    const status = providerStatusByName[section.key];
    return status?.verified || status?.authorized;
  });

  if (sections.length === 0) return null;

  return (
    <Card className="border-border/80 bg-card/85">
      <CardHeader>
        <CardTitle>OpenAI-Compatible Model Settings</CardTitle>
        <CardDescription>
          Workspace defaults for OpenAI API and Codex CLI responses models.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 md:grid-cols-2">
        {sections.map((section) => (
          <div key={section.key} className="space-y-4 rounded-xl border border-border/70 p-4">
            <div className="space-y-1">
              <div className="text-sm font-medium text-foreground">{section.label}</div>
              <div className="text-xs text-muted-foreground">
                Applies when this workspace runs on {section.label}.
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium text-foreground">Verbosity</div>
              <Select
                value={section.verbosity}
                onValueChange={(value) => {
                  void updateWorkspaceDefaults(workspace.id, {
                    providerOptions: updateProviderOption(workspace.providerOptions, section.key, {
                      textVerbosity: value as TextVerbosityValue,
                    }),
                  });
                }}
              >
                <SelectTrigger aria-label={`${section.label} verbosity`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TEXT_VERBOSITY_VALUES.map((entry) => (
                    <SelectItem key={entry} value={entry}>
                      {entry}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium text-foreground">Reasoning effort</div>
              <Select
                value={section.reasoningEffort}
                onValueChange={(value) => {
                  void updateWorkspaceDefaults(workspace.id, {
                    providerOptions: updateProviderOption(workspace.providerOptions, section.key, {
                      reasoningEffort: value as ReasoningEffortValue,
                    }),
                  });
                }}
              >
                <SelectTrigger aria-label={`${section.label} reasoning effort`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REASONING_EFFORT_VALUES.map((entry) => (
                    <SelectItem key={entry} value={entry}>
                      {entry}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium text-foreground">Reasoning summary</div>
              <Select
                value={section.reasoningSummary}
                onValueChange={(value) => {
                  void updateWorkspaceDefaults(workspace.id, {
                    providerOptions: updateProviderOption(workspace.providerOptions, section.key, {
                      reasoningSummary: value as ReasoningSummaryValue,
                    }),
                  });
                }}
              >
                <SelectTrigger aria-label={`${section.label} reasoning summary`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REASONING_SUMMARY_VALUES.map((entry) => (
                    <SelectItem key={entry} value={entry}>
                      {entry}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

type WorkspaceUserProfileCardProps = {
  workspace: Pick<WorkspaceRecord, "id" | "userName" | "userProfile">;
  updateWorkspaceDefaults: (
    workspaceId: string,
    patch: { userName?: string; userProfile?: Partial<WorkspaceUserProfile> },
  ) => Promise<unknown> | void;
};

function buildUserProfileDraft(workspace: WorkspaceUserProfileCardProps["workspace"]) {
  const profile = normalizeWorkspaceUserProfile(workspace.userProfile);
  return {
    userName: workspace.userName ?? "",
    instructions: profile.instructions,
    work: profile.work,
    details: profile.details,
  };
}

export function WorkspaceUserProfileCard({
  workspace,
  updateWorkspaceDefaults,
}: WorkspaceUserProfileCardProps) {
  const [draft, setDraft] = useState(() => buildUserProfileDraft(workspace));
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    setDraft(buildUserProfileDraft(workspace));
    setSaveSuccess(false);
  }, [
    workspace.id,
    workspace.userName,
    workspace.userProfile?.instructions,
    workspace.userProfile?.work,
    workspace.userProfile?.details,
  ]);

  const currentProfile = normalizeWorkspaceUserProfile(workspace.userProfile);
  const isDirty = 
    draft.userName !== (workspace.userName ?? "") ||
    draft.instructions !== currentProfile.instructions ||
    draft.work !== currentProfile.work ||
    draft.details !== currentProfile.details;

  const handleSave = async () => {
    if (!isDirty) return;
    setSaving(true);
    setSaveSuccess(false);
    
    try {
      await updateWorkspaceDefaults(workspace.id, {
        userName: draft.userName.trim(),
        userProfile: {
          instructions: draft.instructions.trim(),
          work: draft.work.trim(),
          details: draft.details.trim(),
        }
      });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="border-border/80 bg-card/85">
      <CardHeader>
        <CardTitle>How Cowork should understand you in this workspace</CardTitle>
        <CardDescription>
          Workspace-specific identity and prompt context.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="text-sm font-medium text-foreground">Name</div>
          <Input
            aria-label="Workspace user name"
            autoComplete="off"
            placeholder="Name used in prompt context"
            value={draft.userName}
            onChange={(event) => {
              setDraft((current) => ({
                ...current,
                userName: event.target.value,
              }));
              setSaveSuccess(false);
            }}
          />
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium text-foreground">Role or work context</div>
          <Textarea
            aria-label="Workspace work context"
            className="min-h-24"
            placeholder="Role, team, domain, or responsibilities"
            value={draft.work}
            onChange={(event) => {
              setDraft((current) => ({
                ...current,
                work: event.target.value,
              }));
              setSaveSuccess(false);
            }}
          />
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium text-foreground">Instructions</div>
          <Textarea
            aria-label="Workspace profile instructions"
            className="min-h-24"
            placeholder="Behavior instructions the agent should follow"
            value={draft.instructions}
            onChange={(event) => {
              setDraft((current) => ({
                ...current,
                instructions: event.target.value,
              }));
              setSaveSuccess(false);
            }}
          />
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium text-foreground">Background details</div>
          <Textarea
            aria-label="Workspace profile details"
            className="min-h-24"
            placeholder="Personal or project details the agent should remember"
            value={draft.details}
            onChange={(event) => {
              setDraft((current) => ({
                ...current,
                details: event.target.value,
              }));
              setSaveSuccess(false);
            }}
          />
        </div>

        <div className="flex items-center gap-3 pt-2">
          <Button onClick={handleSave} disabled={!isDirty || saving}>
            {saving ? "Saving..." : "Save changes"}
          </Button>
          {saveSuccess && <span className="text-sm text-emerald-600">Saved successfully</span>}
        </div>
      </CardContent>
    </Card>
  );
}

export function WorkspacesPage() {
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const providerStatusByName = useAppStore((s) => s.providerStatusByName);
  const providerCatalog = useAppStore((s) => s.providerCatalog);
  const providerConnected = useAppStore((s) => s.providerConnected);
  const providerDefaultModelByProvider = useAppStore((s) => s.providerDefaultModelByProvider);

  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const removeWorkspace = useAppStore((s) => s.removeWorkspace);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const updateWorkspaceDefaults = useAppStore((s) => s.updateWorkspaceDefaults);
  const restartWorkspaceServer = useAppStore((s) => s.restartWorkspaceServer);

  const ws = useMemo(
    () => workspaces.find((w) => w.id === selectedWorkspaceId) ?? workspaces[0] ?? null,
    [selectedWorkspaceId, workspaces],
  );

  const provider = (ws?.defaultProvider ?? "google") as ProviderName;
  const model = (ws?.defaultModel ?? "").trim();
  const preferredChildModel = (ws?.defaultPreferredChildModel ?? ws?.defaultModel ?? "").trim();
  const childModelRoutingMode = ws?.defaultChildModelRoutingMode ?? "same-provider";
  const preferredChildModelRef = (ws?.defaultPreferredChildModelRef ?? `${provider}:${preferredChildModel || model}`).trim();
  const allowedChildModelRefs = ws?.defaultAllowedChildModelRefs ?? [];
  const enableMcp = ws?.defaultEnableMcp ?? true;
  const backupsEnabled = ws?.defaultBackupsEnabled ?? true;
  const yolo = ws?.yolo ?? false;

  const modelChoices = useMemo(() => modelChoicesFromCatalog(providerCatalog), [providerCatalog]);
  const availableProviders = useMemo(
    () => availableProvidersFromCatalog(providerCatalog, providerConnected, provider),
    [providerCatalog, providerConnected, provider],
  );
  const effectiveProvider = availableProviders.includes(provider) ? provider : (availableProviders[0] ?? provider);
  const curatedModels = modelChoices[effectiveProvider] ?? [];
  const modelOptions = modelOptionsFromCatalog(providerCatalog, effectiveProvider, model);
  const hasCustomModel = Boolean(model && !curatedModels.includes(model));
  const preferredChildModelOptions = modelOptionsFromCatalog(providerCatalog, effectiveProvider, preferredChildModel);
  const hasCustomChildModel = Boolean(preferredChildModel && !curatedModels.includes(preferredChildModel));
  const childTargetGroups = useMemo(
    () => childTargetGroupsFromCatalog(providerCatalog, [...allowedChildModelRefs, preferredChildModelRef]),
    [allowedChildModelRefs, preferredChildModelRef, providerCatalog],
  );
  const preferredChildTargetOptions = useMemo(() => {
    if (childModelRoutingMode === "cross-provider-allowlist") {
      return allowedChildModelRefs.includes(preferredChildModelRef)
        ? allowedChildModelRefs
        : preferredChildModelRef
          ? [preferredChildModelRef, ...allowedChildModelRefs]
          : allowedChildModelRefs;
    }
    return preferredChildModelRef ? [preferredChildModelRef] : [];
  }, [allowedChildModelRefs, childModelRoutingMode, preferredChildModelRef]);

  const [activeTab, setActiveTab] = useState<"general" | "models" | "profile" | "advanced">("general");

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">Workspaces</h1>
        <p className="text-sm text-muted-foreground">Choose a project folder and configure how the agent behaves in it.</p>
      </div>

      {workspaces.length === 0 || !ws ? (
        <Card className="border-border/80 bg-card/85">
          <CardContent className="p-8 text-center">
            <Button type="button" onClick={() => void addWorkspace()}>
              Add workspace
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="flex space-x-1 rounded-lg bg-muted p-1 border border-border/70 max-w-fit mb-2 relative">
            {(["general", "models", "profile", "advanced"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={cn(
                  "px-3 py-1.5 text-sm font-medium rounded-md transition-colors relative z-10",
                  activeTab === tab ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {activeTab === tab && (
                  <motion.div
                    layoutId="workspaces-active-tab"
                    className="absolute inset-0 bg-background shadow-sm rounded-md -z-10 border border-border/50"
                    transition={{ type: "spring", stiffness: 500, damping: 30 }}
                  />
                )}
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>

          <div className={cn("space-y-5 animate-in fade-in slide-in-from-bottom-2 duration-300", activeTab !== "general" && "hidden")}>
            <Card className="border-border/80 bg-card/85">
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <div>
                  <CardTitle>Active workspace</CardTitle>
                  <CardDescription>Selected project for this desktop session.</CardDescription>
                </div>
                <Button variant="outline" type="button" onClick={() => void addWorkspace()}>
                  Add
                </Button>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <div className="text-sm font-medium text-foreground">{ws.name}</div>
                  <div className="text-xs text-muted-foreground">{ws.path}</div>
                </div>
                {workspaces.length > 1 ? (
                  <Select value={ws.id} onValueChange={(value) => void selectWorkspace(value)}>
                    <SelectTrigger aria-label="Active workspace">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {workspaces.map((workspace) => (
                        <SelectItem key={workspace.id} value={workspace.id}>
                          {workspace.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
              </CardContent>
            </Card>

            <Card className="border-border/80 bg-card/85">
              <CardHeader>
                <CardTitle>Behavior</CardTitle>
                <CardDescription>Execution and visibility options for this workspace.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-start justify-between gap-4 max-[960px]:flex-col">
                  <div>
                    <div className="text-sm font-medium">MCP tools</div>
                    <div className="text-xs text-muted-foreground">Allow the agent to use MCP servers configured for this workspace.</div>
                  </div>
                  <Checkbox
                    checked={enableMcp}
                    aria-label="Enable MCP tools"
                    onCheckedChange={(checked) => {
                      if (!ws) return;
                      void updateWorkspaceDefaults(ws.id, { defaultEnableMcp: toBoolean(checked) });
                    }}
                  />
                </div>

                <div className="flex items-start justify-between gap-4 max-[960px]:flex-col">
                  <div>
                    <div className="text-sm font-medium">Workspace backups</div>
                    <div className="text-xs text-muted-foreground">Persist a default backup policy for new sessions in this workspace.</div>
                  </div>
                  <Checkbox
                    checked={backupsEnabled}
                    aria-label="Enable workspace backups"
                    onCheckedChange={(checked) => {
                      if (!ws) return;
                      void updateWorkspaceDefaults(ws.id, { defaultBackupsEnabled: toBoolean(checked) });
                    }}
                  />
                </div>

                <div className="flex items-start justify-between gap-4 max-[960px]:flex-col">
                  <div>
                    <div className="text-sm font-medium">Run shell commands without asking</div>
                    <div className="text-xs text-muted-foreground">Skip confirmation prompts and run shell commands immediately without review.</div>
                  </div>
                  <Checkbox
                    checked={yolo}
                    aria-label="Run shell commands without asking"
                    onCheckedChange={async (checked) => {
                      if (!ws) return;
                      const next = toBoolean(checked);
                      const confirmed = await confirmAction({
                        title: next ? "Enable auto-approve commands" : "Disable auto-approve commands",
                        message: next
                          ? "Enable auto-approve? The agent will run shell commands on your machine without asking for review first."
                          : "Disable auto-approve?",
                        detail: next ? "This is a high-risk setting. The server will restart to apply this change." : undefined,
                        confirmLabel: next ? "Enable" : "Disable",
                        cancelLabel: "Cancel",
                        kind: "warning",
                        defaultAction: "cancel",
                      });
                      if (confirmed) {
                        void updateWorkspaceDefaults(ws.id, { yolo: next }).then(() => restartWorkspaceServer(ws.id));
                      }
                    }}
                  />
                </div>
              </CardContent>
            </Card>
          </div>

          <div className={cn("space-y-5 animate-in fade-in slide-in-from-bottom-2 duration-300", activeTab !== "models" && "hidden")}>
            <Card className="border-border/80 bg-card/85">
              <CardHeader>
                <CardTitle>Model</CardTitle>
                <CardDescription>The default provider and model for new sessions in this workspace.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <div className="text-sm font-medium text-foreground">Provider</div>
                  <Select
                    value={effectiveProvider}
                    onValueChange={(value) => {
                      if (!ws) return;
                      const nextProvider = value as ProviderName;
                      if (UI_DISABLED_PROVIDERS.has(nextProvider)) return;
                      const nextDefault = providerDefaultModelByProvider[nextProvider] ?? defaultModelForProvider(nextProvider);
                      void updateWorkspaceDefaults(ws.id, {
                        defaultProvider: nextProvider,
                        defaultModel: nextDefault,
                        defaultPreferredChildModel: nextDefault,
                        defaultPreferredChildModelRef:
                          childModelRoutingMode === "same-provider"
                            ? `${nextProvider}:${nextDefault}`
                            : preferredChildModelRef,
                      });
                    }}
                  >
                    <SelectTrigger aria-label="Default provider">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {availableProviders.map((entry) => (
                        <SelectItem key={entry} value={entry}>
                          {displayProviderName(entry)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <div className="text-sm font-medium text-foreground">Primary model</div>
                  <Select
                    value={model}
                    onValueChange={(value) => {
                      if (!ws) return;
                      void updateWorkspaceDefaults(ws.id, {
                        defaultModel: value,
                        ...(childModelRoutingMode === "same-provider"
                          ? {
                              defaultPreferredChildModelRef: `${effectiveProvider}:${preferredChildModel || value}`,
                            }
                          : {}),
                      });
                    }}
                  >
                    <SelectTrigger aria-label="Default model">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {modelOptions.map((entry) => (
                        <SelectItem key={entry} value={entry}>
                          {hasCustomModel && entry === model ? `${entry} (custom)` : entry}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <div className="text-sm font-medium text-foreground">Child routing mode</div>
                  <Select
                    value={childModelRoutingMode}
                    onValueChange={(value) => {
                      if (!ws) return;
                      const nextMode = value as "same-provider" | "cross-provider-allowlist";
                      void updateWorkspaceDefaults(ws.id, {
                        defaultChildModelRoutingMode: nextMode,
                        ...(nextMode === "same-provider"
                          ? {
                              defaultPreferredChildModelRef: `${effectiveProvider}:${preferredChildModel || model}`,
                            }
                          : {}),
                      });
                    }}
                  >
                    <SelectTrigger aria-label="Child routing mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="same-provider">Same provider only</SelectItem>
                      <SelectItem value="cross-provider-allowlist">Cross-provider allowlist</SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="text-xs text-muted-foreground">
                    Cross-provider mode lets child agents target exact `provider:modelId` refs from the workspace allowlist.
                  </div>
                </div>

                {childModelRoutingMode === "same-provider" ? (
                  <div className="space-y-2">
                    <div className="text-sm font-medium text-foreground">Preferred child model</div>
                    <Select
                      value={preferredChildModel}
                      onValueChange={(value) => {
                        if (!ws) return;
                        void updateWorkspaceDefaults(ws.id, {
                          defaultPreferredChildModel: value,
                          defaultPreferredChildModelRef: `${effectiveProvider}:${value}`,
                        });
                      }}
                    >
                      <SelectTrigger aria-label="Preferred child model">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {preferredChildModelOptions.map((entry) => (
                          <SelectItem key={entry} value={entry}>
                            {hasCustomChildModel && entry === preferredChildModel ? `${entry} (custom)` : entry}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="text-xs text-muted-foreground">
                      Child agents inherit the live parent provider/model unless a spawn request overrides it. This workspace default only preselects the suggested same-provider override.
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="space-y-3">
                      <div className="text-sm font-medium text-foreground">Allowed child targets</div>
                      <div className="rounded-xl border border-border/70 p-3 space-y-3 max-h-72 overflow-auto">
                        {childTargetGroups.map((group) => (
                          <div key={group.provider} className="space-y-2">
                            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                              {displayProviderName(group.provider)}
                            </div>
                            <div className="grid gap-2 md:grid-cols-2">
                              {group.refs.map((ref) => {
                                const checked = allowedChildModelRefs.includes(ref);
                                return (
                                  <label
                                    key={ref}
                                    className="flex items-center gap-2 rounded-lg border border-border/60 px-3 py-2 text-sm"
                                  >
                                    <Checkbox
                                      checked={checked}
                                      onCheckedChange={(nextChecked) => {
                                        if (!ws) return;
                                        const nextRefs = nextChecked === true
                                          ? [...allowedChildModelRefs, ref]
                                          : allowedChildModelRefs.filter((entry) => entry !== ref);
                                        const dedupedRefs = [...new Set(nextRefs)];
                                        const nextPreferred = dedupedRefs.includes(preferredChildModelRef)
                                          ? preferredChildModelRef
                                          : (dedupedRefs[0] ?? `${effectiveProvider}:${preferredChildModel || model}`);
                                        void updateWorkspaceDefaults(ws.id, {
                                          defaultAllowedChildModelRefs: dedupedRefs,
                                          defaultPreferredChildModelRef: nextPreferred,
                                        });
                                      }}
                                      aria-label={`Allow child target ${ref}`}
                                    />
                                    <span>{childTargetLabel(ref)}</span>
                                  </label>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Explicit cross-provider child requests fall back to the live parent provider/model when the target ref is not allowlisted or the provider is disconnected.
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="text-sm font-medium text-foreground">Preferred child target</div>
                      <Select
                        value={preferredChildTargetOptions[0] ? preferredChildModelRef : ""}
                        onValueChange={(value) => {
                          if (!ws) return;
                          void updateWorkspaceDefaults(ws.id, { defaultPreferredChildModelRef: value });
                        }}
                        disabled={preferredChildTargetOptions.length === 0}
                      >
                        <SelectTrigger aria-label="Preferred child target">
                          <SelectValue placeholder={preferredChildTargetOptions.length === 0 ? "Select allowed targets first" : undefined} />
                        </SelectTrigger>
                        <SelectContent>
                          {preferredChildTargetOptions.map((entry) => (
                            <SelectItem key={entry} value={entry}>
                              {entry}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            <OpenAiCompatibleModelSettingsCard
              workspace={ws}
              updateWorkspaceDefaults={updateWorkspaceDefaults}
              providerStatusByName={providerStatusByName}
            />
            
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span>Current provider:</span>
              <Badge variant="secondary">{displayProviderName(provider)}</Badge>
              <span>Model:</span>
              <Badge variant="secondary">{model}</Badge>
              <span>Child routing:</span>
              <Badge variant="secondary">{childModelRoutingMode}</Badge>
              <span>Preferred child:</span>
              <Badge variant="secondary">{childModelRoutingMode === "same-provider" ? (preferredChildModel || model) : preferredChildModelRef}</Badge>
            </div>
          </div>

          <div className={cn("space-y-5 animate-in fade-in slide-in-from-bottom-2 duration-300", activeTab !== "profile" && "hidden")}>
            <WorkspaceUserProfileCard
              workspace={ws}
              updateWorkspaceDefaults={updateWorkspaceDefaults}
            />
          </div>

          <div className={cn("space-y-5 animate-in fade-in slide-in-from-bottom-2 duration-300", activeTab !== "advanced" && "hidden")}>
            <Card className="border-border/80 bg-card/85">
              <CardHeader>
                <CardTitle>Advanced</CardTitle>
                <CardDescription>Maintenance and destructive actions.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between gap-3 max-[960px]:items-start max-[960px]:flex-col">
                  <div>
                    <div className="text-sm font-medium">Restart server</div>
                    <div className="text-xs text-muted-foreground">Restart the workspace agent server if unresponsive.</div>
                  </div>
                  <Button variant="outline" type="button" onClick={() => void restartWorkspaceServer(ws.id)}>
                    Restart
                  </Button>
                </div>

                <div className="flex items-center justify-between gap-3 max-[960px]:items-start max-[960px]:flex-col">
                  <div>
                    <div className="text-sm font-medium">Remove workspace</div>
                    <div className="text-xs text-muted-foreground">Remove this workspace from the app. Your files on disk are not affected.</div>
                  </div>
                  <Button
                    variant="destructive"
                    type="button"
                    onClick={async () => {
                      const confirmed = await confirmAction({
                        title: "Remove workspace",
                        message: `Remove workspace "${ws.name}"?`,
                        detail: "Your files on disk will not be affected.",
                        confirmLabel: "Remove",
                        cancelLabel: "Cancel",
                        kind: "warning",
                        defaultAction: "cancel",
                      });
                      if (confirmed) {
                        void removeWorkspace(ws.id);
                      }
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
