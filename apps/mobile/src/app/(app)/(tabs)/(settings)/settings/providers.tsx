import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";

import { AppButton } from "@/components/ui/app-button";
import { Screen } from "@/components/ui/screen";
import { SectionCard } from "@/components/ui/section-card";
import { StatusPill } from "@/components/ui/status-pill";
import {
  minimumTouchTarget,
  useAccessibilityAnnouncement,
} from "@/features/accessibility/mobile-accessibility";
import { useProviderStore } from "@/features/cowork/providerStore";
import { useWorkspaceStore } from "@/features/cowork/workspaceStore";
import { usePairingStore } from "@/features/pairing/pairingStore";
import { isWorkspaceConnectionReady } from "@/features/relay/connectionState";
import { useAppTheme } from "@/theme/use-app-theme";

function providerTone(
  mode?: string,
  authorized?: boolean,
): "neutral" | "success" | "warning" | "danger" {
  if (authorized) return "success";
  if (mode === "oauth_pending") return "warning";
  if (mode === "error") return "danger";
  return "neutral";
}

function providerLabel(mode?: string, authorized?: boolean) {
  if (authorized) return "authorized";
  if (mode === "oauth_pending") return "pending";
  if (mode === "local") return "local";
  if (mode === "missing") return "missing";
  if (mode === "error") return "error";
  return "needs setup";
}

