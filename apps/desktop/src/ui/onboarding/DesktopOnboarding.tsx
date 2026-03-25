import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

import { useAppStore } from "../../app/store";
import type { OnboardingStep } from "../../app/types";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../components/ui/collapsible";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import {
  availableProvidersFromCatalog,
  modelChoicesFromCatalog,
  modelOptionsFromCatalog,
  type CatalogVisibilityOptions,
  UI_DISABLED_PROVIDERS,
} from "../../lib/modelChoices";
import type { ProviderName, ServerEvent } from "../../lib/wsProtocol";
import { PROVIDER_NAMES } from "../../lib/wsProtocol";
import { cn } from "../../lib/utils";
import {
  displayProviderName,
  fallbackAuthMethods,
  isProviderNameString,
} from "../../lib/providerDisplayNames";
import coworkIconSvg from "../../../build/icon.icon/Assets/svgviewer-output.svg";

const PROVIDER_STATUS_POLL_MS = 4000;
const WORKSPACE_SERVER_TIMEOUT_MS = 30_000;

type ProviderAuthMethod = Extract<ServerEvent, { type: "provider_auth_methods" }>["methods"][string][number];

const STEP_ORDER: OnboardingStep[] = ["welcome", "workspace", "provider", "defaults", "firstThread"];

function stepIndex(step: OnboardingStep): number {
  return STEP_ORDER.indexOf(step);
}

// ── Step indicators ──

function StepIndicator({ current }: { current: OnboardingStep }) {
  const currentIdx = stepIndex(current);
  return (
    <div className="flex items-center gap-1.5">
      {STEP_ORDER.map((step, i) => (
        <div
          key={step}
          className={cn(
            "h-1.5 rounded-full transition-all duration-300",
            i === currentIdx ? "w-6 bg-primary" : i < currentIdx ? "w-1.5 bg-primary/50" : "w-1.5 bg-muted-foreground/25",
          )}
        />
      ))}
    </div>
  );
}

// ── Step 1: Welcome ──

