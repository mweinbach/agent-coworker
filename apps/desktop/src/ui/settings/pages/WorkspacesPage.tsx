import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { ChevronDownIcon, InfoIcon, PlusIcon, XIcon } from "lucide-react";

import { defaultModelForProvider } from "@cowork/providers/catalog";

import {
  getWorkspaceReasoningEffort,
  getWorkspaceReasoningSummary,
  getWorkspaceTextVerbosity,
  getWorkspaceWebSearchAllowedDomains,
  getWorkspaceWebSearchBackend,
  getWorkspaceWebSearchContextSize,
  getWorkspaceWebSearchLocation,
  getWorkspaceWebSearchMode,
  mergeWorkspaceProviderOptions,
  REASONING_EFFORT_VALUES,
  REASONING_SUMMARY_VALUES,
  TEXT_VERBOSITY_VALUES,
  WEB_SEARCH_BACKEND_VALUES,
  WEB_SEARCH_CONTEXT_SIZE_VALUES,
  WEB_SEARCH_MODE_VALUES,
  type CodexCliProviderOptions,
  type OpenAICompatibleProviderName,
  type ReasoningEffortValue,
  type ReasoningSummaryValue,
  type TextVerbosityValue,
  type WebSearchBackendValue,
  type WebSearchContextSizeValue,
  type WebSearchModeValue,
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../../components/ui/collapsible";
import { Input } from "../../../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { Textarea } from "../../../components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../../components/ui/tooltip";
import { confirmAction } from "../../../lib/desktopCommands";
import {
  modelChoicesFromCatalog,
  modelOptionsFromCatalog,
  UI_DISABLED_PROVIDERS,
} from "../../../lib/modelChoices";
import {
  sortProviderEntriesForSettings,
  sortProviderNamesForSettings,
} from "../../../lib/providerOrdering";
import type { ProviderName } from "../../../lib/wsProtocol";
import { PROVIDER_NAMES } from "../../../lib/wsProtocol";
import { cn } from "../../../lib/utils";
import { displayProviderName } from "../../../lib/providerDisplayNames";

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

function updateCodexProviderOption(
  providerOptions: ReturnType<typeof mergeWorkspaceProviderOptions>,
  patch: Partial<CodexCliProviderOptions>,
) {
  return mergeWorkspaceProviderOptions(providerOptions, {
    "codex-cli": patch,
  });
}

function normalizeAllowedDomainEntry(value: string): string | null {
  let normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  normalized = normalized.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  normalized = normalized.split(/[/?#]/, 1)[0] ?? "";
  normalized = normalized.replace(/:\d+$/, "");
  normalized = normalized.replace(/^\.+|\.+$/g, "");
  if (!normalized) return null;
  return /^[a-z0-9*.-]+$/.test(normalized) ? normalized : null;
}

function parseAllowedDomainInput(value: string): string[] {
  const seen = new Set<string>();
  for (const token of value.split(/[\s,;]+/)) {
    const normalized = normalizeAllowedDomainEntry(token);
    if (normalized) seen.add(normalized);
  }
  return [...seen];
}

type AllowedDomainsFieldProps = {
  domains: string[];
  onChange: (domains: string[]) => void;
};

function AllowedDomainsField({ domains, onChange }: AllowedDomainsFieldProps) {
  const [draft, setDraft] = useState("");
  const parsedDraft = useMemo(() => parseAllowedDomainInput(draft), [draft]);
  const domainsKey = domains.join("\n");

  useEffect(() => {
    setDraft("");
  }, [domainsKey]);

  const addDomains = () => {
    if (parsedDraft.length === 0) return;
    onChange([...new Set([...domains, ...parsedDraft])]);
    setDraft("");
  };

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-[13px] font-medium text-foreground">Allowed domains</div>
        <Badge variant="outline" className="h-4 rounded-sm px-1.5 text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
          Optional
        </Badge>
        <button
          type="button"
          aria-label="Allowed domains help"
          title="Open to all domains unless you add one or more domains here."
          className="inline-flex size-4 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <InfoIcon className="size-3" />
        </button>
      </div>

      <div className="flex items-center gap-2">
        <Input
          aria-label="Codex allowed domains input"
          className={cn(MODEL_SETTINGS_INPUT_CLASS, "text-xs")}
          placeholder="Paste domains or URLs"
          value={draft}
          onInput={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            addDomains();
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0 rounded-sm px-2 shadow-none"
          onClick={addDomains}
          disabled={parsedDraft.length === 0}
        >
          <PlusIcon data-icon />
          Add
        </Button>
      </div>

      <div className="text-xs text-muted-foreground">
        Paste one or more domains or URLs. We strip protocol, paths, ports, and duplicates.
      </div>

      <div className="max-h-24 overflow-y-auto rounded-sm border border-dashed border-border/60 bg-background/35 p-1.5">
        {domains.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {domains.map((domain) => (
              <Badge key={domain} variant="outline" className="h-6 rounded-sm gap-1 pr-1 pl-1.5 text-[11px]">
                <span className="max-w-[12rem] truncate">{domain}</span>
                <button
                  type="button"
                  aria-label={`Remove allowed domain ${domain}`}
                  className="inline-flex size-4 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  onClick={() => onChange(domains.filter((entry) => entry !== domain))}
                >
                  <XIcon className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
        ) : (
          <div className="px-1 py-1.5 text-xs text-muted-foreground">
            Open to all domains unless you add one or more here.
          </div>
        )}
      </div>
    </div>
  );
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
    PROVIDER_NAMES
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

function hasConfiguredProviderStatus(status: { verified?: boolean; authorized?: boolean } | undefined): boolean {
  return Boolean(status?.verified || status?.authorized);
}

function useSharedUpdateWorkspaceDefaults() {
  const perWorkspaceSettings = useAppStore((s) => s.perWorkspaceSettings);
  const workspaces = useAppStore((s) => s.workspaces);
  const rawUpdate = useAppStore((s) => s.updateWorkspaceDefaults);
  return useMemo(() => {
    if (perWorkspaceSettings) return rawUpdate;
    return async (workspaceId: string, patch: any) => {
      await Promise.all(workspaces.map((ws) => rawUpdate(ws.id, patch)));
    };
  }, [perWorkspaceSettings, workspaces, rawUpdate]);
}

type OpenAiCompatibleModelSettingsCardProps = {
  workspace: Pick<WorkspaceRecord, "id" | "providerOptions">;
  updateWorkspaceDefaults: (
    workspaceId: string,
    patch: { providerOptions?: ReturnType<typeof mergeWorkspaceProviderOptions> },
  ) => Promise<unknown> | void;
  providerStatusByName: Record<string, any>;
};

const MODEL_SETTINGS_SELECT_CLASS = "w-full min-w-0 rounded-sm border-border/70 bg-background/80 shadow-none sm:w-36";
const MODEL_SETTINGS_INPUT_CLASS = "h-8 rounded-sm border-border/70 bg-background/80 shadow-none";
const MODEL_CARD_FIELD_CLASS = "space-y-1.5";
const MODEL_CARD_PANEL_CLASS = "rounded-lg border border-border/60 bg-background/35 p-3";
const MODEL_CARD_SELECT_CLASS = "w-full min-w-0 rounded-sm border-border/70 bg-background/80 shadow-none";

export function OpenAiCompatibleModelSettingsCard({
  workspace,
  updateWorkspaceDefaults,
  providerStatusByName,
}: OpenAiCompatibleModelSettingsCardProps) {
  const [codexWebSearchAdvancedOpen, setCodexWebSearchAdvancedOpen] = useState(false);
  const openAiVerbosity = getWorkspaceTextVerbosity(workspace.providerOptions, "openai");
  const openAiReasoningEffort = getWorkspaceReasoningEffort(workspace.providerOptions, "openai");
  const openAiReasoningSummary = getWorkspaceReasoningSummary(workspace.providerOptions, "openai");
  const codexVerbosity = getWorkspaceTextVerbosity(workspace.providerOptions, "codex-cli");
  const codexReasoningEffort = getWorkspaceReasoningEffort(workspace.providerOptions, "codex-cli");
  const codexReasoningSummary = getWorkspaceReasoningSummary(workspace.providerOptions, "codex-cli");
  const codexWebSearchBackend = getWorkspaceWebSearchBackend(workspace.providerOptions);
  const codexUsesNativeWebSearch = codexWebSearchBackend === "native";
  const codexWebSearchMode = getWorkspaceWebSearchMode(workspace.providerOptions);
  const codexWebSearchContextSize = getWorkspaceWebSearchContextSize(workspace.providerOptions);
  const codexWebSearchAllowedDomains = getWorkspaceWebSearchAllowedDomains(workspace.providerOptions);
  const codexWebSearchLocation = getWorkspaceWebSearchLocation(workspace.providerOptions);

  const sections = ([
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
  ] as const).filter((section) => {
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
                      providerOptions: updateProviderOption(workspace.providerOptions, section.key, {
                        textVerbosity: value as TextVerbosityValue,
                      }),
                    });
                  }}
                >
                  <SelectTrigger aria-label={`${section.label} verbosity`} className={MODEL_CARD_SELECT_CLASS} size="sm">
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
                      providerOptions: updateProviderOption(workspace.providerOptions, section.key, {
                        reasoningEffort: value as ReasoningEffortValue,
                      }),
                    });
                  }}
                >
                  <SelectTrigger aria-label={`${section.label} reasoning effort`} className={MODEL_CARD_SELECT_CLASS} size="sm">
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
                      providerOptions: updateProviderOption(workspace.providerOptions, section.key, {
                        reasoningSummary: value as ReasoningSummaryValue,
                      }),
                    });
                  }}
                >
                  <SelectTrigger aria-label={`${section.label} reasoning summary`} className={MODEL_CARD_SELECT_CLASS} size="sm">
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

            {section.key === "codex-cli" ? (
              <div className="space-y-3 border-t border-border/50 pt-3">
                <div className="flex items-center justify-between">
                  <div className="text-[13px] font-medium text-foreground">Web search</div>
                  <Select
                    value={codexWebSearchBackend}
                    onValueChange={(value) => {
                      void updateWorkspaceDefaults(workspace.id, {
                        providerOptions: updateCodexProviderOption(workspace.providerOptions, {
                          webSearchBackend: value as WebSearchBackendValue,
                        }),
                      });
                    }}
                  >
                    <SelectTrigger
                      aria-label="Codex web search backend"
                      className={cn(MODEL_CARD_SELECT_CLASS, "w-32")}
                      size="sm"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {WEB_SEARCH_BACKEND_VALUES.map((entry) => (
                        <SelectItem key={entry} value={entry}>
                          {entry === "native" ? "Built-in" : "Exa"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <Collapsible open={codexWebSearchAdvancedOpen} onOpenChange={setCodexWebSearchAdvancedOpen}>
                  <CollapsibleTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-auto justify-between rounded-sm px-0 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground"
                    >
                      <span>Advanced options</span>
                      <ChevronDownIcon
                        data-icon
                        className={cn("size-3.5 transition-transform", codexWebSearchAdvancedOpen && "rotate-180")}
                      />
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="space-y-4 border-t border-border/60 pt-3">
                    {codexUsesNativeWebSearch ? (
                      <>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className={MODEL_CARD_FIELD_CLASS}>
                            <div className="text-[13px] font-medium text-foreground">Search mode</div>
                            <Select
                              value={codexWebSearchMode}
                              onValueChange={(value) => {
                                void updateWorkspaceDefaults(workspace.id, {
                                  providerOptions: updateCodexProviderOption(workspace.providerOptions, {
                                    webSearchMode: value as WebSearchModeValue,
                                  }),
                                });
                              }}
                            >
                              <SelectTrigger aria-label="Codex web search mode" className={MODEL_CARD_SELECT_CLASS} size="sm">
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
                            <div className="text-xs text-muted-foreground">
                              Cached uses indexed results. Live allows live internet access.
                            </div>
                          </div>

                          <div className={MODEL_CARD_FIELD_CLASS}>
                            <div className="text-[13px] font-medium text-foreground">Context size</div>
                            <Select
                              value={codexWebSearchContextSize}
                              onValueChange={(value) => {
                                void updateWorkspaceDefaults(workspace.id, {
                                  providerOptions: updateCodexProviderOption(workspace.providerOptions, {
                                    webSearch: {
                                      contextSize: value as WebSearchContextSizeValue,
                                    },
                                  }),
                                });
                              }}
                            >
                              <SelectTrigger aria-label="Codex web search context size" className={MODEL_CARD_SELECT_CLASS} size="sm">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {WEB_SEARCH_CONTEXT_SIZE_VALUES.map((entry) => (
                                  <SelectItem key={entry} value={entry}>
                                    {entry}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>

                        <AllowedDomainsField
                          domains={codexWebSearchAllowedDomains}
                          onChange={(allowedDomains) => {
                            void updateWorkspaceDefaults(workspace.id, {
                              providerOptions: updateCodexProviderOption(workspace.providerOptions, {
                                webSearch: {
                                  allowedDomains,
                                },
                              }),
                            });
                          }}
                        />

                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                          <div className={MODEL_CARD_FIELD_CLASS}>
                            <div className="text-[13px] font-medium text-foreground">Country</div>
                            <Input
                              aria-label="Codex web search country"
                              className={MODEL_SETTINGS_INPUT_CLASS}
                              autoComplete="off"
                              value={codexWebSearchLocation.country ?? ""}
                              onChange={(event) => {
                                void updateWorkspaceDefaults(workspace.id, {
                                  providerOptions: updateCodexProviderOption(workspace.providerOptions, {
                                    webSearch: {
                                      location: {
                                        country: event.target.value,
                                      },
                                    },
                                  }),
                                });
                              }}
                            />
                          </div>
                          <div className={MODEL_CARD_FIELD_CLASS}>
                            <div className="text-[13px] font-medium text-foreground">Region</div>
                            <Input
                              aria-label="Codex web search region"
                              className={MODEL_SETTINGS_INPUT_CLASS}
                              autoComplete="off"
                              value={codexWebSearchLocation.region ?? ""}
                              onChange={(event) => {
                                void updateWorkspaceDefaults(workspace.id, {
                                  providerOptions: updateCodexProviderOption(workspace.providerOptions, {
                                    webSearch: {
                                      location: {
                                        region: event.target.value,
                                      },
                                    },
                                  }),
                                });
                              }}
                            />
                          </div>
                          <div className={MODEL_CARD_FIELD_CLASS}>
                            <div className="text-[13px] font-medium text-foreground">City</div>
                            <Input
                              aria-label="Codex web search city"
                              className={MODEL_SETTINGS_INPUT_CLASS}
                              autoComplete="off"
                              value={codexWebSearchLocation.city ?? ""}
                              onChange={(event) => {
                                void updateWorkspaceDefaults(workspace.id, {
                                  providerOptions: updateCodexProviderOption(workspace.providerOptions, {
                                    webSearch: {
                                      location: {
                                        city: event.target.value,
                                      },
                                    },
                                  }),
                                });
                              }}
                            />
                          </div>
                          <div className={MODEL_CARD_FIELD_CLASS}>
                            <div className="text-[13px] font-medium text-foreground">Timezone</div>
                            <Input
                              aria-label="Codex web search timezone"
                              className={MODEL_SETTINGS_INPUT_CLASS}
                              autoComplete="off"
                              placeholder="America/New_York"
                              value={codexWebSearchLocation.timezone ?? ""}
                              onChange={(event) => {
                                void updateWorkspaceDefaults(workspace.id, {
                                  providerOptions: updateCodexProviderOption(workspace.providerOptions, {
                                    webSearch: {
                                      location: {
                                        timezone: event.target.value,
                                      },
                                    },
                                  }),
                                });
                              }}
                            />
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="rounded-lg border border-border/60 bg-background/70 p-3 text-xs text-muted-foreground">
                        Context, domain, and location settings appear here when web search is set to Built-in.
                      </div>
                    )}
                  </CollapsibleContent>
                </Collapsible>
              </div>
            ) : null}
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
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const providerStatusByName = useAppStore((s) => s.providerStatusByName);
  const providerCatalog = useAppStore((s) => s.providerCatalog);
  const providerConnected = useAppStore((s) => s.providerConnected);
  const providerDefaultModelByProvider = useAppStore((s) => s.providerDefaultModelByProvider);

  const perWorkspaceSettings = useAppStore((s) => s.perWorkspaceSettings);
  const setPerWorkspaceSettings = useAppStore((s) => s.setPerWorkspaceSettings);

  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const removeWorkspace = useAppStore((s) => s.removeWorkspace);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const updateWorkspaceDefaults = useSharedUpdateWorkspaceDefaults();
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
  const availableProviders = useMemo(() => {
    const catalogProviders = (
      providerCatalog.length === 0
        ? PROVIDER_NAMES
        : providerCatalog.map((entry) => entry.id)
    ).filter((entry) => !UI_DISABLED_PROVIDERS.has(entry));
    return sortProviderNamesForSettings(
      [...new Set(catalogProviders)].filter((entry) => {
        const status = providerStatusByName[entry];
        return status ? hasConfiguredProviderStatus(status) : providerConnected.includes(entry);
      }),
    );
  }, [providerCatalog, providerConnected, providerStatusByName]);
  const currentProviderIsConfigured = availableProviders.includes(provider);
  const effectiveProvider = currentProviderIsConfigured ? provider : (availableProviders[0] ?? provider);
  const modelControlsDisabled = !currentProviderIsConfigured;
  const configuredProviderSet = useMemo(() => new Set(availableProviders), [availableProviders]);
  const curatedModels = modelChoices[effectiveProvider] ?? [];
  const modelOptions = modelOptionsFromCatalog(providerCatalog, effectiveProvider, model);
  const hasCustomModel = Boolean(model && !curatedModels.includes(model));
  const preferredChildModelOptions = modelOptionsFromCatalog(providerCatalog, effectiveProvider, preferredChildModel);
  const hasCustomChildModel = Boolean(preferredChildModel && !curatedModels.includes(preferredChildModel));
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

  const [activeTab, setActiveTab] = useState<"general" | "models" | "profile" | "advanced">("general");
  const [subagentModelsOpen, setSubagentModelsOpen] = useState(false);

  useEffect(() => {
    setSubagentModelsOpen(
      childModelRoutingMode === "cross-provider-allowlist" && visibleAllowedChildModelRefs.length === 0,
    );
  }, [childModelRoutingMode, visibleAllowedChildModelRefs.length, ws?.id]);

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">Workspaces</h1>
        <p className="text-sm text-muted-foreground">Set up how your AI works in this project.</p>
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
          <WorkspaceDefaultsSummary
            provider={provider}
            model={model}
            childModelRoutingMode={childModelRoutingMode}
            preferredChildLabel={childModelRoutingMode === "same-provider" ? (preferredChildModel || model) : friendlyModelRef(preferredChildModelRef)}
          />

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
            {perWorkspaceSettings && (
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
            )}

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
                {availableProviders.length === 0 ? (
                  <div className={MODEL_CARD_PANEL_CLASS}>
                    <div className="text-sm font-medium text-foreground">No configured providers</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Set up a provider first. Only verified or authorized providers appear in this list.
                    </div>
                  </div>
                ) : (
                  <>
                    {!currentProviderIsConfigured ? (
                      <div className={MODEL_CARD_PANEL_CLASS}>
                        <div className="text-sm font-medium text-foreground">Current provider is not set up here</div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          Choose one of the configured providers below. Only verified or authorized providers are shown.
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
                          value={currentProviderIsConfigured ? effectiveProvider : undefined}
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
                          <SelectTrigger aria-label="Default provider" className={MODEL_CARD_SELECT_CLASS} size="sm">
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
                          <SelectTrigger aria-label="Default model" className={MODEL_CARD_SELECT_CLASS} size="sm">
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
                              <TooltipContent side="top">
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
                          <SelectTrigger aria-label="Subagent routing" className={MODEL_CARD_SELECT_CLASS} size="sm">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="same-provider">Same model</SelectItem>
                            <SelectItem value="cross-provider-allowlist">Multiple providers</SelectItem>
                          </SelectContent>
                        </Select>
                        <div className="text-xs text-muted-foreground">
                          Lets subagents use models from different providers you've set up.
                        </div>
                      </div>

                      {childModelRoutingMode === "same-provider" ? (
                        <div className={MODEL_CARD_FIELD_CLASS}>
                          <div className="text-sm font-medium text-foreground">Preferred subagent model</div>
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
                            <SelectTrigger aria-label="Preferred subagent model" className={MODEL_CARD_SELECT_CLASS} size="sm">
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
                        </div>
                      ) : (
                        <div className={MODEL_CARD_FIELD_CLASS}>
                          <div className="text-sm font-medium text-foreground">Preferred subagent model</div>
                          <Select
                            value={preferredChildTargetOptions.includes(preferredChildModelRef) ? preferredChildModelRef : undefined}
                            onValueChange={(value) => {
                              if (!ws) return;
                              void updateWorkspaceDefaults(ws.id, { defaultPreferredChildModelRef: value });
                            }}
                            disabled={modelControlsDisabled || preferredChildTargetOptions.length === 0}
                          >
                            <SelectTrigger aria-label="Preferred subagent model" className={MODEL_CARD_SELECT_CLASS} size="sm">
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
                              <div className="text-sm font-medium text-foreground">Subagent Models</div>
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
                                    className={cn("size-3.5 transition-transform", subagentModelsOpen && "rotate-180")}
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
                                        return (
                                          <label
                                            key={ref}
                                            className="flex items-center gap-2 rounded-sm border border-border/60 px-3 py-2 text-sm"
                                          >
                                            <Checkbox
                                              checked={checked}
                                              onCheckedChange={(nextChecked) => {
                                                if (!ws) return;
                                                const nextRefs = nextChecked === true
                                                  ? [...visibleAllowedChildModelRefs, ref]
                                                  : visibleAllowedChildModelRefs.filter((entry) => entry !== ref);
                                                const dedupedRefs = [...new Set(nextRefs)];
                                                const nextPreferred = dedupedRefs.includes(preferredChildModelRef)
                                                  ? preferredChildModelRef
                                                  : (dedupedRefs[0] ?? `${effectiveProvider}:${preferredChildModel || model}`);
                                                void updateWorkspaceDefaults(ws.id, {
                                                  defaultAllowedChildModelRefs: dedupedRefs,
                                                  defaultPreferredChildModelRef: nextPreferred,
                                                });
                                              }}
                                              aria-label={`Allow subagent model ${ref}`}
                                              disabled={modelControlsDisabled}
                                            />
                                            <span>{childTargetLabel(ref)}</span>
                                          </label>
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
                <div className="flex items-start justify-between gap-4 max-[960px]:flex-col">
                  <div>
                    <div className="text-sm font-medium">Configure settings by workspace</div>
                    <div className="text-xs text-muted-foreground">When enabled, each workspace has its own provider, model, and behavior settings.</div>
                  </div>
                  <Checkbox
                    checked={perWorkspaceSettings}
                    aria-label="Configure settings by workspace"
                    onCheckedChange={async (checked) => {
                      const next = toBoolean(checked);
                      if (!next && workspaces.length > 1) {
                        const confirmed = await confirmAction({
                          title: "Share settings across workspaces",
                          message: "All workspaces will be synced to the current workspace's settings.",
                          detail: "This will overwrite provider, model, and behavior settings on other workspaces.",
                          confirmLabel: "Share settings",
                          cancelLabel: "Cancel",
                          kind: "warning",
                          defaultAction: "cancel",
                        });
                        if (!confirmed) return;
                      }
                      setPerWorkspaceSettings(next);
                    }}
                  />
                </div>

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
