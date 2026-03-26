import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";

import { Screen } from "@/components/ui/screen";
import { SectionCard } from "@/components/ui/section-card";
import { StatusPill } from "@/components/ui/status-pill";
import { useProviderStore } from "@/features/cowork/providerStore";
import { usePairingStore } from "@/features/pairing/pairingStore";
import { isWorkspaceConnectionReady } from "@/features/relay/connectionState";
import { useAppTheme } from "@/theme/use-app-theme";

function providerTone(mode?: string, authorized?: boolean): "neutral" | "success" | "warning" | "danger" {
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

export default function ProvidersScreen() {
  const theme = useAppTheme();
  const catalog = useProviderStore((s) => s.catalog);
  const authMethodsByProvider = useProviderStore((s) => s.authMethodsByProvider);
  const statusByProvider = useProviderStore((s) => s.statusByProvider);
  const loading = useProviderStore((s) => s.loading);
  const error = useProviderStore((s) => s.error);
  const refresh = useProviderStore((s) => s.refresh);
  const setApiKey = useProviderStore((s) => s.setApiKey);
  const authorize = useProviderStore((s) => s.authorize);
  const callback = useProviderStore((s) => s.callback);
  const logout = useProviderStore((s) => s.logout);
  const lastAuthChallenge = useProviderStore((s) => s.lastAuthChallenge);
  const lastAuthResult = useProviderStore((s) => s.lastAuthResult);
  const isConnected = usePairingStore((s) => isWorkspaceConnectionReady(s.connectionState));
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [apiKeyDrafts, setApiKeyDrafts] = useState<Record<string, string>>({});
  const [oauthCodeDrafts, setOauthCodeDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    if (isConnected) {
      void refresh();
    }
  }, [isConnected, refresh]);

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

      {catalog.map((provider) => {
        const isExpanded = expandedProvider === provider.id;
        const authMethods = authMethodsByProvider[provider.id] ?? [];
        const status = statusByProvider[provider.id];
        const apiKeyMethods = authMethods.filter((method) => method.type === "api");
        const oauthMethods = authMethods.filter((method) => method.type === "oauth");
        const statusTone = providerTone(status?.mode, status?.authorized);
        const statusLabel = providerLabel(status?.mode, status?.authorized);

        return (
          <Pressable
            key={provider.id}
            onPress={() => setExpandedProvider(isExpanded ? null : provider.id)}
          >
            <SectionCard
              title={provider.name}
              description={status?.message || provider.defaultModel}
              action={<StatusPill label={statusLabel} tone={statusTone} />}
            >
              {isExpanded ? (
                <View style={{ gap: 12, marginTop: 4 }}>
                  {provider.models.length > 0 ? (
                    <View style={{ gap: 4 }}>
                      <Text style={{ color: theme.textTertiary, fontSize: 11, fontWeight: "600", textTransform: "uppercase" }}>
                        Models
                      </Text>
                      <Text selectable style={{ color: theme.textSecondary, fontSize: 13 }}>
                        {provider.models.map((model) => model.displayName).join(", ")}
                      </Text>
                    </View>
                  ) : null}

                  {status?.account ? (
                    <View style={{ gap: 4 }}>
                      <Text style={{ color: theme.textTertiary, fontSize: 11, fontWeight: "600", textTransform: "uppercase" }}>
                        Account
                      </Text>
                      <Text selectable style={{ color: theme.textSecondary, fontSize: 13 }}>
                        {[status.account.name, status.account.email].filter(Boolean).join(" · ")}
                      </Text>
                    </View>
                  ) : null}

                  {status?.usage?.rateLimits.length ? (
                    <View style={{ gap: 6 }}>
                      <Text style={{ color: theme.textTertiary, fontSize: 11, fontWeight: "600", textTransform: "uppercase" }}>
                        Rate limits
                      </Text>
                      {status.usage.rateLimits.slice(0, 2).map((limit, index) => (
                        <Text key={`${provider.id}:limit:${index}`} style={{ color: theme.textSecondary, fontSize: 13 }}>
                          {(limit.limitName ?? "window")} {limit.primaryWindow ? `· ${Math.round(limit.primaryWindow.usedPercent)}% used` : ""}
                        </Text>
                      ))}
                    </View>
                  ) : null}

                  {apiKeyMethods.map((method) => {
                    const draftKey = `${provider.id}:${method.id}`;
                    return (
                      <View key={method.id} style={{ gap: 8 }}>
                        <Text style={{ color: theme.textTertiary, fontSize: 11, fontWeight: "600", textTransform: "uppercase" }}>
                          {method.label}
                        </Text>
                        <TextInput
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
                          onPress={() => {
                            const nextValue = apiKeyDrafts[draftKey]?.trim();
                            if (!nextValue) return;
                            void setApiKey(provider.id, method.id, nextValue);
                            setApiKeyDrafts((state) => ({ ...state, [draftKey]: "" }));
                          }}
                          style={({ pressed }) => ({
                            alignSelf: "flex-start",
                            borderRadius: 999,
                            backgroundColor: pressed ? theme.accent : theme.primary,
                            paddingHorizontal: 14,
                            paddingVertical: 9,
                          })}
                        >
                          <Text style={{ color: theme.primaryText, fontWeight: "700", fontSize: 13 }}>Save key</Text>
                        </Pressable>
                      </View>
                    );
                  })}

                  {oauthMethods.map((method) => {
                    const codeKey = `${provider.id}:${method.id}`;
                    const isChallenge = lastAuthChallenge?.provider === provider.id && lastAuthChallenge.methodId === method.id;
                    const isResult = lastAuthResult?.provider === provider.id && lastAuthResult.methodId === method.id;

                    return (
                      <View key={method.id} style={{ gap: 8 }}>
                        <Text style={{ color: theme.textTertiary, fontSize: 11, fontWeight: "600", textTransform: "uppercase" }}>
                          {method.label}
                        </Text>
                        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                          <Pressable
                            onPress={() => {
                              void authorize(provider.id, method.id);
                            }}
                            style={({ pressed }) => ({
                              borderRadius: 999,
                              backgroundColor: pressed ? theme.accent : theme.primary,
                              paddingHorizontal: 14,
                              paddingVertical: 9,
                            })}
                          >
                            <Text style={{ color: theme.primaryText, fontWeight: "700", fontSize: 13 }}>
                              {status?.authorized ? "Reconnect" : "Connect"}
                            </Text>
                          </Pressable>
                          {status?.authorized ? (
                            <Pressable
                              onPress={() => {
                                void logout(provider.id);
                              }}
                              style={({ pressed }) => ({
                                borderRadius: 999,
                                borderWidth: 1,
                                borderColor: theme.danger,
                                backgroundColor: pressed ? theme.dangerMuted : "transparent",
                                paddingHorizontal: 14,
                                paddingVertical: 9,
                              })}
                            >
                              <Text style={{ color: theme.danger, fontWeight: "700", fontSize: 13 }}>Disconnect</Text>
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
                            <Text selectable style={{ color: theme.textSecondary, fontSize: 13, lineHeight: 18 }}>
                              {lastAuthChallenge.instructions}
                            </Text>
                            {lastAuthChallenge.url ? (
                              <Text selectable style={{ color: theme.text, fontSize: 13 }}>
                                {lastAuthChallenge.url}
                              </Text>
                            ) : null}
                            <TextInput
                              value={oauthCodeDrafts[codeKey] ?? ""}
                              onChangeText={(value) => {
                                setOauthCodeDrafts((state) => ({ ...state, [codeKey]: value }));
                              }}
                              placeholder="Paste code if prompted"
                              placeholderTextColor={theme.textTertiary}
                              autoCapitalize="none"
                              autoCorrect={false}
                              style={{
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
                              onPress={() => {
                                void callback(provider.id, method.id, oauthCodeDrafts[codeKey]);
                                setOauthCodeDrafts((state) => ({ ...state, [codeKey]: "" }));
                              }}
                              style={({ pressed }) => ({
                                alignSelf: "flex-start",
                                borderRadius: 999,
                                borderWidth: 1,
                                borderColor: theme.border,
                                backgroundColor: pressed ? theme.surfaceMuted : "transparent",
                                paddingHorizontal: 14,
                                paddingVertical: 9,
                              })}
                            >
                              <Text style={{ color: theme.text, fontWeight: "700", fontSize: 13 }}>Complete sign-in</Text>
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
          </Pressable>
        );
      })}
    </Screen>
  );
}
