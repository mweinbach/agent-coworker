import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";

import { Screen } from "@/components/ui/screen";
import { SectionCard } from "@/components/ui/section-card";
import { StatusPill } from "@/components/ui/status-pill";
import { useProviderStore } from "@/features/cowork/providerStore";
import { usePairingStore } from "@/features/pairing/pairingStore";
import { isWorkspaceConnectionReady } from "@/features/relay/connectionState";
import { useAppTheme } from "@/theme/use-app-theme";

export default function ProvidersScreen() {
  const theme = useAppTheme();
  const catalog = useProviderStore((s) => s.catalog);
  const loading = useProviderStore((s) => s.loading);
  const error = useProviderStore((s) => s.error);
  const fetchCatalog = useProviderStore((s) => s.fetchCatalog);
  const fetchStatus = useProviderStore((s) => s.fetchStatus);
  const setApiKey = useProviderStore((s) => s.setApiKey);
  const logout = useProviderStore((s) => s.logout);
  const isConnected = usePairingStore((s) => isWorkspaceConnectionReady(s.connectionState));
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");

  useEffect(() => {
    if (isConnected) {
      void fetchCatalog();
      void fetchStatus();
    }
  }, [isConnected, fetchCatalog, fetchStatus]);

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
        const statusTone = provider.status === "connected" ? "success" : provider.status === "error" ? "danger" : "neutral";
        const apiKeyMethod = provider.authMethods?.find((m) => m.type === "api-key" || m.type === "apiKey");

        return (
          <Pressable
            key={provider.id}
            onPress={() => setExpandedProvider(isExpanded ? null : provider.id)}
          >
            <SectionCard
              title={provider.name}
              description={provider.defaultModel ?? undefined}
              action={<StatusPill label={provider.status ?? "unknown"} tone={statusTone} />}
            >
              {isExpanded ? (
                <View style={{ gap: 12, marginTop: 4 }}>
                  {provider.models && provider.models.length > 0 ? (
                    <View style={{ gap: 4 }}>
                      <Text style={{ color: theme.textTertiary, fontSize: 11, fontWeight: "600", textTransform: "uppercase" }}>
                        Models
                      </Text>
                      <Text selectable style={{ color: theme.textSecondary, fontSize: 13 }}>
                        {provider.models.join(", ")}
                      </Text>
                    </View>
                  ) : null}

                  {apiKeyMethod ? (
                    <View style={{ gap: 8 }}>
                      <Text style={{ color: theme.textTertiary, fontSize: 11, fontWeight: "600", textTransform: "uppercase" }}>
                        API Key
                      </Text>
                      <TextInput
                        value={apiKeyInput}
                        onChangeText={setApiKeyInput}
                        placeholder="Enter API key..."
                        placeholderTextColor={theme.textTertiary}
                        secureTextEntry
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
                      <View style={{ flexDirection: "row", gap: 8 }}>
                        <Pressable
                          onPress={() => {
                            if (apiKeyInput.trim()) {
                              void setApiKey(provider.id, apiKeyMethod.id, apiKeyInput.trim());
                              setApiKeyInput("");
                            }
                          }}
                          style={({ pressed }) => ({
                            borderRadius: 999,
                            backgroundColor: pressed ? theme.accent : theme.primary,
                            paddingHorizontal: 14,
                            paddingVertical: 9,
                          })}
                        >
                          <Text style={{ color: theme.primaryText, fontWeight: "700", fontSize: 13 }}>Save key</Text>
                        </Pressable>
                        {provider.status === "connected" ? (
                          <Pressable
                            onPress={() => void logout(provider.id)}
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
