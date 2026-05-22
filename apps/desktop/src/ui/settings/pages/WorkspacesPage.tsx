import { defaultModelForProvider } from "@cowork/providers/catalog";
import { motion } from "framer-motion";
import { ChevronDownIcon, InfoIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  GOOGLE_DYNAMIC_REASONING_EFFORT,
  googleThinkingLevelFromReasoningEffort,
} from "../../../../../../src/shared/googleThinking";
import {
  type CodexCliProviderOptions,
  type GoogleProviderOptions,
  type GoogleReasoningEffortValue,
  getGoogleReasoningEffortValuesForModel,
  getWorkspaceGoogleNativeWebSearchEnabled,
  getWorkspaceGoogleReasoningEffort,
  getWorkspaceLocalWebSearchProvider,
  getWorkspaceReasoningEffort,
  getWorkspaceReasoningSummary,
  getWorkspaceTextVerbosity,
  getWorkspaceWebSearchBackend,
  getWorkspaceWebSearchMode,
  LOCAL_WEB_SEARCH_PROVIDERS,
  type LocalWebSearchProviderValue,
  mergeWorkspaceProviderOptions,
  type OpenAICompatibleProviderName,
  REASONING_EFFORT_VALUES,
  REASONING_SUMMARY_VALUES,
  type ReasoningEffortValue,
  type ReasoningSummaryValue,
  TEXT_VERBOSITY_VALUES,
  type TextVerbosityValue,
  WEB_SEARCH_BACKEND_VALUES,
  WEB_SEARCH_MODE_VALUES,
  type WebSearchBackendValue,
  type WebSearchModeValue,
} from "../../../app/openaiCompatibleProviderOptions";
import { useAppStore } from "../../../app/store";
import type { PersistedProviderStatus } from "../../../app/types";
import {
  isOneOffChatWorkspace,
  normalizeWorkspaceUserProfile,
  type WorkspaceRecord,
  type WorkspaceUserProfile,
} from "../../../app/types";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card";
import { Checkbox } from "../../../components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../../components/ui/collapsible";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { Switch } from "../../../components/ui/switch";
import { Textarea } from "../../../components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../../components/ui/tooltip";
import { confirmAction } from "../../../lib/desktopCommands";
import {
  type CatalogVisibilityOptions,
  modelChoicesFromCatalog,
  modelOptionsFromCatalog,
  UI_DISABLED_PROVIDERS,
} from "../../../lib/modelChoices";
import { displayProviderName } from "../../../lib/providerDisplayNames";
import {
  sortProviderEntriesForSettings,
  sortProviderNamesForSettings,
} from "../../../lib/providerOrdering";
import { cn } from "../../../lib/utils";
import type { ProviderName } from "../../../lib/wsProtocol";
import { PROVIDER_NAMES } from "../../../lib/wsProtocol";

function ToggleChip({
  pressed,
  onPressedChange,
  "aria-label": ariaLabel,
  id,
}: {
  pressed: boolean;
  onPressedChange: (next: boolean) => void;
  "aria-label"?: string;
  id?: string;
}) {
  return (
    <Switch id={id} checked={pressed} onCheckedChange={onPressedChange} aria-label={ariaLabel} />
  );
}

function updateProviderOption(
  providerOptions: ReturnType<typeof mergeWorkspaceProviderOptions>,
  provider: OpenAICompatibleProviderName,
  patch: {
    reasoningEffort?: ReasoningEffortValue;
    reasoningSummary?: ReasoningSummaryValue;
    textVerbosity?: TextVerbosityValue;
  },
) {
  return mergeWorkspaceProviderOptions(providerOptions, {
    [provider]: patch,
  });
}

function updateCodexProviderOption(
  providerOptions: ReturnType<typeof mergeWorkspaceProviderOptions>,
  patch: Partial<CodexCliProviderOptions>,
) {
  return mergeWorkspaceProviderOptions(providerOptions, {
    "codex-cli": patch,
  });
}