function ChoicePill({
  label,
  selected,
  disabled = false,
  onPress,
}: {
  label: string;
  selected: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const theme = useAppTheme();
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="radio"
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={(event) => {
        event.stopPropagation();
        onPress();
      }}
      style={({ pressed }) => ({
        minHeight: minimumTouchTarget(),
        justifyContent: "center",
        borderRadius: 999,
        borderWidth: 1,
        borderColor: selected ? theme.primary : pressed ? theme.primary : theme.border,
        backgroundColor: selected ? theme.primary : pressed ? theme.surfaceMuted : "transparent",
        opacity: disabled ? 0.5 : 1,
        paddingHorizontal: 12,
        paddingVertical: 7,
      })}
    >
      <Text
        selectable
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
      selectable
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

export default function ProvidersScreen() {
  const theme = useAppTheme();
  const catalog = useProviderStore((s) => s.catalog);
  const authMethodsByProvider = useProviderStore((s) => s.authMethodsByProvider);
  const statusByProvider = useProviderStore((s) => s.statusByProvider);
  const loading = useProviderStore((s) => s.loading);
  const error = useProviderStore((s) => s.error);
  const refresh = useProviderStore((s) => s.refresh);
  const selectDefaultModel = useProviderStore((s) => s.selectDefaultModel);
  const setApiKey = useProviderStore((s) => s.setApiKey);
  const authorize = useProviderStore((s) => s.authorize);
  const callback = useProviderStore((s) => s.callback);
  const logout = useProviderStore((s) => s.logout);
  const lastAuthChallenge = useProviderStore((s) => s.lastAuthChallenge);
  const lastAuthResult = useProviderStore((s) => s.lastAuthResult);
  const activeWorkspaceName = useWorkspaceStore((s) => s.activeWorkspaceName);
  const controlSnapshot = useWorkspaceStore((s) => s.controlSnapshot);
  const isConnected = usePairingStore((s) => isWorkspaceConnectionReady(s.connectionState));
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [apiKeyDrafts, setApiKeyDrafts] = useState<Record<string, string>>({});
  const [oauthCodeDrafts, setOauthCodeDrafts] = useState<Record<string, string>>({});
  useAccessibilityAnnouncement(error ?? lastAuthResult?.message ?? null);

  useEffect(() => {
    if (isConnected) {
      void refresh();
    }
  }, [isConnected, refresh]);

  const selectedProvider = controlSnapshot?.config?.provider ?? catalog[0]?.id ?? null;
  const selectedModel = controlSnapshot?.config?.model ?? null;
  const selectedProviderEntry = useMemo(
    () => catalog.find((provider) => provider.id === selectedProvider) ?? null,
    [catalog, selectedProvider],
  );

  if (!isConnected) {
    return (
      <Screen scroll>
        <SectionCard title="Providers" description="Connect to a desktop to manage providers.">
          <Text selectable style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>
            Provider management will load here once connected to a workspace.
          </Text>
        </SectionCard>
      </Screen>
    );
  }

  return (
    <Screen scroll contentStyle={{ gap: 18 }}>
      {loading && catalog.length === 0 ? (
        <View style={{ padding: 40, alignItems: "center" }}>
          <ActivityIndicator size="large" color={theme.primary} />
        </View>
      ) : null}

      {error ? <SectionCard title="Error" description={error} /> : null}

      {catalog.length > 0 ? (
        <SectionCard
          title="Default model"
          description={activeWorkspaceName ?? "Live workspace"}
          action={selectedModel ? <StatusPill label={selectedModel} tone="primary" /> : undefined}
        >
          <View style={{ gap: 12 }}>
            <View style={{ gap: 8 }}>
              <SectionLabel>Provider</SectionLabel>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {catalog.map((provider) => (
                  <ChoicePill
                    key={provider.id}
                    label={`${provider.name}${
                      provider.state && provider.state !== "ready" ? " · Unavailable" : ""
                    }`}
                    selected={provider.id === selectedProvider}
                    disabled={provider.state !== undefined && provider.state !== "ready"}
                    onPress={() => {
                      void selectDefaultModel(provider.id, provider.defaultModel);
                    }}
                  />
                ))}
              </View>
            </View>

            {selectedProviderEntry ? (
              <View style={{ gap: 8 }}>
                <SectionLabel>Model</SectionLabel>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  {selectedProviderEntry.models
                    // Keep the active default visible even when it is disabled,
                    // so its pill still reads as selected.
                    .filter((model) => model.enabled !== false || model.id === selectedModel)
                    .map((model) => (
                      <ChoicePill
                        key={model.id}
                        label={`${model.displayName}${
                          model.supportsImageInput ? " · Images" : ""
                        }${model.enabled === false ? " · Unavailable" : ""}`}
                        selected={model.id === selectedModel}
                        disabled={model.enabled === false}
                        onPress={() => {
                          void selectDefaultModel(selectedProviderEntry.id, model.id);
                        }}
                      />
                    ))}
                </View>
              </View>
            ) : null}
          </View>
        </SectionCard>
      ) : null}

      {catalog.map((provider) => {
        const isExpanded = expandedProvider === provider.id;
        const authMethods = authMethodsByProvider[provider.id] ?? [];
        const status = statusByProvider[provider.id];
        const apiKeyMethods = authMethods.filter((method) => method.type === "api");
        const oauthMethods = authMethods.filter((method) => method.type === "oauth");
        const statusTone = providerTone(status?.mode, status?.authorized);
        const statusLabel = providerLabel(status?.mode, status?.authorized);

        return (
          <SectionCard
            key={provider.id}
            title={provider.name}
            description={status?.message || provider.defaultModel}
            action={<StatusPill label={statusLabel} tone={statusTone} />}
          >
            <AppButton
              accessibilityLabel={`${isExpanded ? "Hide" : "Show"} ${provider.name} details`}
              expanded={isExpanded}
              fullWidth
              onPress={() => setExpandedProvider(isExpanded ? null : provider.id)}
              variant="ghost"
            >
              {isExpanded ? "Hide details" : "Show details"}
            </AppButton>
            {isExpanded ? (
              <View style={{ gap: 12, marginTop: 4 }}>
                {provider.models.length > 0 ? (
                  <View style={{ gap: 8 }}>
                    <SectionLabel>Models</SectionLabel>
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                      {provider.models
                        // Keep this provider's active default visible even
                        // when it is disabled, so its pill still reads selected.
                        .filter(
                          (model) =>
                            model.enabled !== false ||
                            (provider.id === selectedProvider && model.id === selectedModel),
                        )
                        .map((model) => (
                          <ChoicePill
                            key={model.id}
                            label={`${model.displayName}${
                              model.supportsImageInput ? " · Images" : ""
                            }${model.enabled === false ? " · Unavailable" : ""}`}
                            selected={
                              provider.id === selectedProvider && model.id === selectedModel
                            }
                            disabled={model.enabled === false}
                            onPress={() => {
                              void selectDefaultModel(provider.id, model.id);
                            }}
                          />
                        ))}
                    </View>
                  </View>
                ) : null}

                {status?.account ? (
                  <View style={{ gap: 4 }}>
                    <Text
                      style={{
                        color: theme.textTertiary,
                        fontSize: 11,
                        fontWeight: "600",
                        textTransform: "uppercase",
                      }}
                    >
                      Account
                    </Text>
                    <Text selectable style={{ color: theme.textSecondary, fontSize: 13 }}>
                      {[status.account.name, status.account.email].filter(Boolean).join(" · ")}
                    </Text>
                  </View>
                ) : null}

                {status?.usage?.rateLimits.length ? (
                  <View style={{ gap: 6 }}>
                    <Text
                      style={{
                        color: theme.textTertiary,
                        fontSize: 11,
                        fontWeight: "600",
                        textTransform: "uppercase",
                      }}
                    >
                      Rate limits
                    </Text>
                    {status.usage.rateLimits.slice(0, 2).map((limit, index) => (
                      <Text
                        key={`${provider.id}:limit:${index}`}
                        style={{ color: theme.textSecondary, fontSize: 13 }}
                      >
                        {limit.limitName ?? "window"}{" "}
                        {limit.primaryWindow
                          ? `· ${Math.round(limit.primaryWindow.usedPercent)}% used`
                          : ""}
                      </Text>
                    ))}
                  </View>
                ) : null}

                {apiKeyMethods.map((method) => {
                  const draftKey = `${provider.id}:${method.id}`;
                  return (
                    <View key={method.id} style={{ gap: 8 }}>
                      <Text
                        style={{
                          color: theme.textTertiary,
                          fontSize: 11,
                          fontWeight: "600",
                          textTransform: "uppercase",
                        }}
                      >
                        {method.label}
                      </Text>
                      <TextInput
                        accessibilityLabel={`${provider.name} ${method.label}`}
                        value={apiKeyDrafts[draftKey] ?? ""}
                        onChangeText={(value) => {
                          setApiKeyDrafts((state) => ({ ...state, [draftKey]: value }));
                        }}
                        placeholder="Enter API key..."
                        placeholderTextColor={theme.textTertiary}
                        secureTextEntry
                        autoCapitalize="none"
                        autoCorrect={false}
                        style={{
                          minHeight: minimumTouchTarget(),
                          borderRadius: 14,
                          borderWidth: 1,
                          borderColor: theme.border,
                          backgroundColor: theme.surfaceMuted,
                          color: theme.text,
                          paddingHorizontal: 12,
                          paddingVertical: 10,
                          fontSize: 14,
                        }}
                      />
                      <Pressable
                        accessibilityLabel={`Save ${provider.name} API key`}
                        accessibilityRole="button"
                        accessibilityState={{
                          disabled: !apiKeyDrafts[draftKey]?.trim(),
                        }}
                        disabled={!apiKeyDrafts[draftKey]?.trim()}
                        onPress={() => {
                          const nextValue = apiKeyDrafts[draftKey]?.trim();
                          if (!nextValue) return;
                          void setApiKey(provider.id, method.id, nextValue);
                          setApiKeyDrafts((state) => ({ ...state, [draftKey]: "" }));
                        }}
                        style={({ pressed }) => ({
                          minHeight: minimumTouchTarget(),
                          justifyContent: "center",
                          alignSelf: "flex-start",
                          borderRadius: 999,
                          backgroundColor: pressed ? theme.accent : theme.primary,
                          paddingHorizontal: 14,
                          paddingVertical: 9,
                        })}
                      >
                        <Text style={{ color: theme.primaryText, fontWeight: "700", fontSize: 13 }}>
                          Save key
                        </Text>
                      </Pressable>
                    </View>
                  );
                })}

                {oauthMethods.map((method) => {
                  const codeKey = `${provider.id}:${method.id}`;
                  const isChallenge =
                    lastAuthChallenge?.provider === provider.id &&
                    lastAuthChallenge.methodId === method.id;
                  const isResult =
                    lastAuthResult?.provider === provider.id &&
                    lastAuthResult.methodId === method.id;

                  return (
                    <View key={method.id} style={{ gap: 8 }}>
                      <Text
                        style={{
                          color: theme.textTertiary,
                          fontSize: 11,
                          fontWeight: "600",
                          textTransform: "uppercase",
                        }}
                      >
                        {method.label}
                      </Text>
                      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                        <Pressable
                          accessibilityLabel={`${status?.authorized ? "Reconnect" : "Connect"} ${provider.name}`}
                          accessibilityRole="button"
                          onPress={() => {
                            void authorize(provider.id, method.id);
                          }}
                          style={({ pressed }) => ({
                            minHeight: minimumTouchTarget(),
                            justifyContent: "center",
                            borderRadius: 999,
                            backgroundColor: pressed ? theme.accent : theme.primary,
                            paddingHorizontal: 14,
                            paddingVertical: 9,
                          })}
                        >
                          <Text
                            style={{ color: theme.primaryText, fontWeight: "700", fontSize: 13 }}
                          >
                            {status?.authorized ? "Reconnect" : "Connect"}
                          </Text>
                        </Pressable>
                        {status?.authorized ? (
                          <Pressable
                            accessibilityLabel={`Disconnect ${provider.name}`}
                            accessibilityRole="button"
                            onPress={() => {
                              void logout(provider.id);
                            }}
                            style={({ pressed }) => ({
                              minHeight: minimumTouchTarget(),
                              justifyContent: "center",
                              borderRadius: 999,
                              borderWidth: 1,
                              borderColor: theme.danger,
                              backgroundColor: pressed ? theme.dangerMuted : "transparent",
                              paddingHorizontal: 14,
                              paddingVertical: 9,
                            })}
                          >
                            <Text style={{ color: theme.danger, fontWeight: "700", fontSize: 13 }}>
                              Disconnect
                            </Text>
                          </Pressable>
                        ) : null}
                      </View>

                      {isChallenge ? (
                        <View
                          style={{
                            gap: 8,
                            borderRadius: 16,
                            borderCurve: "continuous",
                            borderWidth: 1,
                            borderColor: theme.border,
                            backgroundColor: theme.surfaceElevated,
                            padding: 12,
                          }}
                        >
                          <Text
                            selectable
                            style={{ color: theme.textSecondary, fontSize: 13, lineHeight: 18 }}
                          >
                            {lastAuthChallenge.instructions}
                          </Text>
                          {lastAuthChallenge.url ? (
                            <Text selectable style={{ color: theme.text, fontSize: 13 }}>
                              {lastAuthChallenge.url}
                            </Text>
                          ) : null}
                          <TextInput
                            accessibilityLabel={`${provider.name} authorization code`}
                            value={oauthCodeDrafts[codeKey] ?? ""}
                            onChangeText={(value) => {
                              setOauthCodeDrafts((state) => ({ ...state, [codeKey]: value }));
                            }}
                            placeholder="Paste code if prompted"
                            placeholderTextColor={theme.textTertiary}
                            autoCapitalize="none"
                            autoCorrect={false}
                            style={{
                              minHeight: minimumTouchTarget(),
                              borderRadius: 14,
                              borderWidth: 1,
                              borderColor: theme.border,
                              backgroundColor: theme.surfaceMuted,
                              color: theme.text,
                              paddingHorizontal: 12,
                              paddingVertical: 10,
                              fontSize: 14,
                            }}
                          />
                          <Pressable
                            accessibilityLabel={`Complete ${provider.name} sign-in`}
                            accessibilityRole="button"
                            onPress={() => {
                              void callback(provider.id, method.id, oauthCodeDrafts[codeKey]);
                              setOauthCodeDrafts((state) => ({ ...state, [codeKey]: "" }));
                            }}
                            style={({ pressed }) => ({
                              minHeight: minimumTouchTarget(),
                              justifyContent: "center",
                              alignSelf: "flex-start",
                              borderRadius: 999,
                              borderWidth: 1,
                              borderColor: theme.border,
                              backgroundColor: pressed ? theme.surfaceMuted : "transparent",
                              paddingHorizontal: 14,
                              paddingVertical: 9,
                            })}
                          >
                            <Text style={{ color: theme.text, fontWeight: "700", fontSize: 13 }}>
                              Complete sign-in
                            </Text>
                          </Pressable>
                        </View>
                      ) : null}

                      {isResult ? (
                        <Text
                          style={{
                            color: lastAuthResult.ok ? theme.success : theme.danger,
                            fontSize: 13,
                            fontWeight: "600",
                          }}
                        >
                          {lastAuthResult.message}
                        </Text>
                      ) : null}
                    </View>
                  );
                })}

                {authMethods.length === 0 ? (
                  <View style={{ gap: 8 }}>
                    <Text style={{ color: theme.textSecondary, fontSize: 13, lineHeight: 18 }}>
                      This provider does not expose a mobile auth flow yet.
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : null}
          </SectionCard>
        );
      })}
    </Screen>
  );
}