function WelcomeStep({ onContinue, onDismiss }: { onContinue: () => void; onDismiss: () => void }) {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <img src={coworkIconSvg} alt="" aria-hidden="true" className="h-12 w-12 shrink-0" draggable={false} />
        <div className="space-y-1">
          <h2 className="text-2xl font-semibold tracking-tight">Welcome to Cowork</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            A local-first AI assistant that runs on your machine.
          </p>
        </div>
      </div>

      <p className="text-sm text-muted-foreground leading-relaxed">
        Here's what we'll set up:
      </p>

      <div className="space-y-3">
        {[
          { title: "Choose a workspace", desc: "Pick a folder on disk for Cowork to work in." },
          { title: "Connect a provider", desc: "Add an API key or sign in to a model provider." },
          { title: "Review defaults", desc: "Set the default model and a couple of safe options." },
        ].map((item) => (
          <div key={item.title} className="flex gap-3 items-start">
            <div className="mt-0.5 h-5 w-5 shrink-0 rounded-full bg-primary/10 flex items-center justify-center">
              <div className="h-1.5 w-1.5 rounded-full bg-primary" />
            </div>
            <div>
              <div className="text-sm font-medium">{item.title}</div>
              <div className="text-xs text-muted-foreground">{item.desc}</div>
            </div>
          </div>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        Command approvals stay enabled by default — Cowork will always ask before running commands.
      </p>

      <div className="flex gap-3 pt-2">
        <Button onClick={onContinue}>Get started</Button>
        <Button variant="ghost" onClick={onDismiss}>
          Not now
        </Button>
      </div>
    </div>
  );
}

// ── Step 2: Workspace ──

function WorkspaceStep({ onContinue, onBack }: { onContinue: () => void; onBack: () => void }) {
  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const workspaceRuntimeById = useAppStore((s) => s.workspaceRuntimeById);

  const workspace = useMemo(
    () => workspaces.find((w) => w.id === selectedWorkspaceId) ?? null,
    [workspaces, selectedWorkspaceId],
  );
  const runtime = workspace ? workspaceRuntimeById[workspace.id] : null;
  const serverReady = Boolean(runtime?.serverUrl && !runtime?.error);
  const starting = runtime?.starting === true;
  const serverError = runtime?.error ?? null;
  const hasWorkspace = workspace !== null;
  const hasMultipleWorkspaces = workspaces.length > 1;

  // Track how long the server has been starting for timeout display
  const [startingSince, setStartingSince] = useState<number | null>(null);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (starting && !startingSince) {
      setStartingSince(Date.now());
      setTimedOut(false);
    } else if (!starting) {
      setStartingSince(null);
      setTimedOut(false);
    }
  }, [starting, startingSince]);

  useEffect(() => {
    if (!startingSince) return;
    const timer = setTimeout(() => setTimedOut(true), WORKSPACE_SERVER_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [startingSince]);

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold tracking-tight">
          {hasMultipleWorkspaces ? "Choose a workspace" : "Add a workspace"}
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {hasMultipleWorkspaces
            ? "Select an existing workspace or add a new one."
            : "Choose a folder on your machine. This is where Cowork will read and write files."}
        </p>
      </div>

      {/* Workspace picker for rerun with multiple workspaces */}
      {hasMultipleWorkspaces ? (
        <div className="space-y-2">
          <div className="text-sm font-medium">Active workspace</div>
          <Select
            value={selectedWorkspaceId ?? ""}
            onValueChange={(value) => void selectWorkspace(value)}
          >
            <SelectTrigger aria-label="Select workspace">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {workspaces.map((ws) => (
                <SelectItem key={ws.id} value={ws.id}>
                  {ws.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {hasWorkspace ? (
        <Card className="border-border/80 bg-card/85">
          <CardContent className="p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate">{workspace.name}</div>
                <div className="text-xs text-muted-foreground truncate">{workspace.path}</div>
              </div>
              <div className="shrink-0">
                {serverError ? (
                  <Badge variant="destructive">Error</Badge>
                ) : starting ? (
                  <Badge variant="secondary">{timedOut ? "Slow start..." : "Starting..."}</Badge>
                ) : serverReady ? (
                  <Badge>Ready</Badge>
                ) : (
                  <Badge variant="secondary">Connecting...</Badge>
                )}
              </div>
            </div>
            {serverError ? (
              <div className="mt-2 text-xs text-destructive">{serverError}</div>
            ) : null}
            {timedOut && starting ? (
              <div className="mt-2 text-xs text-muted-foreground">
                The workspace server is taking longer than expected. You can continue waiting or try choosing a different folder.
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <div className="flex gap-3">
        <Button variant={hasWorkspace ? "outline" : "default"} onClick={() => void addWorkspace()}>
          {hasWorkspace ? "Add different folder" : "Choose folder"}
        </Button>
      </div>

      <div className="flex gap-3 pt-2">
        <Button onClick={onContinue} disabled={!hasWorkspace}>
          Continue
        </Button>
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
      </div>
    </div>
  );
}

// ── Step 3: Provider ──

function ProviderStep({ onContinue, onBack }: { onContinue: () => void; onBack: () => void }) {
  const providerStatusByName = useAppStore((s) => s.providerStatusByName);
  const providerCatalog = useAppStore((s) => s.providerCatalog);
  const providerAuthMethodsByProvider = useAppStore((s) => s.providerAuthMethodsByProvider);
  const providerLastAuthChallenge = useAppStore((s) => s.providerLastAuthChallenge);
  const providerLastAuthResult = useAppStore((s) => s.providerLastAuthResult);
  const providerConnected = useAppStore((s) => s.providerConnected);
  const setProviderApiKey = useAppStore((s) => s.setProviderApiKey);
  const providerUiState = useAppStore((s) => s.providerUiState);
  const setLmStudioEnabled = useAppStore((s) => s.setLmStudioEnabled);
  const authorizeProviderAuth = useAppStore((s) => s.authorizeProviderAuth);
  const callbackProviderAuth = useAppStore((s) => s.callbackProviderAuth);
  const refreshProviderStatus = useAppStore((s) => s.refreshProviderStatus);

  const [expandedProvider, setExpandedProvider] = useState<ProviderName | null>(null);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [oauthCodes, setOauthCodes] = useState<Record<string, string>>({});

  const modelChoices = useMemo(() => modelChoicesFromCatalog(providerCatalog), [providerCatalog]);

  const modelProviders = useMemo(() => {
    const fromCatalog = providerCatalog
      .map((entry) => entry.id)
      .filter((p): p is ProviderName => isProviderNameString(p));
    const source = fromCatalog.length > 0 ? fromCatalog : [...PROVIDER_NAMES];
    const filtered = source.filter((p) => !UI_DISABLED_PROVIDERS.has(p));
    return filtered.filter((p) => {
      if (p === "lmstudio") return true;
      const models = modelChoices[p];
      return models && models.length > 0;
    }).sort((a, b) => {
      const aConnected = a === "lmstudio"
        ? providerUiState.lmstudio.enabled && Boolean(providerStatusByName[a]?.authorized || providerStatusByName[a]?.verified)
        : Boolean(providerStatusByName[a]?.authorized || providerStatusByName[a]?.verified);
      const bConnected = b === "lmstudio"
        ? providerUiState.lmstudio.enabled && Boolean(providerStatusByName[b]?.authorized || providerStatusByName[b]?.verified)
        : Boolean(providerStatusByName[b]?.authorized || providerStatusByName[b]?.verified);
      if (aConnected && !bConnected) return -1;
      if (!aConnected && bConnected) return 1;
      return displayProviderName(a).localeCompare(displayProviderName(b));
    });
  }, [providerCatalog, providerStatusByName, modelChoices, providerUiState]);

  const hasConnectedModelProvider = providerConnected.some((p) => {
    const models = modelChoices[p];
    if (!models || models.length === 0) return false;
    return p === "lmstudio" ? providerUiState.lmstudio.enabled : true;
  });

  // Initial fetch
  useEffect(() => {
    void refreshProviderStatus();
  }, [refreshProviderStatus]);

  // Poll provider status while this step is visible (useful for OAuth flows in browser).
  // Stop once a model provider is connected.
  useEffect(() => {
    if (hasConnectedModelProvider) return;
    const interval = setInterval(() => {
      void refreshProviderStatus();
    }, PROVIDER_STATUS_POLL_MS);
    return () => clearInterval(interval);
  }, [refreshProviderStatus, hasConnectedModelProvider]);

  const authMethodsFor = (provider: ProviderName): ProviderAuthMethod[] => {
    const fromStore = providerAuthMethodsByProvider[provider];
    if (Array.isArray(fromStore) && fromStore.length > 0) return fromStore;
    return fallbackAuthMethods(provider);
  };

  const startOauthSignIn = (provider: ProviderName, method: ProviderAuthMethod) => {
    void (async () => {
      await authorizeProviderAuth(provider, method.id);
      if (method.oauthMode !== "code") {
        await callbackProviderAuth(provider, method.id);
      }
    })();
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold tracking-tight">Connect a provider</h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Add an API key or sign in to at least one model provider.
        </p>
      </div>

      <div className="space-y-2 max-h-[340px] overflow-y-auto">
        {modelProviders.map((provider) => {
          const status = providerStatusByName[provider];
          const connected = Boolean(status?.authorized || status?.verified);
          const isExpanded = expandedProvider === provider;
          const methods = authMethodsFor(provider);
          const providerDisplayName = displayProviderName(provider);
          const lmStudioEnabled = providerUiState.lmstudio.enabled;

          return (
            <Card key={provider} className={cn("border-border/80 bg-card/85", isExpanded && "border-primary/35")}>
              <Collapsible open={isExpanded} onOpenChange={(nextOpen) => setExpandedProvider(nextOpen ? provider : null)}>
                <CollapsibleTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-auto w-full justify-between gap-3 rounded-none px-4 py-3 text-left hover:bg-transparent"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">{providerDisplayName}</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge variant={connected ? "default" : "secondary"}>
                        {provider === "lmstudio"
                          ? lmStudioEnabled
                            ? (connected ? "Connected" : "Unavailable")
                            : "Disabled"
                          : connected
                            ? "Connected"
                            : "Not connected"}
                      </Badge>
                      <span className="text-xs text-muted-foreground">{isExpanded ? "▾" : "▸"}</span>
                    </div>
                  </Button>
                </CollapsibleTrigger>

                <CollapsibleContent>
                  <CardContent className="space-y-3 border-t border-border/70 px-4 py-3">
                  {provider === "lmstudio" ? (
                    <div className="space-y-3">
                      <div className="text-sm text-muted-foreground">
                        LM Studio runs on a local server. Connect it once to make its local models available in Cowork.
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          onClick={() => {
                            void setLmStudioEnabled(!lmStudioEnabled);
                          }}
                        >
                          {lmStudioEnabled ? "Disable" : "Connect"}
                        </Button>
                        <Button type="button" variant="outline" onClick={() => void refreshProviderStatus()}>
                          Refresh
                        </Button>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {lmStudioEnabled
                          ? (status?.message || "Cowork will use the models exposed by your local LM Studio server.")
                          : "Disabled providers stay out of the main chat UI until you connect them here."}
                      </div>
                    </div>
                  ) : methods.map((method) => {
                    const stateKey = `${provider}:${method.id}`;
                    const apiKeyValue = apiKeys[stateKey] ?? "";
                    const codeValue = oauthCodes[stateKey] ?? "";
                    const challengeMatch =
                      providerLastAuthChallenge?.provider === provider &&
                      providerLastAuthChallenge?.methodId === method.id
                        ? providerLastAuthChallenge
                        : null;
                    const resultMatch =
                      providerLastAuthResult?.provider === provider &&
                      providerLastAuthResult?.methodId === method.id
                        ? providerLastAuthResult
                        : null;
                    const challengeUrl =
                      provider === "codex-cli" && method.id === "oauth_cli"
                        ? undefined
                        : challengeMatch?.challenge.url;

                    return (
                      <div key={stateKey} className="space-y-2 border-t border-border/70 pt-3 first:border-t-0 first:pt-0">
                        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          {method.label}
                        </div>
                        {method.type === "api" ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <Input
                              className="max-w-xs"
                              value={apiKeyValue}
                              onChange={(e) =>
                                setApiKeys((s) => ({ ...s, [stateKey]: e.currentTarget.value }))
                              }
                              placeholder="Paste your API key"
                              type="password"
                              aria-label={`${providerDisplayName} API key`}
                            />
                            <Button
                              type="button"
                              disabled={!apiKeyValue.trim()}
                              onClick={() => {
                                void setProviderApiKey(provider, method.id, apiKeyValue.trim());
                              }}
                            >
                              Save
                            </Button>
                          </div>
                        ) : (
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              type="button"
                              onClick={() => startOauthSignIn(provider, method)}
                            >
                              Sign in
                            </Button>
                            {method.oauthMode === "code" ? (
                              <>
                                <Input
                                  className="max-w-xs"
                                  value={codeValue}
                                  onChange={(e) =>
                                    setOauthCodes((s) => ({
                                      ...s,
                                      [stateKey]: e.currentTarget.value,
                                    }))
                                  }
                                  placeholder="Paste authorization code"
                                  type="text"
                                  aria-label={`${providerDisplayName} authorization code`}
                                />
                                <Button
                                  variant="outline"
                                  type="button"
                                  onClick={() => {
                                    void callbackProviderAuth(provider, method.id, codeValue);
                                  }}
                                >
                                  Submit
                                </Button>
                              </>
                            ) : null}
                          </div>
                        )}

                        {challengeMatch ? (
                          <div className="text-xs text-muted-foreground">
                            {challengeMatch.challenge.instructions}
                            {challengeUrl ? (
                              <>
                                {" "}
                                <a href={challengeUrl} target="_blank" rel="noreferrer" className="underline">
                                  Open link
                                </a>
                              </>
                            ) : null}
                            {challengeMatch.challenge.command ? (
                              <>
                                {" "}
                                Run: <code className="rounded bg-muted/45 px-1.5 py-0.5">{challengeMatch.challenge.command}</code>
                              </>
                            ) : null}
                          </div>
                        ) : null}

                        {resultMatch ? (
                          <div className={cn("text-xs", resultMatch.ok ? "text-success" : "text-destructive")}>
                            {resultMatch.message}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                  </CardContent>
                </CollapsibleContent>
              </Collapsible>
            </Card>
          );
        })}
      </div>

      <div className="flex gap-3 pt-2">
        <Button onClick={onContinue} disabled={!hasConnectedModelProvider}>
          Continue
        </Button>
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
      </div>
    </div>
  );
}

// ── Step 4: Defaults ──

function DefaultsStep({ onContinue, onBack }: { onContinue: () => void; onBack: () => void }) {
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const providerCatalog = useAppStore((s) => s.providerCatalog);
  const providerConnected = useAppStore((s) => s.providerConnected);
  const providerUiState = useAppStore((s) => s.providerUiState);
  const updateWorkspaceDefaults = useAppStore((s) => s.updateWorkspaceDefaults);

  const workspace = useMemo(
    () => workspaces.find((w) => w.id === selectedWorkspaceId) ?? null,
    [workspaces, selectedWorkspaceId],
  );

  const provider = workspace?.defaultProvider ?? "google";
  const model = workspace?.defaultModel ?? "";
  const enableMcp = workspace?.defaultEnableMcp ?? true;
  const backupsEnabled = workspace?.defaultBackupsEnabled ?? true;

  const modelSelectorVisibility = useMemo<CatalogVisibilityOptions>(() => ({
    hiddenProviders: providerUiState.lmstudio.enabled ? [] : (["lmstudio"] as const),
    hiddenModelsByProvider: {
      lmstudio: providerUiState.lmstudio.hiddenModels,
    },
  }), [providerUiState]);
  const modelChoices = useMemo(
    () => modelChoicesFromCatalog(providerCatalog, modelSelectorVisibility),
    [providerCatalog, modelSelectorVisibility],
  );
  const availableProviders = useMemo(
    () => availableProvidersFromCatalog(providerCatalog, providerConnected, provider, {
      ...modelSelectorVisibility,
      visibleModelsByProvider: modelChoices,
    }),
    [providerCatalog, providerConnected, provider, modelChoices, modelSelectorVisibility],
  );
  const effectiveProvider = availableProviders.includes(provider) ? provider : (availableProviders[0] ?? provider);
  const modelOptions = modelOptionsFromCatalog(providerCatalog, effectiveProvider, model, modelSelectorVisibility);

  // Auto-fix: if the current workspace default provider isn't connected but another is, swap it
  useEffect(() => {
    if (!workspace) return;
    const isDefaultConnected = providerConnected.includes(provider);
    if (!isDefaultConnected && availableProviders.length > 0 && availableProviders[0] !== provider) {
      const newProvider = availableProviders[0]!;
      const providerDefault = providerCatalog.find((entry) => entry.id === newProvider)?.defaultModel?.trim() || "";
      const newModel = providerDefault || ((modelChoices[newProvider] ?? [])[0] ?? "");
      void updateWorkspaceDefaults(workspace.id, {
        defaultProvider: newProvider,
        defaultModel: newModel,
      });
    }
  }, [workspace?.id, provider, providerConnected, availableProviders, modelChoices, updateWorkspaceDefaults]);

  const defaultProviderConnected = providerConnected.includes(effectiveProvider);

  if (!workspace) return null;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold tracking-tight">Review defaults</h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          These are the defaults for <span className="font-medium text-foreground">{workspace.name}</span>. You can always change them later in settings.
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <div className="text-sm font-medium">Default provider</div>
          <Select
            value={effectiveProvider}
            onValueChange={(value) => {
              if (!isProviderNameString(value)) return;
              const providerDefault = providerCatalog.find((entry) => entry.id === value)?.defaultModel?.trim() || "";
              const newModel = providerDefault || ((modelChoices[value] ?? [])[0] ?? "");
              void updateWorkspaceDefaults(workspace.id, {
                defaultProvider: value,
                defaultModel: newModel,
              });
            }}
          >
            <SelectTrigger aria-label="Default provider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {availableProviders.map((p) => (
                <SelectItem key={p} value={p}>
                  {displayProviderName(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium">Default model</div>
          <Select
            value={model || (modelOptions[0] ?? "")}
            onValueChange={(value) => {
              void updateWorkspaceDefaults(workspace.id, { defaultModel: value });
            }}
          >
            <SelectTrigger aria-label="Default model">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {modelOptions.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-medium">MCP servers</div>
            <div className="text-xs text-muted-foreground">Allow external tool servers.</div>
          </div>
          <Button
            variant={enableMcp ? "default" : "outline"}
            size="sm"
            onClick={() =>
              void updateWorkspaceDefaults(workspace.id, { defaultEnableMcp: !enableMcp })
            }
          >
            {enableMcp ? "Enabled" : "Disabled"}
          </Button>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-medium">Backups</div>
            <div className="text-xs text-muted-foreground">Automatic file change backups.</div>
          </div>
          <Button
            variant={backupsEnabled ? "default" : "outline"}
            size="sm"
            onClick={() =>
              void updateWorkspaceDefaults(workspace.id, {
                defaultBackupsEnabled: !backupsEnabled,
              })
            }
          >
            {backupsEnabled ? "Enabled" : "Disabled"}
          </Button>
        </div>
      </div>

      <div className="flex gap-3 pt-2">
        <Button onClick={onContinue} disabled={!defaultProviderConnected}>
          Continue
        </Button>
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
      </div>
    </div>
  );
}

// ── Step 5: First Thread ──

const STARTER_PROMPTS = [
  { label: "Summarize this repo", message: "Give me a high-level summary of this repository — what it does, the key technologies, and how it's structured." },
  { label: "Find setup risks", message: "Look through the repo for any setup issues, missing configs, or common gotchas a new contributor might hit." },
  { label: "Plan first tasks", message: "Based on the current state of this repo, suggest 3-5 actionable first tasks I could work on." },
];

function FirstThreadStep({ onComplete }: { onComplete: (firstMessage?: string) => Promise<void> }) {
  const [creating, setCreating] = useState(false);

  const handleClick = (firstMessage?: string) => {
    if (creating) return;
    setCreating(true);
    void onComplete(firstMessage).finally(() => setCreating(false));
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold tracking-tight">Start your first thread</h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Pick a starter prompt or start with a blank thread.
        </p>
      </div>

      <div className="space-y-2">
        {STARTER_PROMPTS.map((prompt) => (
          <Button
            key={prompt.label}
            className="h-auto w-full justify-start rounded-lg border border-border/80 bg-card/85 px-4 py-3 text-left transition-colors hover:border-primary/40 hover:bg-card disabled:opacity-50"
            onClick={() => handleClick(prompt.message)}
            type="button"
            variant="ghost"
            disabled={creating}
          >
            <div className="text-sm font-medium">{prompt.label}</div>
            <div className="mt-0.5 text-xs text-muted-foreground line-clamp-1">{prompt.message}</div>
          </Button>
        ))}
      </div>

      <Button variant="outline" disabled={creating} onClick={() => handleClick()}>
        {creating ? "Creating..." : "Start blank thread"}
      </Button>
    </div>
  );
}

// ── Main Overlay ──

// ── Focus trap hook ──

function useFocusTrap(containerRef: React.RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      const focusable = container!.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;

      if (event.shiftKey) {
        if (document.activeElement === first) {
          event.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }

    container.addEventListener("keydown", handleKeyDown);

    // Auto-focus the first focusable element
    const first = container.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (first) {
      // Delay to let framer-motion animation settle
      requestAnimationFrame(() => first.focus());
    }

    return () => container.removeEventListener("keydown", handleKeyDown);
  }, [containerRef, active]);
}

// ── Height-measuring wrapper for smooth step transitions ──

function AnimatedStepContainer({ children, step }: { children: React.ReactNode; step: OnboardingStep }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [measuredHeight, setMeasuredHeight] = useState<number | "auto">("auto");

  useEffect(() => {
    if (!contentRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setMeasuredHeight(entry.contentRect.height);
      }
    });
    observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <motion.div
      animate={{ height: measuredHeight }}
      transition={{ type: "spring", stiffness: 400, damping: 35 }}
      style={{ overflow: "hidden" }}
    >
      <div ref={contentRef}>
        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -16 }}
            transition={{ duration: 0.15 }}
          >
            {children}
          </motion.div>
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

export function DesktopOnboarding() {
  const visible = useAppStore((s) => s.onboardingVisible);
  const step = useAppStore((s) => s.onboardingStep);
  const setStep = useAppStore((s) => s.setOnboardingStep);
  const dismiss = useAppStore((s) => s.dismissOnboarding);
  const complete = useAppStore((s) => s.completeOnboarding);
  const newThread = useAppStore((s) => s.newThread);
  const cardRef = useRef<HTMLDivElement>(null);

  useFocusTrap(cardRef, visible);

  const goTo = useCallback(
    (next: OnboardingStep) => setStep(next),
    [setStep],
  );

  const handleComplete = useCallback(
    async (firstMessage?: string) => {
      const threadsBefore = useAppStore.getState().threads.length;
      try {
        if (firstMessage) {
          await newThread({ firstMessage, titleHint: firstMessage.slice(0, 40) });
        } else {
          await newThread();
        }
      } catch {
        // Thread creation threw — leave onboarding open.
        return;
      }
      // newThread silently returns early on some failure paths (e.g.
      // no workspace server URL) instead of throwing.  Only mark
      // onboarding complete when a thread was actually created.
      const threadsAfter = useAppStore.getState().threads.length;
      if (threadsAfter > threadsBefore) {
        complete();
      }
    },
    [complete, newThread],
  );

  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" role="dialog" aria-modal="true" aria-label="Onboarding">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-background/80 backdrop-blur-sm" />

      {/* Allow native drag strip to remain clickable */}
      <div className="app-window-drag-strip absolute top-0 left-0 right-0" aria-hidden="true" />

      {/* Card */}
      <motion.div
        ref={cardRef}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        className="app-shadow-overlay relative z-10 w-[min(92vw,520px)] rounded-xl border border-border/80 bg-card p-6"
      >
        <div className="mb-5 flex items-center justify-between">
          <StepIndicator current={step} />
          <span className="text-xs text-muted-foreground">
            {stepIndex(step) + 1} / {STEP_ORDER.length}
          </span>
        </div>

        <AnimatedStepContainer step={step}>
          {step === "welcome" && (
            <WelcomeStep onContinue={() => goTo("workspace")} onDismiss={dismiss} />
          )}
          {step === "workspace" && (
            <WorkspaceStep onContinue={() => goTo("provider")} onBack={() => goTo("welcome")} />
          )}
          {step === "provider" && (
            <ProviderStep onContinue={() => goTo("defaults")} onBack={() => goTo("workspace")} />
          )}
          {step === "defaults" && (
            <DefaultsStep onContinue={() => goTo("firstThread")} onBack={() => goTo("provider")} />
          )}
          {step === "firstThread" && <FirstThreadStep onComplete={handleComplete} />}
        </AnimatedStepContainer>
      </motion.div>
    </div>
  );
}
