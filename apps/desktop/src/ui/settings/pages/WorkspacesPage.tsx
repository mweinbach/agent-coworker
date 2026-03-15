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
import type { IosRelayConfig, IosRelayState } from "../../../app/iosRelayTypes";
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
import { MODEL_CHOICES, modelOptionsForProvider, UI_DISABLED_PROVIDERS } from "../../../lib/modelChoices";
import type { ProviderName } from "../../../lib/wsProtocol";
import { PROVIDER_NAMES } from "../../../lib/wsProtocol";
import { cn } from "../../../lib/utils";

function displayProviderName(provider: ProviderName): string {
  const names: Partial<Record<ProviderName, string>> = {
    google: "Google",
    openai: "OpenAI",
    anthropic: "Anthropic",
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

type IosRelayCardProps = {
  workspace: Pick<WorkspaceRecord, "id" | "name" | "iosRelayEnabled">;
  relayState: IosRelayState;
  relayConfig: IosRelayConfig;
  updateWorkspaceDefaults: (
    workspaceId: string,
    patch: { iosRelayEnabled?: boolean },
  ) => Promise<unknown> | void;
  updateIosRelayConfig: (patch: Partial<IosRelayConfig>) => Promise<void>;
  startIosRelayAdvertising: () => Promise<void>;
  stopIosRelayAdvertising: () => Promise<void>;
  connectIosRelayPeer: (peerId: string) => Promise<void>;
  disconnectIosRelayPeer: () => Promise<void>;
};

function relayBadgeVariant(relayState: IosRelayState): "secondary" | "destructive" | "outline" {
  if (relayState.lastError) return "destructive";
  if (relayState.peer?.state === "connected") return "secondary";
  return "outline";
}

function relayBadgeLabel(relayState: IosRelayState): string {
  if (!relayState.supported) return "Unsupported";
  if (relayState.lastError) return "Error";
  if (relayState.peer?.state === "connected") return "Connected";
  if (relayState.peer?.state === "connecting") return "Connecting";
  if (relayState.advertising) return "Advertising";
  return "Idle";
}

export function IosRelayCard({
  workspace,
  relayState,
  relayConfig,
  updateWorkspaceDefaults,
  updateIosRelayConfig,
  startIosRelayAdvertising,
  stopIosRelayAdvertising,
  connectIosRelayPeer,
  disconnectIosRelayPeer,
}: IosRelayCardProps) {
  const isPublished = relayState.publishedWorkspaceId === workspace.id;
  const rememberedPeerId = relayConfig.rememberedPeerId ?? "";
  const rememberedPeerName = relayConfig.rememberedPeerName ?? "";
  const deviceName = relayConfig.deviceName ?? "";

  return (
    <Card className="border-border/80 bg-card/85">
      <CardHeader>
        <div className="flex items-start justify-between gap-4 max-[960px]:flex-col">
          <div className="space-y-2">
            <CardTitle>iOS Relay</CardTitle>
            <CardDescription>
              Publish this workspace server to one paired iOS client over the native Loom helper.
            </CardDescription>
          </div>
          <Badge variant={relayBadgeVariant(relayState)}>{relayBadgeLabel(relayState)}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <div className="text-sm font-medium text-foreground">Device name</div>
            <Input
              aria-label="iOS relay device name"
              autoComplete="off"
              placeholder="Cowork Mac"
              value={deviceName}
              onChange={(event) => {
                void updateIosRelayConfig({
                  deviceName: event.target.value.trim() || null,
                });
              }}
            />
          </div>

          <div className="space-y-2">
            <div className="text-sm font-medium text-foreground">Remembered peer name</div>
            <Input
              aria-label="iOS relay peer name"
              autoComplete="off"
              placeholder="My iPhone"
              value={rememberedPeerName}
              onChange={(event) => {
                void updateIosRelayConfig({
                  rememberedPeerName: event.target.value.trim() || null,
                });
              }}
            />
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium text-foreground">Remembered peer ID</div>
          <Input
            aria-label="iOS relay peer id"
            autoComplete="off"
            placeholder="peer UUID"
            value={rememberedPeerId}
            onChange={(event) => {
              void updateIosRelayConfig({
                rememberedPeerId: event.target.value.trim() || null,
              });
            }}
          />
          <div className="text-xs text-muted-foreground">
            The helper only accepts the explicitly approved Loom peer identity.
          </div>
        </div>

        <div className="grid gap-3 rounded-xl border border-border/70 p-4 text-sm md:grid-cols-2">
          <div>
            <div className="font-medium text-foreground">Published workspace</div>
            <div className="text-muted-foreground">
              {isPublished ? workspace.name : "None"}
            </div>
          </div>
          <div>
            <div className="font-medium text-foreground">Open relay channels</div>
            <div className="text-muted-foreground">{relayState.openChannelCount}</div>
          </div>
          <div>
            <div className="font-medium text-foreground">Peer</div>
            <div className="text-muted-foreground">
              {relayState.peer ? `${relayState.peer.name} (${relayState.peer.state})` : "No active peer"}
            </div>
          </div>
          <div>
            <div className="font-medium text-foreground">Support</div>
            <div className="text-muted-foreground">{relayState.supported ? "macOS helper available" : "Unavailable on this platform"}</div>
          </div>
        </div>

        {relayState.lastError ? (
          <div className="rounded-xl border border-rose-300/60 bg-rose-50/80 px-4 py-3 text-sm text-rose-700">
            {relayState.lastError}
          </div>
        ) : null}

        <div className="flex items-start justify-between gap-4 max-[960px]:flex-col">
          <div>
            <div className="text-sm font-medium text-foreground">Publish this workspace to iOS</div>
            <div className="text-xs text-muted-foreground">
              When enabled, the paired iOS client gets normal Cowork client access to this workspace server.
            </div>
          </div>
          <Checkbox
            checked={workspace.iosRelayEnabled}
            aria-label="Enable iOS relay for workspace"
            disabled={!relayState.supported}
            onCheckedChange={async (checked) => {
              const next = toBoolean(checked);
              if (next) {
                const confirmed = await confirmAction({
                  title: "Enable iOS Relay",
                  message: "Allow a paired iOS client to connect to this workspace server?",
                  detail: "The iOS client will have normal Cowork client powers against this workspace while relay is enabled.",
                  confirmLabel: "Enable relay",
                  cancelLabel: "Cancel",
                  kind: "warning",
                  defaultAction: "cancel",
                });
                if (!confirmed) return;
              }
              await updateWorkspaceDefaults(workspace.id, { iosRelayEnabled: next });
            }}
          />
        </div>

        <div className="flex flex-wrap gap-3">
          <Button
            type="button"
            variant={relayState.advertising ? "secondary" : "default"}
            disabled={!relayState.supported}
            onClick={() => void (relayState.advertising ? stopIosRelayAdvertising() : startIosRelayAdvertising())}
          >
            {relayState.advertising ? "Stop Advertising" : "Start Advertising"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!relayState.supported || rememberedPeerId.trim().length === 0}
            onClick={() => void connectIosRelayPeer(rememberedPeerId.trim())}
          >
            Connect
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!relayState.supported || relayState.peer == null}
            onClick={() => void disconnectIosRelayPeer()}
          >
            Disconnect
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function WorkspacesPage() {
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const providerStatusByName = useAppStore((s) => s.providerStatusByName);
  const iosRelayState = useAppStore((s) => s.iosRelayState);
  const iosRelayConfig = useAppStore((s) => s.iosRelayConfig);

  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const removeWorkspace = useAppStore((s) => s.removeWorkspace);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const updateWorkspaceDefaults = useAppStore((s) => s.updateWorkspaceDefaults);
  const updateIosRelayConfig = useAppStore((s) => s.updateIosRelayConfig);
  const startIosRelayAdvertising = useAppStore((s) => s.startIosRelayAdvertising);
  const stopIosRelayAdvertising = useAppStore((s) => s.stopIosRelayAdvertising);
  const connectIosRelayPeer = useAppStore((s) => s.connectIosRelayPeer);
  const disconnectIosRelayPeer = useAppStore((s) => s.disconnectIosRelayPeer);
  const restartWorkspaceServer = useAppStore((s) => s.restartWorkspaceServer);

  const ws = useMemo(
    () => workspaces.find((w) => w.id === selectedWorkspaceId) ?? workspaces[0] ?? null,
    [selectedWorkspaceId, workspaces],
  );

  const provider = (ws?.defaultProvider ?? "google") as ProviderName;
  const model = (ws?.defaultModel ?? "").trim();
  const subAgentModel = (ws?.defaultSubAgentModel ?? ws?.defaultModel ?? "").trim();
  const enableMcp = ws?.defaultEnableMcp ?? true;
  const backupsEnabled = ws?.defaultBackupsEnabled ?? true;
  const yolo = ws?.yolo ?? false;

  const curatedModels = MODEL_CHOICES[provider] ?? [];
  const modelOptions = modelOptionsForProvider(provider, model);
  const hasCustomModel = Boolean(model && !curatedModels.includes(model));
  const subAgentModelOptions = modelOptionsForProvider(provider, subAgentModel);
  const hasCustomSubAgentModel = Boolean(subAgentModel && !curatedModels.includes(subAgentModel));

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

            <IosRelayCard
              workspace={ws}
              relayState={iosRelayState}
              relayConfig={iosRelayConfig}
              updateWorkspaceDefaults={updateWorkspaceDefaults}
              updateIosRelayConfig={updateIosRelayConfig}
              startIosRelayAdvertising={startIosRelayAdvertising}
              stopIosRelayAdvertising={stopIosRelayAdvertising}
              connectIosRelayPeer={connectIosRelayPeer}
              disconnectIosRelayPeer={disconnectIosRelayPeer}
            />
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
                    value={provider}
                    onValueChange={(value) => {
                      if (!ws) return;
                      const nextProvider = value as ProviderName;
                      if (UI_DISABLED_PROVIDERS.has(nextProvider)) return;
                      void updateWorkspaceDefaults(ws.id, {
                        defaultProvider: nextProvider,
                        defaultModel: defaultModelForProvider(nextProvider),
                        defaultSubAgentModel: defaultModelForProvider(nextProvider),
                      });
                    }}
                  >
                    <SelectTrigger aria-label="Default provider">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PROVIDER_NAMES.filter((entry) => {
                        if (UI_DISABLED_PROVIDERS.has(entry)) return false;
                        if (entry === provider) return true;
                        const status = providerStatusByName[entry];
                        return status?.verified || status?.authorized;
                      }).map((entry) => (
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
                      void updateWorkspaceDefaults(ws.id, { defaultModel: value });
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
                  <div className="text-sm font-medium text-foreground">Subagent model</div>
                  <Select
                    value={subAgentModel}
                    onValueChange={(value) => {
                      if (!ws) return;
                      void updateWorkspaceDefaults(ws.id, { defaultSubAgentModel: value });
                    }}
                  >
                    <SelectTrigger aria-label="Default subagent model">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {subAgentModelOptions.map((entry) => (
                        <SelectItem key={entry} value={entry}>
                          {hasCustomSubAgentModel && entry === subAgentModel ? `${entry} (custom)` : entry}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
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
              <span>Subagent:</span>
              <Badge variant="secondary">{subAgentModel || model}</Badge>
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
