import { useEffect, useMemo, useState } from "react";

import { useAppStore } from "../../app/store";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Checkbox } from "../../components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { defaultModelForProvider } from "@cowork/providers/catalog";
import { modelChoicesFromCatalog } from "../../lib/modelChoices";
import type { ProviderName } from "../../lib/wsProtocol";
import { cn } from "../../lib/utils";

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

function WelcomeStep({ onContinue, onDismiss }: { onContinue: () => void; onDismiss: () => void }) {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold">Welcome to Cowork</h2>
        <p className="text-sm text-muted-foreground">
          Let's get you set up in just a few steps. Cowork is a local-first AI coding assistant that runs entirely on your machine.
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-1">
          <div className="text-sm font-medium">What you'll do:</div>
          <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground ml-2">
            <li>Choose a workspace directory on your disk</li>
            <li>Connect a model provider (OpenAI, Anthropic, Google, etc.)</li>
            <li>Review default settings for your workspace</li>
            <li>Start your first conversation</li>
          </ul>
        </div>

        <div className="rounded-lg border border-border/70 bg-muted/20 p-4 text-sm text-muted-foreground">
          <div className="font-medium mb-1">Note:</div>
          Command approvals are enabled by default to keep your system safe. You can adjust this later in settings.
        </div>
      </div>

      <div className="flex gap-3">
        <Button onClick={onContinue} className="flex-1">
          Continue
        </Button>
        <Button variant="outline" onClick={onDismiss}>
          Not now
        </Button>
      </div>
    </div>
  );
}

function WorkspaceStep({ onContinue, onBack }: { onContinue: () => void; onBack: () => void }) {
  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const workspaceRuntimeById = useAppStore((s) => s.workspaceRuntimeById);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);

  const selectedWorkspace = useMemo(
    () => workspaces.find((w) => w.id === selectedWorkspaceId) ?? null,
    [workspaces, selectedWorkspaceId],
  );
  const runtime = selectedWorkspaceId ? workspaceRuntimeById[selectedWorkspaceId] : null;
  const isStarting = runtime?.starting === true;

  const canContinue = selectedWorkspace !== null && !isStarting;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold">Add a Workspace</h2>
        <p className="text-sm text-muted-foreground">
          Choose a directory on your computer where Cowork will work. This is where your conversations and project context live.
        </p>
      </div>

      {selectedWorkspace ? (
        <Card className="border-border/80 bg-card/85">
          <CardContent className="p-4">
            <div className="space-y-2">
              <div className="text-sm font-medium">{selectedWorkspace.name}</div>
              <div className="text-xs text-muted-foreground font-mono">{selectedWorkspace.path}</div>
              {isStarting ? (
                <div className="text-xs text-muted-foreground">Starting workspace server...</div>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-border/80 bg-card/85">
          <CardContent className="p-6 text-center text-sm text-muted-foreground">
            No workspace selected. Click "Add Workspace" to choose a directory.
          </CardContent>
        </Card>
      )}

      <div className="flex gap-3">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button onClick={() => void addWorkspace()} variant="outline" className="flex-1">
          {selectedWorkspace ? "Change Workspace" : "Add Workspace"}
        </Button>
        <Button onClick={onContinue} disabled={!canContinue}>
          Continue
        </Button>
      </div>
    </div>
  );
}