function updateGoogleProviderOption(
  providerOptions: ReturnType<typeof mergeWorkspaceProviderOptions>,
  patch: Partial<GoogleProviderOptions>,
) {
  const current = providerOptions ? { ...providerOptions } : {};
  const currentGoogle =
    current.google && typeof current.google === "object" && !Array.isArray(current.google)
      ? { ...current.google }
      : {};

  if ("nativeWebSearch" in patch) {
    currentGoogle.nativeWebSearch = patch.nativeWebSearch;
  }
  if ("thinkingConfig" in patch) {
    const currentThinkingConfig =
      currentGoogle.thinkingConfig &&
      typeof currentGoogle.thinkingConfig === "object" &&
      !Array.isArray(currentGoogle.thinkingConfig)
        ? { ...currentGoogle.thinkingConfig }
        : {};
    const patchThinkingConfig = patch.thinkingConfig ?? {};
    if ("thinkingLevel" in patchThinkingConfig) {
      const level = patchThinkingConfig.thinkingLevel;
      if (typeof level === "string" && level.trim().length > 0) {
        currentThinkingConfig.thinkingLevel = level;
      } else {
        delete currentThinkingConfig.thinkingLevel;
      }
    } else {
      delete currentThinkingConfig.thinkingLevel;
    }
    currentGoogle.thinkingConfig =
      Object.keys(currentThinkingConfig).length > 0 ? currentThinkingConfig : {};
  }

  return mergeWorkspaceProviderOptions(providerOptions, {
    google: currentGoogle,
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

  return sortProviderEntriesForSettings(
    PROVIDER_NAMES.filter((provider) => !UI_DISABLED_PROVIDERS.has(provider))
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
      .filter((group) => group.refs.length > 0),
  );
}

function childTargetLabel(ref: string): string {
  const colonIndex = ref.indexOf(":");
  if (colonIndex <= 0) return ref;
  return ref.slice(colonIndex + 1);
}

/** Render a `provider:model` ref as `ProviderName | "model"` for display. */
function friendlyModelRef(ref: string): string {
  const colonIndex = ref.indexOf(":");
  if (colonIndex <= 0) return ref;
  const providerKey = ref.slice(0, colonIndex) as ProviderName;
  const model = ref.slice(colonIndex + 1);
  return `${displayProviderName(providerKey)} | ${model}`;
}

function subagentRoutingModeLabel(mode: "same-provider" | "cross-provider-allowlist"): string {
  return mode === "same-provider" ? "Same model" : "Multiple providers";
}

function providerFromModelRef(ref: string): ProviderName | null {
  const colonIndex = ref.indexOf(":");
  if (colonIndex <= 0) return null;
  const provider = ref.slice(0, colonIndex) as ProviderName;
  return PROVIDER_NAMES.includes(provider) ? provider : null;
}

function hasConfiguredProviderStatus(
  status: { verified?: boolean; authorized?: boolean } | undefined,
): boolean {
  return Boolean(status?.verified || status?.authorized);
}

function useSharedUpdateWorkspaceDefaults() {
  const perWorkspaceSettings = useAppStore((s) => s.perWorkspaceSettings);
  const allWorkspaces = useAppStore((s) => s.workspaces);
  const workspaces = useMemo(
    () => allWorkspaces.filter((workspace) => !isOneOffChatWorkspace(workspace)),
    [allWorkspaces],
  );
  const rawUpdate = useAppStore((s) => s.updateWorkspaceDefaults);
  const projectWorkspaces = useMemo(
    () => workspaces.filter((workspace) => !isOneOffChatWorkspace(workspace)),
    [workspaces],
  );
  type WorkspaceDefaultsPatch = Parameters<typeof rawUpdate>[1];
  return useMemo(() => {
    if (perWorkspaceSettings) return rawUpdate;
    return async (_workspaceId: string, patch: WorkspaceDefaultsPatch) => {
      await Promise.all(projectWorkspaces.map((ws) => rawUpdate(ws.id, patch)));
    };
  }, [perWorkspaceSettings, projectWorkspaces, rawUpdate]);
}

type OpenAiCompatibleModelSettingsCardProps = {
  workspace: Pick<WorkspaceRecord, "id" | "providerOptions">;
  updateWorkspaceDefaults: (
    workspaceId: string,
    patch: { providerOptions?: ReturnType<typeof mergeWorkspaceProviderOptions> },
  ) => Promise<unknown> | undefined;
  providerStatusByName: Record<string, PersistedProviderStatus | undefined>;
};
const MODEL_CARD_FIELD_CLASS = "space-y-1.5";
const MODEL_CARD_PANEL_CLASS = "rounded-lg border border-border/60 bg-background/35 p-3";
const MODEL_CARD_SELECT_CLASS =
  "w-full min-w-0 rounded-sm border-border/70 bg-background/80 shadow-none";

const LOCAL_WEB_SEARCH_PROVIDER_LABELS: Record<LocalWebSearchProviderValue, string> = {
  exa: "Exa",
  parallel: "Parallel",
};

function formatWebSearchBackendLabel(value: WebSearchBackendValue): string {
  return value === "native" ? "Native" : LOCAL_WEB_SEARCH_PROVIDER_LABELS[value];
}

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
  const codexReasoningSummary = getWorkspaceReasoningSummary(
    workspace.providerOptions,
    "codex-cli",
  );

  const sections = (
    [
      {
        key: "codex-cli",
        label: "ChatGPT Subscription",
        verbosity: codexVerbosity,
        reasoningEffort: codexReasoningEffort,
        reasoningSummary: codexReasoningSummary,
      },
      {
        key: "openai",
        label: "OpenAI API",
        verbosity: openAiVerbosity,
        reasoningEffort: openAiReasoningEffort,
        reasoningSummary: openAiReasoningSummary,
      },
    ] as const
  ).filter((section) => {
    const status = providerStatusByName[section.key];
    return hasConfiguredProviderStatus(status);
  });

  if (sections.length === 0) return null;

  return (
    <Card className="border-border/80 bg-card/85">
      <CardHeader>
        <CardTitle>OpenAI &amp; ChatGPT Settings</CardTitle>
        <CardDescription>
          Workspace defaults for ChatGPT Subscription and OpenAI API models.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {sections.map((section) => (
          <div key={section.key} className="space-y-4 rounded-lg border border-border/60 px-4 py-4">
            <Badge variant="outline" className="rounded-sm text-xs font-medium">
              {section.label}
            </Badge>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className={MODEL_CARD_FIELD_CLASS}>
                <div className="text-[13px] font-medium text-foreground">Verbosity</div>
                <Select
                  value={section.verbosity}
                  onValueChange={(value) => {
                    void updateWorkspaceDefaults(workspace.id, {
                      providerOptions: updateProviderOption(
                        workspace.providerOptions,
                        section.key,
                        {
                          textVerbosity: value as TextVerbosityValue,
                        },
                      ),
                    });
                  }}
                >
                  <SelectTrigger
                    aria-label={`${section.label} verbosity`}
                    className={MODEL_CARD_SELECT_CLASS}
                    size="sm"
                  >
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

              <div className={MODEL_CARD_FIELD_CLASS}>
                <div className="text-[13px] font-medium text-foreground">Reasoning effort</div>
                <Select
                  value={section.reasoningEffort}
                  onValueChange={(value) => {
                    void updateWorkspaceDefaults(workspace.id, {
                      providerOptions: updateProviderOption(
                        workspace.providerOptions,
                        section.key,
                        {
                          reasoningEffort: value as ReasoningEffortValue,
                        },
                      ),
                    });
                  }}
                >
                  <SelectTrigger
                    aria-label={`${section.label} reasoning effort`}
                    className={MODEL_CARD_SELECT_CLASS}
                    size="sm"
                  >
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

              <div className={MODEL_CARD_FIELD_CLASS}>
                <div className="text-[13px] font-medium text-foreground">Reasoning summary</div>
                <Select
                  value={section.reasoningSummary}
                  onValueChange={(value) => {
                    void updateWorkspaceDefaults(workspace.id, {
                      providerOptions: updateProviderOption(
                        workspace.providerOptions,
                        section.key,
                        {
                          reasoningSummary: value as ReasoningSummaryValue,
                        },
                      ),
                    });
                  }}
                >
                  <SelectTrigger
                    aria-label={`${section.label} reasoning summary`}
                    className={MODEL_CARD_SELECT_CLASS}
                    size="sm"
                  >
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
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

type SearchSettingsCardProps = {
  workspace: Pick<WorkspaceRecord, "id" | "providerOptions">;
  updateWorkspaceDefaults: (
    workspaceId: string,
    patch: { providerOptions?: ReturnType<typeof mergeWorkspaceProviderOptions> },
  ) => Promise<unknown> | undefined;
  providerStatusByName: Record<string, PersistedProviderStatus | undefined>;
};

export function SearchSettingsCard({
  workspace,
  updateWorkspaceDefaults,
  providerStatusByName,
}: SearchSettingsCardProps) {
  const webSearchBackend = getWorkspaceWebSearchBackend(workspace.providerOptions);
  const googleUsesNativeWebSearch = getWorkspaceGoogleNativeWebSearchEnabled(
    workspace.providerOptions,
    true,
  );
  const localFallbackProvider = getWorkspaceLocalWebSearchProvider(workspace.providerOptions);
  const codexUsesNativeWebSearch = webSearchBackend === "native";
  const effectiveSearchProvider =
    codexUsesNativeWebSearch && !googleUsesNativeWebSearch
      ? localFallbackProvider
      : webSearchBackend;
  const searchProviderUsesNative = effectiveSearchProvider === "native";
  const hasLegacyGeminiSearchOverride = codexUsesNativeWebSearch && !googleUsesNativeWebSearch;
  const codexWebSearchMode = getWorkspaceWebSearchMode(workspace.providerOptions);
  const selectedLocalProvider = searchProviderUsesNative
    ? localFallbackProvider
    : effectiveSearchProvider;
  const selectedLocalProviderMethodId =
    selectedLocalProvider === "parallel" ? "parallel_api_key" : "exa_api_key";
  const selectedLocalProviderMask =
    providerStatusByName.google?.savedApiKeyMasks?.[selectedLocalProviderMethodId];
  const selectedLocalProviderConnected =
    typeof selectedLocalProviderMask === "string" && selectedLocalProviderMask.trim().length > 0;

  const applySearchProvider = (value: WebSearchBackendValue) => {
    void updateWorkspaceDefaults(workspace.id, {
      providerOptions: mergeWorkspaceProviderOptions(workspace.providerOptions, {
        "codex-cli": {
          webSearchBackend: value,
        },
        google: {
          nativeWebSearch: value === "native",
        },
      }),
    });
  };

  const applyLocalFallbackProvider = (value: LocalWebSearchProviderValue) => {
    void updateWorkspaceDefaults(workspace.id, {
      providerOptions: mergeWorkspaceProviderOptions(workspace.providerOptions, {
        "codex-cli": {
          webSearchFallbackBackend: value,
        },
      }),
    });
  };

  return (
    <Card className="border-border/80 bg-card/85">
      <CardHeader>
        <CardTitle>Search</CardTitle>
        <CardDescription>
          Choose provider-native search or a local search tool for models that need one.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-lg border border-border/60 px-4 py-4">
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-4 max-[960px]:flex-col">
              <div className="space-y-1">
                <div className="text-sm font-medium text-foreground">Search provider</div>
                <div className="text-xs text-muted-foreground">
                  {hasLegacyGeminiSearchOverride
                    ? `Google models still use local ${formatWebSearchBackendLabel(selectedLocalProvider)} search from an older workspace override. Changing Search provider here will sync Google and ChatGPT settings.`
                    : searchProviderUsesNative
                      ? "Use provider-native search when the active model supports it. Codex uses Codex app-server native web search in this mode."
                      : `Use the local webSearch tool backed by ${formatWebSearchBackendLabel(effectiveSearchProvider)} for non-Codex models.`}
                </div>
              </div>
              <div className="w-full max-w-52">
                <Select
                  value={effectiveSearchProvider}
                  onValueChange={(value) => applySearchProvider(value as WebSearchBackendValue)}
                >
                  <SelectTrigger
                    aria-label="Workspace search provider"
                    className={MODEL_CARD_SELECT_CLASS}
                    size="sm"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WEB_SEARCH_BACKEND_VALUES.map((entry) => (
                      <SelectItem key={entry} value={entry}>
                        {formatWebSearchBackendLabel(entry)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {searchProviderUsesNative ? (
              <div className="grid gap-3 rounded-lg border border-border/60 bg-background/35 p-3">
                <div className={MODEL_CARD_FIELD_CLASS}>
                  <div className="text-[13px] font-medium text-foreground">
                    For non-Codex models without native search, which local search tool do you want
                    to use?
                  </div>
                  <Select
                    value={localFallbackProvider}
                    onValueChange={(value) =>
                      applyLocalFallbackProvider(value as LocalWebSearchProviderValue)
                    }
                  >
                    <SelectTrigger
                      aria-label="Workspace local search fallback provider"
                      className={MODEL_CARD_SELECT_CLASS}
                      size="sm"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LOCAL_WEB_SEARCH_PROVIDERS.map((entry) => (
                        <SelectItem key={entry} value={entry}>
                          {LOCAL_WEB_SEARCH_PROVIDER_LABELS[entry]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div
                  className={cn(
                    "text-xs",
                    selectedLocalProviderConnected ? "text-muted-foreground" : "text-warning",
                  )}
                >
                  {selectedLocalProviderConnected
                    ? `${LOCAL_WEB_SEARCH_PROVIDER_LABELS[selectedLocalProvider]} is ready as the fallback local search tool for non-Codex models.`
                    : `Add a ${LOCAL_WEB_SEARCH_PROVIDER_LABELS[selectedLocalProvider]} API key in Providers > Tool Providers to use it as the non-Codex fallback local search tool.`}
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-border/60 bg-background/35 p-3 text-xs text-muted-foreground">
                {hasLegacyGeminiSearchOverride
                  ? `Google models currently use local ${LOCAL_WEB_SEARCH_PROVIDER_LABELS[selectedLocalProvider]} search because this workspace still has a Gemini-specific override. Choose Native above to restore provider-native search for both providers.`
                  : `${LOCAL_WEB_SEARCH_PROVIDER_LABELS[selectedLocalProvider]} is the active local search tool for non-Codex models in this workspace.`}
              </div>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-border/60 px-4 py-4">
          <div className="flex items-start justify-between gap-4 max-[960px]:flex-col">
            <div className="space-y-1">
              <div className="text-sm font-medium text-foreground">Codex web search mode</div>
              <div className="text-xs text-muted-foreground">
                ChatGPT Subscription/Codex uses hybrid mode: Codex app-server owns native web
                search, while Cowork keeps coordination tools separate.
              </div>
            </div>
            <div className="w-full max-w-52">
              <Select
                value={codexWebSearchMode}
                disabled={!codexUsesNativeWebSearch}
                onValueChange={(value) => {
                  void updateWorkspaceDefaults(workspace.id, {
                    providerOptions: updateCodexProviderOption(workspace.providerOptions, {
                      webSearchMode: value as WebSearchModeValue,
                    }),
                  });
                }}
              >
                <SelectTrigger
                  aria-label="Codex web search mode"
                  className={MODEL_CARD_SELECT_CLASS}
                  size="sm"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WEB_SEARCH_MODE_VALUES.map((entry) => (
                    <SelectItem key={entry} value={entry}>
                      {entry}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {!codexUsesNativeWebSearch ? (
            <div className="mt-3 rounded-lg border border-border/60 bg-background/70 p-3 text-xs text-muted-foreground">
              Switch search provider to Native to use Codex app-server native web search mode.
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

type GeminiApiSettingsCardProps = {
  workspace: Pick<WorkspaceRecord, "id" | "providerOptions" | "defaultProvider" | "defaultModel">;
  updateWorkspaceDefaults: (
    workspaceId: string,
    patch: { providerOptions?: ReturnType<typeof mergeWorkspaceProviderOptions> },
  ) => Promise<unknown> | undefined;
  providerStatusByName: Record<string, PersistedProviderStatus | undefined>;
  googleDefaultModel: string;
};

export function GeminiApiSettingsCard({
  workspace,
  updateWorkspaceDefaults,
  providerStatusByName,
  googleDefaultModel,
}: GeminiApiSettingsCardProps) {
  if (!hasConfiguredProviderStatus(providerStatusByName.google)) {
    return null;
  }

  const selectedGoogleModel =
    workspace.defaultProvider === "google"
      ? workspace.defaultModel?.trim() || googleDefaultModel
      : googleDefaultModel;
  const googleReasoningEffort = getWorkspaceGoogleReasoningEffort(
    workspace.providerOptions,
    selectedGoogleModel,
  );
  const googleReasoningEffortOptions = getGoogleReasoningEffortValuesForModel(selectedGoogleModel);

  return (
    <Card className="border-border/80 bg-card/85">
      <CardHeader>
        <CardTitle>Gemini API settings</CardTitle>
        <CardDescription>Workspace defaults for Gemini API reasoning behavior.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-lg border border-border/60 px-4 py-4">
          <div className="space-y-3">
            <div className="space-y-1">
              <div className="text-sm font-medium text-foreground">Reasoning effort</div>
              <div className="text-xs text-muted-foreground">
                Applies to <span className="font-mono">{selectedGoogleModel}</span>. Dynamic leaves
                Gemini&apos;s `thinking_level` unset and lets the model choose its own reasoning
                depth. Available values depend on the selected Google model.
              </div>
            </div>
            <div className="max-w-56">
              <Select
                value={googleReasoningEffort}
                onValueChange={(value) => {
                  const nextEffort = value as GoogleReasoningEffortValue;
                  void updateWorkspaceDefaults(workspace.id, {
                    providerOptions: updateGoogleProviderOption(workspace.providerOptions, {
                      thinkingConfig:
                        nextEffort === GOOGLE_DYNAMIC_REASONING_EFFORT
                          ? {}
                          : { thinkingLevel: googleThinkingLevelFromReasoningEffort(nextEffort) },
                    }),
                  });
                }}
              >
                <SelectTrigger
                  aria-label="Gemini reasoning effort"
                  className={MODEL_CARD_SELECT_CLASS}
                  size="sm"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {googleReasoningEffortOptions.map((entry) => (
                    <SelectItem key={entry} value={entry}>
                      {entry === GOOGLE_DYNAMIC_REASONING_EFFORT ? "dynamic (default)" : entry}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

type WorkspaceUserProfileCardProps = {
  workspace: Pick<WorkspaceRecord, "id" | "userName" | "userProfile">;
  updateWorkspaceDefaults: (
    workspaceId: string,
    patch: { userName?: string; userProfile?: Partial<WorkspaceUserProfile> },
  ) => Promise<unknown> | undefined;
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
  }, [workspace]);

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
        },
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
        <CardDescription>Workspace-specific identity and prompt context.</CardDescription>
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
          {saveSuccess && <span className="text-sm text-success">Saved successfully</span>}
        </div>
      </CardContent>
    </Card>
  );
}

type WorkspaceDefaultsSummaryProps = {
  provider: ProviderName;
  model: string;
  childModelRoutingMode: "same-provider" | "cross-provider-allowlist";
  preferredChildLabel: string;
};

function WorkspaceDefaultsSummary({
  provider,
  model,
  childModelRoutingMode,
  preferredChildLabel,
}: WorkspaceDefaultsSummaryProps) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg border border-border/60 bg-card/70 px-3 py-2 text-xs text-muted-foreground">
      <span>Current provider:</span>
      <Badge variant="outline" className="rounded-sm">
        {displayProviderName(provider)}
      </Badge>
      <span>Model:</span>
      <Badge variant="outline" className="rounded-sm">
        {model}
      </Badge>
      <span>Subagent routing:</span>
      <Badge variant="outline" className="rounded-sm">
        {subagentRoutingModeLabel(childModelRoutingMode)}
      </Badge>
      <span>Preferred subagent model:</span>
      <Badge variant="outline" className="rounded-sm">
        {preferredChildLabel}
      </Badge>
    </div>
  );
}

export function WorkspacesPage() {
  const desktopFeatures = useAppStore((s) => s.desktopFeatureFlags);
  const workspacePickerEnabled = desktopFeatures.workspacePicker !== false;
  const workspaceLifecycleEnabled = desktopFeatures.workspaceLifecycle !== false;
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const providerStatusByName = useAppStore((s) => s.providerStatusByName);
  const providerCatalog = useAppStore((s) => s.providerCatalog);
  const providerConnected = useAppStore((s) => s.providerConnected);
  const providerDefaultModelByProvider = useAppStore((s) => s.providerDefaultModelByProvider);
  const providerUiState = useAppStore((s) => s.providerUiState);

  const perWorkspaceSettings = useAppStore((s) => s.perWorkspaceSettings);
  const setPerWorkspaceSettings = useAppStore((s) => s.setPerWorkspaceSettings);

  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const removeWorkspace = useAppStore((s) => s.removeWorkspace);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const updateWorkspaceDefaults = useSharedUpdateWorkspaceDefaults();
  const restartWorkspaceServer = useAppStore((s) => s.restartWorkspaceServer);
  const projectWorkspaces = useMemo(
    () => workspaces.filter((workspace) => !isOneOffChatWorkspace(workspace)),
    [workspaces],
  );

  const ws = useMemo(
    () =>
      projectWorkspaces.find((workspace) => workspace.id === selectedWorkspaceId) ??
      projectWorkspaces[0] ??
      null,
    [projectWorkspaces, selectedWorkspaceId],
  );

  const provider = (ws?.defaultProvider ?? "google") as ProviderName;
  const model = (ws?.defaultModel ?? "").trim();
  const preferredChildModel = (ws?.defaultPreferredChildModel ?? ws?.defaultModel ?? "").trim();
  const childModelRoutingMode = ws?.defaultChildModelRoutingMode ?? "same-provider";
  const preferredChildModelRef = (
    ws?.defaultPreferredChildModelRef ?? `${provider}:${preferredChildModel || model}`
  ).trim();
  const allowedChildModelRefs = ws?.defaultAllowedChildModelRefs ?? [];
  const enableMcp = ws?.defaultEnableMcp ?? true;
  const backupsEnabled = ws?.defaultBackupsEnabled ?? false;
  const yolo = ws?.yolo ?? false;

  const modelSelectorVisibility = useMemo<CatalogVisibilityOptions>(
    () => ({
      hiddenProviders: providerUiState.lmstudio.enabled ? [] : (["lmstudio"] as const),
      hiddenModelsByProvider: {
        lmstudio: providerUiState.lmstudio.hiddenModels,
      },
    }),
    [providerUiState],
  );
  const modelChoices = useMemo(
    () => modelChoicesFromCatalog(providerCatalog, modelSelectorVisibility),
    [providerCatalog, modelSelectorVisibility],
  );
  const availableProviders = useMemo(() => {
    const hiddenProviders = new Set(modelSelectorVisibility.hiddenProviders ?? []);
    const catalogProviders = (
      providerCatalog.length === 0 ? PROVIDER_NAMES : providerCatalog.map((entry) => entry.id)
    ).filter((entry) => !UI_DISABLED_PROVIDERS.has(entry) && !hiddenProviders.has(entry));
    const visibleProviders = sortProviderNamesForSettings(
      [...new Set(catalogProviders)].filter((entry) => {
        const status = providerStatusByName[entry];
        return status ? hasConfiguredProviderStatus(status) : providerConnected.includes(entry);
      }),
    );
    if (!UI_DISABLED_PROVIDERS.has(provider) && !visibleProviders.includes(provider)) {
      visibleProviders.push(provider);
    }
    return visibleProviders;
  }, [modelSelectorVisibility, provider, providerCatalog, providerConnected, providerStatusByName]);
  const currentProviderIsConfigured = availableProviders.includes(provider);
  const effectiveProvider = currentProviderIsConfigured
    ? provider
    : (availableProviders[0] ?? provider);
  const modelControlsDisabled = !currentProviderIsConfigured;
  const configuredProviderSet = useMemo(() => new Set(availableProviders), [availableProviders]);
  const curatedModels = modelChoices[effectiveProvider] ?? [];
  const modelOptions = modelOptionsFromCatalog(
    providerCatalog,
    effectiveProvider,
    model,
    modelSelectorVisibility,
  );
  const hasCustomModel = Boolean(model && !curatedModels.includes(model));
  const preferredChildModelOptions = modelOptionsFromCatalog(
    providerCatalog,
    effectiveProvider,
    preferredChildModel,
    modelSelectorVisibility,
  );
  const hasCustomChildModel = Boolean(
    preferredChildModel && !curatedModels.includes(preferredChildModel),
  );
  const visibleAllowedChildModelRefs = useMemo(
    () =>
      allowedChildModelRefs.filter((ref) => {
        const targetProvider = providerFromModelRef(ref);
        return targetProvider ? configuredProviderSet.has(targetProvider) : false;
      }),
    [allowedChildModelRefs, configuredProviderSet],
  );
  const childTargetGroups = useMemo(
    () =>
      childTargetGroupsFromCatalog(providerCatalog, visibleAllowedChildModelRefs).filter((group) =>
        configuredProviderSet.has(group.provider),
      ),
    [configuredProviderSet, providerCatalog, visibleAllowedChildModelRefs],
  );
  const preferredChildTargetOptions = useMemo(() => {
    if (childModelRoutingMode === "cross-provider-allowlist") {
      return visibleAllowedChildModelRefs;
    }
    return preferredChildModelRef ? [preferredChildModelRef] : [];
  }, [childModelRoutingMode, preferredChildModelRef, visibleAllowedChildModelRefs]);

  const [activeTab, setActiveTab] = useState<"general" | "models" | "profile" | "advanced">(
    "general",
  );
  const [subagentModelsOpen, setSubagentModelsOpen] = useState(false);
  const subagentModelsOpenSeedKey = useRef<string | null>(null);

  useEffect(() => {
    const seedKey = `${ws?.id ?? "none"}:${childModelRoutingMode}`;
    if (subagentModelsOpenSeedKey.current === seedKey) {
      return;
    }
    subagentModelsOpenSeedKey.current = seedKey;
    setSubagentModelsOpen(
      childModelRoutingMode === "cross-provider-allowlist" &&
        visibleAllowedChildModelRefs.length === 0,
    );
  }, [childModelRoutingMode, visibleAllowedChildModelRefs.length, ws?.id]);

  return (
    <div className="space-y-5">
      {projectWorkspaces.length === 0 || !ws ? (
        <Card className="border-border/80 bg-card/85">
          <CardContent className="p-8 text-center">
            {workspaceLifecycleEnabled ? (
              <Button type="button" onClick={() => void addWorkspace()}>
                Add workspace
              </Button>
            ) : (
              <div className="text-sm text-muted-foreground">
                This browser shell stays attached to the current server workspace.
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          <WorkspaceDefaultsSummary
            provider={provider}
            model={model}
            childModelRoutingMode={childModelRoutingMode}
            preferredChildLabel={
              childModelRoutingMode === "same-provider"
                ? preferredChildModel || model
                : friendlyModelRef(preferredChildModelRef)
            }
          />

          <div className="flex space-x-1 rounded-lg bg-muted p-1 border border-border/70 max-w-fit mb-2 relative">
            {(["general", "models", "profile", "advanced"] as const).map((tab) => (
              <Button
                key={tab}
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setActiveTab(tab)}
                className={cn(
                  "relative h-auto rounded-md px-3 py-1.5 text-sm font-medium shadow-none transition-colors",
                  activeTab === tab
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {activeTab === tab && (
                  <motion.div
                    layoutId="workspaces-active-tab"
                    className="app-shadow-surface pointer-events-none absolute inset-0 -z-10 rounded-md border border-border/50 bg-background"
                    transition={{ type: "spring", stiffness: 500, damping: 30 }}
                  />
                )}
                <span className="relative z-10">{tab.charAt(0).toUpperCase() + tab.slice(1)}</span>
              </Button>
            ))}
          </div>

          <div
            className={cn(
              "space-y-5 animate-in fade-in slide-in-from-bottom-2 duration-300",
              activeTab !== "general" && "hidden",
            )}
          >
            {perWorkspaceSettings && (
              <Card className="border-border/80 bg-card/85">
                <CardHeader className="flex-row items-center justify-between space-y-0">
                  <div>
                    <CardTitle>Active workspace</CardTitle>
                    <CardDescription>Selected project for this desktop session.</CardDescription>
                  </div>
                  {workspaceLifecycleEnabled ? (
                    <Button variant="outline" type="button" onClick={() => void addWorkspace()}>
                      Add
                    </Button>
                  ) : null}
                </CardHeader>
                <CardContent className="space-y-3">
                  <div>
                    <div className="text-sm font-medium text-foreground">{ws.name}</div>
                    <div className="text-xs text-muted-foreground">{ws.path}</div>
                  </div>
                  {workspacePickerEnabled && projectWorkspaces.length > 1 ? (
                    <Select value={ws.id} onValueChange={(value) => void selectWorkspace(value)}>
                      <SelectTrigger aria-label="Active workspace">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {projectWorkspaces.map((workspace) => (
                          <SelectItem key={workspace.id} value={workspace.id}>
                            {workspace.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                </CardContent>
              </Card>
            )}

            <Card className="border-border/80 bg-card/85">
              <CardHeader>
                <CardTitle>Behavior</CardTitle>
                <CardDescription>
                  Execution and visibility options for this workspace.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-start justify-between gap-4 max-[960px]:flex-col">
                  <div className="grid gap-1.5">
                    <Label
                      htmlFor="mcp-toggle"
                      className="text-sm font-medium leading-none cursor-pointer"
                    >
                      MCP tools
                    </Label>
                    <div className="text-xs text-muted-foreground">
                      Allow configured MCP servers. In ChatGPT Subscription/Codex hybrid mode,
                      Cowork exposes these as dynamic tools while Codex keeps local shell, files,
                      and web native.
                    </div>
                  </div>
                  <ToggleChip
                    id="mcp-toggle"
                    pressed={enableMcp}
                    aria-label="Enable MCP tools"
                    onPressedChange={(next) => {
                      if (!ws) return;
                      void updateWorkspaceDefaults(ws.id, { defaultEnableMcp: next });
                    }}
                  />
                </div>

                <div className="flex items-start justify-between gap-4 max-[960px]:flex-col">
                  <div className="grid gap-1.5">
                    <Label
                      htmlFor="backups-toggle"
                      className="text-sm font-medium leading-none cursor-pointer"
                    >
                      Workspace backups
                    </Label>
                    <div className="text-xs text-muted-foreground">
                      Opt into Cowork-managed recovery snapshots for sessions in this workspace.
                    </div>
                  </div>
                  <ToggleChip
                    id="backups-toggle"
                    pressed={backupsEnabled}
                    aria-label="Enable workspace backups"
                    onPressedChange={(next) => {
                      if (!ws) return;
                      void updateWorkspaceDefaults(ws.id, { defaultBackupsEnabled: next });
                    }}
                  />
                </div>

                <div className="flex items-start justify-between gap-4 max-[960px]:flex-col">
                  <div className="grid gap-1.5">
                    <Label
                      htmlFor="yolo-toggle"
                      className="text-sm font-medium leading-none cursor-pointer"
                    >
                      Run shell commands without asking
                    </Label>
                    <div className="text-xs text-muted-foreground">
                      Skip confirmation prompts and run shell commands immediately without review.
                    </div>
                  </div>
                  <ToggleChip
                    id="yolo-toggle"
                    pressed={yolo}
                    aria-label="Run shell commands without asking"
                    onPressedChange={async (next) => {
                      if (!ws) return;
                      const confirmed = await confirmAction({
                        title: next
                          ? "Enable auto-approve commands"
                          : "Disable auto-approve commands",
                        message: next
                          ? "Enable auto-approve? The agent will run shell commands on your machine without asking for review first."
                          : "Disable auto-approve?",
                        detail: next
                          ? "This is a high-risk setting. The server will restart to apply this change."
                          : undefined,
                        confirmLabel: next ? "Enable" : "Disable",
                        cancelLabel: "Cancel",
                        kind: "warning",
                        defaultAction: "cancel",
                      });
                      if (confirmed) {
                        void updateWorkspaceDefaults(ws.id, { yolo: next }).then(() => {
                          if (workspaceLifecycleEnabled) {
                            return restartWorkspaceServer(ws.id);
                          }
                        });
                      }
                    }}
                  />
                </div>
              </CardContent>
            </Card>

            <SearchSettingsCard
              workspace={ws}
              updateWorkspaceDefaults={updateWorkspaceDefaults}
              providerStatusByName={providerStatusByName}
            />
          </div>

          <div
            className={cn(
              "space-y-5 animate-in fade-in slide-in-from-bottom-2 duration-300",
              activeTab !== "models" && "hidden",
            )}
          >
            <Card className="border-border/80 bg-card/85">
              <CardHeader>
                <CardTitle>Model</CardTitle>
                <CardDescription>
                  The default provider and model for new sessions in this workspace.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {availableProviders.length === 0 ? (
                  <div className={MODEL_CARD_PANEL_CLASS}>
                    <div className="text-sm font-medium text-foreground">
                      No configured providers
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Set up a provider first. Only verified or authorized providers appear in this
                      list.
                    </div>
                  </div>
                ) : (
                  <>
                    {!currentProviderIsConfigured ? (
                      <div className={MODEL_CARD_PANEL_CLASS}>
                        <div className="text-sm font-medium text-foreground">
                          Current provider is not set up here
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          Choose one of the configured providers below. Only verified or authorized
                          providers are shown.
                        </div>
                      </div>
                    ) : (
                      <div className="text-xs text-muted-foreground">
                        Don't see your provider? Add one in Providers settings.
                      </div>
                    )}

                    <div className="grid gap-3 lg:grid-cols-2">
                      <div className={MODEL_CARD_FIELD_CLASS}>
                        <div className="text-sm font-medium text-foreground">Provider</div>
                        <Select
                          value={effectiveProvider}
                          onValueChange={(value) => {
                            if (!ws) return;
                            const nextProvider = value as ProviderName;
                            if (UI_DISABLED_PROVIDERS.has(nextProvider)) return;
                            const nextDefault =
                              providerDefaultModelByProvider[nextProvider]?.trim() ||
                              modelChoices[nextProvider]?.[0] ||
                              defaultModelForProvider(nextProvider);
                            if (!nextDefault) return;
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
                          <SelectTrigger
                            aria-label="Default provider"
                            className={MODEL_CARD_SELECT_CLASS}
                            size="sm"
                          >
                            <SelectValue placeholder="Choose configured provider" />
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

                      <div className={MODEL_CARD_FIELD_CLASS}>
                        <div className="text-sm font-medium text-foreground">Default model</div>
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
                          disabled={modelControlsDisabled}
                        >
                          <SelectTrigger
                            aria-label="Default model"
                            className={MODEL_CARD_SELECT_CLASS}
                            size="sm"
                          >
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

                      <div className={MODEL_CARD_FIELD_CLASS}>
                        <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                          Subagent routing
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="cursor-help">
                                  <InfoIcon className="size-3.5 text-muted-foreground" />
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>
                                {childModelRoutingMode === "same-provider"
                                  ? "Subagents use your default model by default. This setting preselects which model from the same provider to suggest instead."
                                  : "If a selected subagent model isn't available, your default model will be used instead."}
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        </div>
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
                          disabled={modelControlsDisabled}
                        >
                          <SelectTrigger
                            aria-label="Subagent routing"
                            className={MODEL_CARD_SELECT_CLASS}
                            size="sm"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="same-provider">Same model</SelectItem>
                            <SelectItem value="cross-provider-allowlist">
                              Multiple providers
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        <div className="text-xs text-muted-foreground">
                          Lets Cowork subagents use models from different providers you've set up.
                          Codex can call these subagents through hybrid dynamic tools.
                        </div>
                      </div>

                      {childModelRoutingMode === "same-provider" ? (
                        <div className={MODEL_CARD_FIELD_CLASS}>
                          <div className="text-sm font-medium text-foreground">
                            Preferred subagent model
                          </div>
                          <Select
                            value={preferredChildModel}
                            onValueChange={(value) => {
                              if (!ws) return;
                              void updateWorkspaceDefaults(ws.id, {
                                defaultPreferredChildModel: value,
                                defaultPreferredChildModelRef: `${effectiveProvider}:${value}`,
                              });
                            }}
                            disabled={modelControlsDisabled}
                          >
                            <SelectTrigger
                              aria-label="Preferred subagent model"
                              className={MODEL_CARD_SELECT_CLASS}
                              size="sm"
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {preferredChildModelOptions.map((entry) => (
                                <SelectItem key={entry} value={entry}>
                                  {hasCustomChildModel && entry === preferredChildModel
                                    ? `${entry} (custom)`
                                    : entry}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      ) : (
                        <div className={MODEL_CARD_FIELD_CLASS}>
                          <div className="text-sm font-medium text-foreground">
                            Preferred subagent model
                          </div>
                          <Select
                            value={
                              preferredChildTargetOptions.includes(preferredChildModelRef)
                                ? preferredChildModelRef
                                : undefined
                            }
                            onValueChange={(value) => {
                              if (!ws) return;
                              void updateWorkspaceDefaults(ws.id, {
                                defaultPreferredChildModelRef: value,
                              });
                            }}
                            disabled={
                              modelControlsDisabled || preferredChildTargetOptions.length === 0
                            }
                          >
                            <SelectTrigger
                              aria-label="Preferred subagent model"
                              className={MODEL_CARD_SELECT_CLASS}
                              size="sm"
                            >
                              <SelectValue placeholder="Select subagent models first" />
                            </SelectTrigger>
                            <SelectContent>
                              {preferredChildTargetOptions.map((entry) => (
                                <SelectItem key={entry} value={entry}>
                                  {friendlyModelRef(entry)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                    </div>

                    {childModelRoutingMode === "same-provider" ? null : (
                      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(16rem,20rem)]">
                        <Collapsible
                          open={subagentModelsOpen}
                          onOpenChange={setSubagentModelsOpen}
                          className={cn(MODEL_CARD_PANEL_CLASS, "space-y-3")}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <div className="text-sm font-medium text-foreground">
                                Subagent Models
                              </div>
                              <div className="text-xs text-muted-foreground">
                                Only providers you've set up are shown.
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <Badge variant="outline" className="rounded-sm">
                                {visibleAllowedChildModelRefs.length} selected
                              </Badge>
                              <CollapsibleTrigger asChild>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
                                >
                                  {subagentModelsOpen ? "Hide" : "Show"}
                                  <ChevronDownIcon
                                    className={cn(
                                      "size-3.5 transition-transform",
                                      subagentModelsOpen && "rotate-180",
                                    )}
                                  />
                                </Button>
                              </CollapsibleTrigger>
                            </div>
                          </div>

                          <CollapsibleContent className="space-y-3 border-t border-border/60 pt-3">
                            {childTargetGroups.length > 0 ? (
                              <div className="max-h-72 space-y-3 overflow-auto pr-1">
                                {childTargetGroups.map((group) => (
                                  <div key={group.provider} className="space-y-2">
                                    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                      {displayProviderName(group.provider)}
                                    </div>
                                    <div className="grid gap-2 xl:grid-cols-2">
                                      {group.refs.map((ref) => {
                                        const checked = visibleAllowedChildModelRefs.includes(ref);
                                        const childModelCheckboxId = `allowed-child-model-${ws?.id ?? "workspace"}-${ref}`;
                                        return (
                                          <div
                                            key={ref}
                                            className="flex items-center gap-2 rounded-sm border border-border/60 px-3 py-2 text-sm"
                                          >
                                            <Checkbox
                                              id={childModelCheckboxId}
                                              checked={checked}
                                              onCheckedChange={(nextChecked) => {
                                                if (!ws) return;
                                                const nextRefs =
                                                  nextChecked === true
                                                    ? [...visibleAllowedChildModelRefs, ref]
                                                    : visibleAllowedChildModelRefs.filter(
                                                        (entry) => entry !== ref,
                                                      );
                                                const dedupedRefs = [...new Set(nextRefs)];
                                                const nextPreferred = dedupedRefs.includes(
                                                  preferredChildModelRef,
                                                )
                                                  ? preferredChildModelRef
                                                  : (dedupedRefs[0] ??
                                                    `${effectiveProvider}:${preferredChildModel || model}`);
                                                void updateWorkspaceDefaults(ws.id, {
                                                  defaultAllowedChildModelRefs: dedupedRefs,
                                                  defaultPreferredChildModelRef: nextPreferred,
                                                });
                                              }}
                                              aria-label={`Allow subagent model ${ref}`}
                                              disabled={modelControlsDisabled}
                                            />
                                            <label htmlFor={childModelCheckboxId}>
                                              {childTargetLabel(ref)}
                                            </label>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="text-xs text-muted-foreground">
                                Set up another provider for more subagent model options.
                              </div>
                            )}
                          </CollapsibleContent>
                        </Collapsible>
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>

            <OpenAiCompatibleModelSettingsCard
              workspace={ws}
              updateWorkspaceDefaults={updateWorkspaceDefaults}
              providerStatusByName={providerStatusByName}
            />
            <GeminiApiSettingsCard
              workspace={ws}
              updateWorkspaceDefaults={updateWorkspaceDefaults}
              providerStatusByName={providerStatusByName}
              googleDefaultModel={
                providerDefaultModelByProvider.google?.trim() || defaultModelForProvider("google")
              }
            />
          </div>

          <div
            className={cn(
              "space-y-5 animate-in fade-in slide-in-from-bottom-2 duration-300",
              activeTab !== "profile" && "hidden",
            )}
          >
            <WorkspaceUserProfileCard
              workspace={ws}
              updateWorkspaceDefaults={updateWorkspaceDefaults}
            />
          </div>

          <div
            className={cn(
              "space-y-5 animate-in fade-in slide-in-from-bottom-2 duration-300",
              activeTab !== "advanced" && "hidden",
            )}
          >
            <Card className="border-border/80 bg-card/85">
              <CardHeader>
                <CardTitle>Advanced</CardTitle>
                <CardDescription>Maintenance and destructive actions.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-start justify-between gap-4 max-[960px]:flex-col">
                  <div>
                    <div className="text-sm font-medium">Configure settings by workspace</div>
                    <div className="text-xs text-muted-foreground">
                      When enabled, each workspace has its own provider, model, and behavior
                      settings.
                    </div>
                  </div>
                  <Switch
                    checked={perWorkspaceSettings}
                    aria-label="Configure settings by workspace"
                    onCheckedChange={async (checked) => {
                      if (!checked && workspaces.length > 1) {
                        const confirmed = await confirmAction({
                          title: "Share settings across workspaces",
                          message:
                            "All workspaces will be synced to the current workspace's settings.",
                          detail:
                            "This will overwrite provider, model, and behavior settings on other workspaces.",
                          confirmLabel: "Share settings",
                          cancelLabel: "Cancel",
                          kind: "warning",
                          defaultAction: "cancel",
                        });
                        if (!confirmed) return;
                      }
                      setPerWorkspaceSettings(checked);
                    }}
                  />
                </div>

                {workspaceLifecycleEnabled ? (
                  <div className="flex items-center justify-between gap-3 max-[960px]:items-start max-[960px]:flex-col">
                    <div>
                      <div className="text-sm font-medium">Restart server</div>
                      <div className="text-xs text-muted-foreground">
                        Restart the workspace agent server if unresponsive.
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      type="button"
                      onClick={() => void restartWorkspaceServer(ws.id)}
                    >
                      Restart
                    </Button>
                  </div>
                ) : null}

                {workspaceLifecycleEnabled ? (
                  <div className="flex items-center justify-between gap-3 max-[960px]:items-start max-[960px]:flex-col">
                    <div>
                      <div className="text-sm font-medium">Remove workspace</div>
                      <div className="text-xs text-muted-foreground">
                        Remove this workspace from the app. Your files on disk are not affected.
                      </div>
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
                ) : null}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
