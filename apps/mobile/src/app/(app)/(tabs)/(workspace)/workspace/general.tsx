import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Switch, Text, TextInput, View } from "react-native";

import { Screen } from "@/components/ui/screen";
import { SectionCard } from "@/components/ui/section-card";
import { StatusPill } from "@/components/ui/status-pill";
import {
  MAX_DYNAMIC_TYPE_MULTIPLIER,
  minimumTouchTarget,
} from "@/features/accessibility/mobile-accessibility";
import { getOfflineCacheScope } from "@/features/cowork/offlineCacheStorage";
import { useProviderStore } from "@/features/cowork/providerStore";
import { useWorkspaceStore } from "@/features/cowork/workspaceStore";
import { usePairingStore } from "@/features/pairing/pairingStore";
import { isWorkspaceConnectionReady } from "@/features/relay/connectionState";
import { useAppTheme } from "@/theme/use-app-theme";

function ChoicePill({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const theme = useAppTheme();
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={{
        minHeight: minimumTouchTarget(),
        justifyContent: "center",
        borderRadius: 999,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: selected ? theme.primary : theme.border,
        backgroundColor: selected ? theme.primary : "transparent",
        paddingHorizontal: 12,
        paddingVertical: 7,
      }}
    >
      <Text
        maxFontSizeMultiplier={MAX_DYNAMIC_TYPE_MULTIPLIER}
        style={{
          color: selected ? theme.primaryText : theme.text,
          fontSize: 13,
          fontWeight: "700",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function SectionLabel({ children }: { children: string }) {
  const theme = useAppTheme();
  return (
    <Text
      accessibilityRole="header"
      maxFontSizeMultiplier={MAX_DYNAMIC_TYPE_MULTIPLIER}
      style={{
        color: theme.textTertiary,
        fontSize: 11,
        fontWeight: "700",
        textTransform: "uppercase",
      }}
    >
      {children}
    </Text>
  );
}

type RoutingDraft = {
  desktopId: string | null;
  workspaceCwd: string | null;
  preferredChildModel: string;
  preferredChildModelRef: string;
  allowedChildModelRefs: string;
};

export default function WorkspaceGeneralScreen() {
  const theme = useAppTheme();
  const isConnected = usePairingStore((state) => isWorkspaceConnectionReady(state.connectionState));
  const desktopId = getOfflineCacheScope().desktopId;
  const activeWorkspaceName = useWorkspaceStore((state) => state.activeWorkspaceName);
  const activeWorkspaceCwd = useWorkspaceStore((state) => state.activeWorkspaceCwd);
  const controlSnapshot = useWorkspaceStore((state) => state.controlSnapshot);
  const applyWorkspaceDefaults = useWorkspaceStore((state) => state.applyWorkspaceDefaults);
  const error = useWorkspaceStore((state) => state.error);
  const catalog = useProviderStore((state) => state.catalog);
  const refreshProviders = useProviderStore((state) => state.refresh);

  const [routingDraft, setRoutingDraft] = useState<RoutingDraft | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const savingRef: { current: boolean } = useRef<boolean>(false);
  const savedRouting: RoutingDraft = {
    desktopId,
    workspaceCwd: activeWorkspaceCwd,
    preferredChildModel: controlSnapshot?.sessionConfig?.preferredChildModel ?? "",
    preferredChildModelRef: controlSnapshot?.sessionConfig?.preferredChildModelRef ?? "",
    allowedChildModelRefs: (controlSnapshot?.sessionConfig?.allowedChildModelRefs ?? []).join(", "),
  };
  const currentRouting =
    routingDraft?.desktopId === desktopId && routingDraft.workspaceCwd === activeWorkspaceCwd
      ? routingDraft
      : savedRouting;
  const { preferredChildModel, preferredChildModelRef, allowedChildModelRefs } = currentRouting;
  const updateRoutingDraft = (patch: Partial<Omit<RoutingDraft, "desktopId" | "workspaceCwd">>) => {
    setRoutingDraft((current) => ({
      ...(current?.desktopId === desktopId && current.workspaceCwd === activeWorkspaceCwd
        ? current
        : savedRouting),
      ...patch,
    }));
  };

  useEffect(() => {
    if (isConnected && activeWorkspaceCwd) {
      void refreshProviders();
    }
  }, [isConnected, activeWorkspaceCwd, refreshProviders]);

  const selectedProvider = controlSnapshot?.config?.provider ?? catalog[0]?.id ?? null;
  const selectedModel = controlSnapshot?.config?.model ?? null;
  const providerEntry = useMemo(
    () => catalog.find((entry) => entry.id === selectedProvider) ?? null,
    [catalog, selectedProvider],
  );
  const routingMode = controlSnapshot?.sessionConfig?.childModelRoutingMode ?? "same-provider";
  const backupsEnabled =
    controlSnapshot?.sessionConfig?.backupsEnabled === undefined
      ? false
      : controlSnapshot.sessionConfig.backupsEnabled === true;
  const enableMcp =
    controlSnapshot?.settings?.enableMcp === undefined
      ? true
      : controlSnapshot.settings.enableMcp === true;
  const codexOptions = controlSnapshot?.sessionConfig?.providerOptions?.["codex-cli"];
  const googleOptions = controlSnapshot?.sessionConfig?.providerOptions?.google;

  const saveSubagentDefaults = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setIsSaving(true);
    const submittedDraft = routingDraft;
    try {
      const saved = await applyWorkspaceDefaults({
        config: {
          preferredChildModel: preferredChildModel.trim() || undefined,
          preferredChildModelRef: preferredChildModelRef.trim() || undefined,
          allowedChildModelRefs: allowedChildModelRefs
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
          childModelRoutingMode: routingMode,
        },
      });
      if (saved) setRoutingDraft((current) => (current === submittedDraft ? null : current));
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  };

  if (!isConnected || !activeWorkspaceCwd) {
    return (
      <Screen scroll>
        <SectionCard
          title="General"
          description={
            isConnected
              ? "Waiting for the desktop workspace."
              : "Connect to a desktop to manage workspace defaults."
          }
        >
          <Text selectable style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>
            Workspace defaults stay disabled until the direct desktop connection is active.
          </Text>
        </SectionCard>
      </Screen>
    );
  }

  return (
    <Screen scroll avoidKeyboard contentStyle={{ gap: 18 }}>
      {error ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
          style={{ color: theme.danger }}
        >
          {error}
        </Text>
      ) : null}
      <SectionCard
        title={activeWorkspaceName ?? "Workspace"}
        description={activeWorkspaceCwd ?? "No workspace path available"}
        action={selectedModel ? <StatusPill label={selectedModel} tone="primary" /> : undefined}
      >
        <Text selectable style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>
          Workspace defaults apply to the shared control session. Thread-specific overrides still
          belong on thread screens.
        </Text>
      </SectionCard>

      <SectionCard
        title="Workspace defaults"
        description="Choose the default provider, model, and workspace toggles."
      >
        <View style={{ gap: 14 }}>
          <View style={{ gap: 8 }}>
            <SectionLabel>Provider</SectionLabel>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {catalog.map((provider) => (
                <ChoicePill
                  key={provider.id}
                  label={provider.name}
                  selected={provider.id === selectedProvider}
                  onPress={() => {
                    void applyWorkspaceDefaults({
                      provider: provider.id,
                      model: provider.defaultModel,
                    });
                  }}
                />
              ))}
            </View>
          </View>

          {providerEntry ? (
            <View style={{ gap: 8 }}>
              <SectionLabel>Model</SectionLabel>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {providerEntry.models
                  // Hide disabled models, but keep the active default visible so
                  // its pill still reads as selected even when it is disabled.
                  .filter((model) => model.enabled !== false || model.id === selectedModel)
                  .map((model) => (
                    <ChoicePill
                      key={model.id}
                      label={model.displayName}
                      selected={model.id === selectedModel}
                      onPress={() => {
                        void applyWorkspaceDefaults({
                          provider: providerEntry.id,
                          model: model.id,
                        });
                      }}
                    />
                  ))}
              </View>
            </View>
          ) : null}

          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 16,
            }}
          >
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={{ color: theme.text, fontSize: 15, fontWeight: "700" }}>Enable MCP</Text>
              <Text style={{ color: theme.textSecondary, fontSize: 13 }}>
                Allow workspace MCP integrations in the shared control session.
              </Text>
            </View>
            <Switch
              accessibilityLabel="Enable MCP integrations"
              accessibilityRole="switch"
              accessibilityState={{ checked: enableMcp }}
              value={enableMcp}
              onValueChange={(value) => {
                void applyWorkspaceDefaults({ enableMcp: value });
              }}
              trackColor={{ true: theme.primary, false: theme.surfaceMuted }}
              ios_backgroundColor={theme.surfaceMuted}
            />
          </View>

          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 16,
            }}
          >
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={{ color: theme.text, fontSize: 15, fontWeight: "700" }}>Backup</Text>
              <Text style={{ color: theme.textSecondary, fontSize: 13 }}>
                Enable opt-in workspace recovery snapshots for this workspace.
              </Text>
            </View>
            <Switch
              accessibilityLabel="Enable workspace backups"
              accessibilityRole="switch"
              accessibilityState={{ checked: backupsEnabled }}
              value={backupsEnabled}
              onValueChange={(value) => {
                void applyWorkspaceDefaults({ config: { backupsEnabled: value } });
              }}
              trackColor={{ true: theme.primary, false: theme.surfaceMuted }}
              ios_backgroundColor={theme.surfaceMuted}
            />
          </View>
        </View>
      </SectionCard>

      <SectionCard
        title="Web Search"
        description="Provider-specific workspace defaults for relay-backed search behavior."
      >
        {selectedProvider === "codex-cli" ? (
          <View style={{ gap: 14 }}>
            <View style={{ gap: 8 }}>
              <SectionLabel>Backend</SectionLabel>
              <View style={{ flexDirection: "row", gap: 8 }}>
                {(["native", "exa"] as const).map((backend) => (
                  <ChoicePill
                    key={backend}
                    label={backend === "exa" ? "Exa" : "Native"}
                    selected={(codexOptions?.webSearchBackend ?? "native") === backend}
                    onPress={() => {
                      void applyWorkspaceDefaults({
                        config: {
                          providerOptions: {
                            "codex-cli": {
                              ...codexOptions,
                              webSearchBackend: backend,
                            },
                          },
                        },
                      });
                    }}
                  />
                ))}
              </View>
            </View>

            <View style={{ gap: 8 }}>
              <SectionLabel>Mode</SectionLabel>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {(["disabled", "cached", "live"] as const).map((mode) => (
                  <ChoicePill
                    key={mode}
                    label={mode}
                    selected={(codexOptions?.webSearchMode ?? "live") === mode}
                    onPress={() => {
                      void applyWorkspaceDefaults({
                        config: {
                          providerOptions: {
                            "codex-cli": {
                              ...codexOptions,
                              webSearchMode: mode,
                            },
                          },
                        },
                      });
                    }}
                  />
                ))}
              </View>
            </View>
          </View>
        ) : selectedProvider === "google" ? (
          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 16,
            }}
          >
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={{ color: theme.text, fontSize: 15, fontWeight: "700" }}>
                Native Web Search
              </Text>
              <Text style={{ color: theme.textSecondary, fontSize: 13 }}>
                Let Gemini use provider-native web search from the workspace defaults.
              </Text>
            </View>
            <Switch
              accessibilityLabel="Enable native Google web search"
              accessibilityRole="switch"
              accessibilityState={{ checked: Boolean(googleOptions?.nativeWebSearch) }}
              value={Boolean(googleOptions?.nativeWebSearch)}
              onValueChange={(value) => {
                void applyWorkspaceDefaults({
                  config: {
                    providerOptions: {
                      google: {
                        ...googleOptions,
                        nativeWebSearch: value,
                      },
                    },
                  },
                });
              }}
              trackColor={{ true: theme.primary, false: theme.surfaceMuted }}
              ios_backgroundColor={theme.surfaceMuted}
            />
          </View>
        ) : (
          <Text selectable style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>
            Web search defaults are available for Codex CLI and Gemini workspaces.
          </Text>
        )}
      </SectionCard>

      <SectionCard
        title="Subagent Models"
        description="Workspace-level child-model routing defaults."
      >
        <View style={{ gap: 14 }}>
          <View style={{ gap: 8 }}>
            <SectionLabel>Routing</SectionLabel>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <ChoicePill
                label="Same provider"
                selected={routingMode === "same-provider"}
                onPress={() => {
                  void applyWorkspaceDefaults({
                    config: {
                      childModelRoutingMode: "same-provider",
                    },
                  });
                }}
              />
              <ChoicePill
                label="Allowlist"
                selected={routingMode === "cross-provider-allowlist"}
                onPress={() => {
                  void applyWorkspaceDefaults({
                    config: {
                      childModelRoutingMode: "cross-provider-allowlist",
                    },
                  });
                }}
              />
            </View>
          </View>

          <View style={{ gap: 8 }}>
            <SectionLabel>Preferred child model</SectionLabel>
            <TextInput
              accessibilityLabel="Preferred child model"
              value={preferredChildModel}
              onChangeText={(value) => updateRoutingDraft({ preferredChildModel: value })}
              placeholder="gpt-5.4-mini"
              placeholderTextColor={theme.textTertiary}
              style={{
                minHeight: minimumTouchTarget(),
                borderRadius: 16,
                borderWidth: 1,
                borderColor: theme.border,
                backgroundColor: theme.surfaceMuted,
                color: theme.text,
                paddingHorizontal: 14,
                paddingVertical: 12,
                fontSize: 14,
              }}
            />
          </View>

          <View style={{ gap: 8 }}>
            <SectionLabel>Preferred child target</SectionLabel>
            <TextInput
              accessibilityLabel="Preferred child model reference"
              value={preferredChildModelRef}
              onChangeText={(value) => updateRoutingDraft({ preferredChildModelRef: value })}
              placeholder="provider:model"
              placeholderTextColor={theme.textTertiary}
              style={{
                minHeight: minimumTouchTarget(),
                borderRadius: 16,
                borderWidth: 1,
                borderColor: theme.border,
                backgroundColor: theme.surfaceMuted,
                color: theme.text,
                paddingHorizontal: 14,
                paddingVertical: 12,
                fontSize: 14,
              }}
            />
          </View>

          {routingMode === "cross-provider-allowlist" ? (
            <View style={{ gap: 8 }}>
              <SectionLabel>Allowed child targets</SectionLabel>
              <TextInput
                accessibilityLabel="Allowed child model references"
                value={allowedChildModelRefs}
                onChangeText={(value) => updateRoutingDraft({ allowedChildModelRefs: value })}
                placeholder="provider:model, provider:model"
                placeholderTextColor={theme.textTertiary}
                multiline
                style={{
                  minHeight: 84,
                  borderRadius: 16,
                  borderWidth: 1,
                  borderColor: theme.border,
                  backgroundColor: theme.surfaceMuted,
                  color: theme.text,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                  fontSize: 14,
                  textAlignVertical: "top",
                }}
              />
            </View>
          ) : null}

          <Pressable
            accessibilityLabel="Save routing defaults"
            accessibilityRole="button"
            accessibilityState={{ busy: isSaving, disabled: isSaving }}
            disabled={isSaving}
            onPress={() => {
              void saveSubagentDefaults();
            }}
            style={({ pressed }) => ({
              minHeight: minimumTouchTarget(),
              justifyContent: "center",
              alignSelf: "flex-start",
              borderRadius: 999,
              borderCurve: "continuous",
              backgroundColor: pressed ? theme.accent : theme.primary,
              paddingHorizontal: 16,
              paddingVertical: 11,
            })}
          >
            <Text style={{ color: theme.primaryText, fontWeight: "700" }}>
              {isSaving ? "Saving…" : "Save routing defaults"}
            </Text>
          </Pressable>
        </View>
      </SectionCard>
    </Screen>
  );
}