function ProviderStep({ onContinue, onBack }: { onContinue: () => void; onBack: () => void }) {
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const providerCatalog = useAppStore((s) => s.providerCatalog);
  const providerStatusByName = useAppStore((s) => s.providerStatusByName);
  const providerConnected = useAppStore((s) => s.providerConnected);
  const requestProviderCatalog = useAppStore((s) => s.requestProviderCatalog);
  const requestProviderAuthMethods = useAppStore((s) => s.requestProviderAuthMethods);
  const refreshProviderStatus = useAppStore((s) => s.refreshProviderStatus);
  const connectProvider = useAppStore((s) => s.connectProvider);

  const modelChoices = useMemo(() => modelChoicesFromCatalog(providerCatalog), [providerCatalog]);

  const modelProviders = useMemo(() => {
    return providerCatalog
      .map((entry) => entry.id)
      .filter((provider): provider is ProviderName => {
        if (typeof provider !== "string") return false;
        const choices = modelChoices[provider as ProviderName];
        return choices !== undefined && choices.length > 0;
      });
  }, [providerCatalog, modelChoices]);

  useEffect(() => {
    if (selectedWorkspaceId) {
      void requestProviderCatalog();
      void requestProviderAuthMethods();
      void refreshProviderStatus();
    }
  }, [selectedWorkspaceId, requestProviderCatalog, requestProviderAuthMethods, refreshProviderStatus]);

  const hasConnectedProvider = providerConnected.length > 0;
  const canContinue = hasConnectedProvider;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold">Connect a Model Provider</h2>
        <p className="text-sm text-muted-foreground">
          Choose a provider to power Cowork. You'll need an API key or to sign in with OAuth.
        </p>
      </div>

      <div className="space-y-3">
        {modelProviders.length === 0 ? (
          <Card className="border-border/80 bg-card/85">
            <CardContent className="p-6 text-center text-sm text-muted-foreground">
              Loading providers...
            </CardContent>
          </Card>
        ) : (
          modelProviders.map((provider) => {
            const status = providerStatusByName[provider];
            const connected = status?.authorized || status?.verified;
            const displayName = providerCatalog.find((e) => e.id === provider)?.name ?? displayProviderName(provider);

            return (
              <Card
                key={provider}
                className={cn("border-border/80 bg-card/85", connected && "border-primary/35")}
              >
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium">{displayName}</div>
                      <div className="text-xs text-muted-foreground">
                        {connected ? "Connected" : "Not connected"}
                      </div>
                    </div>
                    {!connected ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void connectProvider(provider)}
                      >
                        Connect
                      </Button>
                    ) : (
                      <div className="text-xs text-muted-foreground">✓</div>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>

      {!hasConnectedProvider ? (
        <div className="rounded-lg border border-border/70 bg-muted/20 p-4 text-sm text-muted-foreground">
          Connect at least one provider to continue.
        </div>
      ) : null}

      <div className="flex gap-3">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onContinue} disabled={!canContinue} className="flex-1">
          Continue
        </Button>
      </div>
    </div>
  );
}

function DefaultsStep({ onContinue, onBack }: { onContinue: () => void; onBack: () => void }) {
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const workspaces = useAppStore((s) => s.workspaces);
  const providerCatalog = useAppStore((s) => s.providerCatalog);
  const providerStatusByName = useAppStore((s) => s.providerStatusByName);
  const providerConnected = useAppStore((s) => s.providerConnected);
  const updateWorkspaceDefaults = useAppStore((s) => s.updateWorkspaceDefaults);

  const workspace = useMemo(
    () => workspaces.find((w) => w.id === selectedWorkspaceId) ?? null,
    [workspaces, selectedWorkspaceId],
  );

  const modelChoices = useMemo(() => modelChoicesFromCatalog(providerCatalog), [providerCatalog]);

  const connectedProviders = useMemo(() => {
    return providerConnected.filter((provider) => {
      const choices = modelChoices[provider];
      return choices !== undefined && choices.length > 0;
    });
  }, [providerConnected, modelChoices]);

  const [defaultProvider, setDefaultProvider] = useState<ProviderName | null>(
    workspace?.defaultProvider ?? null,
  );
  const [defaultModel, setDefaultModel] = useState<string | null>(workspace?.defaultModel ?? null);
  const [defaultSubAgentModel, setDefaultSubAgentModel] = useState<string | null>(
    workspace?.defaultSubAgentModel ?? null,
  );
  const [defaultEnableMcp, setDefaultEnableMcp] = useState(workspace?.defaultEnableMcp ?? true);
  const [defaultBackupsEnabled, setDefaultBackupsEnabled] = useState(
    workspace?.defaultBackupsEnabled ?? true,
  );

  useEffect(() => {
    if (workspace) {
      setDefaultProvider(workspace.defaultProvider ?? null);
      setDefaultModel(workspace.defaultModel ?? null);
      setDefaultSubAgentModel(workspace.defaultSubAgentModel ?? null);
      setDefaultEnableMcp(workspace.defaultEnableMcp);
      setDefaultBackupsEnabled(workspace.defaultBackupsEnabled);
    }
  }, [workspace?.id]);

  // Auto-select first connected provider if current default is not connected
  useEffect(() => {
    if (
      workspace &&
      defaultProvider &&
      !connectedProviders.includes(defaultProvider) &&
      connectedProviders.length > 0
    ) {
      const firstConnected = connectedProviders[0]!;
      setDefaultProvider(firstConnected);
      setDefaultModel(defaultModelForProvider(firstConnected));
      setDefaultSubAgentModel(defaultModelForProvider(firstConnected));
    }
  }, [workspace, defaultProvider, connectedProviders]);

  const availableModels = defaultProvider ? modelChoices[defaultProvider] ?? [] : [];
  const availableSubAgentModels = defaultProvider ? modelChoices[defaultProvider] ?? [] : [];

  const canContinue =
    workspace !== null &&
    defaultProvider !== null &&
    connectedProviders.includes(defaultProvider) &&
    defaultModel !== null;

  const handleSave = async () => {
    if (!workspace || !defaultProvider || !defaultModel) return;

    await updateWorkspaceDefaults(workspace.id, {
      defaultProvider,
      defaultModel,
      defaultSubAgentModel: defaultSubAgentModel ?? defaultModel,
      defaultEnableMcp,
      defaultBackupsEnabled,
    });
  };

  if (!workspace) {
    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <h2 className="text-2xl font-semibold">Workspace Defaults</h2>
          <p className="text-sm text-muted-foreground">No workspace selected.</p>
        </div>
        <div className="flex gap-3">
          <Button variant="outline" onClick={onBack}>
            Back
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold">Workspace Defaults</h2>
        <p className="text-sm text-muted-foreground">
          Configure default settings for this workspace. You can change these later.
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium">Default Provider</label>
          <Select
            value={defaultProvider ?? ""}
            onValueChange={(value) => {
              const provider = value as ProviderName;
              setDefaultProvider(provider);
              setDefaultModel(defaultModelForProvider(provider));
              setDefaultSubAgentModel(defaultModelForProvider(provider));
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select a provider" />
            </SelectTrigger>
            <SelectContent>
              {connectedProviders.map((provider) => {
                const displayName =
                  providerCatalog.find((e) => e.id === provider)?.name ?? displayProviderName(provider);
                return (
                  <SelectItem key={provider} value={provider}>
                    {displayName}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>

        {defaultProvider && availableModels.length > 0 ? (
          <div className="space-y-2">
            <label className="text-sm font-medium">Primary Model</label>
            <Select value={defaultModel ?? ""} onValueChange={setDefaultModel}>
              <SelectTrigger>
                <SelectValue placeholder="Select a model" />
              </SelectTrigger>
              <SelectContent>
                {availableModels.map((model) => (
                  <SelectItem key={model} value={model}>
                    {model}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        {defaultProvider && availableSubAgentModels.length > 0 ? (
          <div className="space-y-2">
            <label className="text-sm font-medium">Subagent Model</label>
            <Select
              value={defaultSubAgentModel ?? defaultModel ?? ""}
              onValueChange={setDefaultSubAgentModel}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a model" />
              </SelectTrigger>
              <SelectContent>
                {availableSubAgentModels.map((model) => (
                  <SelectItem key={model} value={model}>
                    {model}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-sm font-medium">Enable MCP</div>
            <div className="text-xs text-muted-foreground">
              Allow Model Context Protocol servers to extend Cowork's capabilities.
            </div>
          </div>
          <Checkbox
            checked={defaultEnableMcp}
            onCheckedChange={(checked) => setDefaultEnableMcp(toBoolean(checked))}
          />
        </div>

        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-sm font-medium">Enable Backups</div>
            <div className="text-xs text-muted-foreground">
              Automatically backup session state for recovery.
            </div>
          </div>
          <Checkbox
            checked={defaultBackupsEnabled}
            onCheckedChange={(checked) => setDefaultBackupsEnabled(toBoolean(checked))}
          />
        </div>
      </div>

      <div className="flex gap-3">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button
          onClick={async () => {
            await handleSave();
            onContinue();
          }}
          disabled={!canContinue}
          className="flex-1"
        >
          Continue
        </Button>
      </div>
    </div>
  );
}

function FirstThreadStep({ onComplete, onBack }: { onComplete: () => void; onBack: () => void }) {
  const newThread = useAppStore((s) => s.newThread);
  const [creating, setCreating] = useState(false);

  const starterPrompts = [
    { label: "Summarize this repo", message: "Summarize this repository. What does it do?" },
    { label: "Find setup risks", message: "Review this codebase and identify any setup or configuration risks." },
    { label: "Plan first tasks", message: "Help me plan the first tasks for this project." },
  ];

  const handleStartBlank = async () => {
    setCreating(true);
    try {
      await newThread();
      onComplete();
    } finally {
      setCreating(false);
    }
  };

  const handleStartWithPrompt = async (message: string) => {
    setCreating(true);
    try {
      await newThread({ firstMessage: message, titleHint: message.split(".")[0] ?? "New thread" });
      onComplete();
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold">Start Your First Thread</h2>
        <p className="text-sm text-muted-foreground">
          Create your first conversation with Cowork. You can start with a blank thread or use one of these prompts.
        </p>
      </div>

      <div className="space-y-3">
        <Button
          onClick={handleStartBlank}
          disabled={creating}
          variant="outline"
          className="w-full justify-start"
        >
          Start blank thread
        </Button>

        {starterPrompts.map((prompt) => (
          <Button
            key={prompt.label}
            onClick={() => void handleStartWithPrompt(prompt.message)}
            disabled={creating}
            variant="outline"
            className="w-full justify-start text-left"
          >
            {prompt.label}
          </Button>
        ))}
      </div>

      <div className="flex gap-3">
        <Button variant="outline" onClick={onBack} disabled={creating}>
          Back
        </Button>
      </div>
    </div>
  );
}

export function DesktopOnboarding() {
  const onboardingVisible = useAppStore((s) => s.onboardingVisible);
  const onboardingStep = useAppStore((s) => s.onboardingStep);
  const startOnboarding = useAppStore((s) => s.startOnboarding);
  const dismissOnboarding = useAppStore((s) => s.dismissOnboarding);
  const completeOnboarding = useAppStore((s) => s.completeOnboarding);
  const nextOnboardingStep = useAppStore((s) => s.nextOnboardingStep);
  const previousOnboardingStep = useAppStore((s) => s.previousOnboardingStep);

  if (!onboardingVisible) {
    return null;
  }

  const steps = ["welcome", "workspace", "provider", "defaults", "firstThread"] as const;
  const currentStepIndex = steps.indexOf(onboardingStep);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="app-window-drag-strip absolute top-0 left-0 right-0 h-8" aria-hidden="true" />
      <Card className="w-full max-w-2xl mx-4 border-border/80 bg-card/95 shadow-lg">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Getting Started</CardTitle>
            <div className="text-xs text-muted-foreground">
              Step {currentStepIndex + 1} of {steps.length}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {onboardingStep === "welcome" && (
            <WelcomeStep onContinue={nextOnboardingStep} onDismiss={dismissOnboarding} />
          )}
          {onboardingStep === "workspace" && (
            <WorkspaceStep onContinue={nextOnboardingStep} onBack={previousOnboardingStep} />
          )}
          {onboardingStep === "provider" && (
            <ProviderStep onContinue={nextOnboardingStep} onBack={previousOnboardingStep} />
          )}
          {onboardingStep === "defaults" && (
            <DefaultsStep onContinue={nextOnboardingStep} onBack={previousOnboardingStep} />
          )}
          {onboardingStep === "firstThread" && (
            <FirstThreadStep onComplete={completeOnboarding} onBack={previousOnboardingStep} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
