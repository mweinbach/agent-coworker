import { useEffect } from "react";
import { Pressable, Text, View } from "react-native";

import { Screen } from "@/components/ui/screen";
import { SectionCard } from "@/components/ui/section-card";
import { StatusPill } from "@/components/ui/status-pill";
import { useProviderStore } from "@/features/cowork/providerStore";
import { useWorkspaceStore } from "@/features/cowork/workspaceStore";
import { getActiveCoworkJsonRpcClient } from "@/features/cowork/runtimeClient";
import { usePairingStore } from "@/features/pairing/pairingStore";
import { isWorkspaceConnectionReady } from "@/features/relay/connectionState";
import { useAppTheme } from "@/theme/use-app-theme";

export default function ModelsScreen() {
  const theme = useAppTheme();
  const catalog = useProviderStore((s) => s.catalog);
  const fetchCatalog = useProviderStore((s) => s.fetchCatalog);
  const sessionState = useWorkspaceStore((s) => s.sessionState);
  const fetchSessionState = useWorkspaceStore((s) => s.fetchSessionState);
  const activeWorkspaceCwd = useWorkspaceStore((s) => s.activeWorkspaceCwd);
  const isConnected = usePairingStore((s) => isWorkspaceConnectionReady(s.connectionState));

  useEffect(() => {
    if (isConnected) {
      void fetchCatalog();
    }
  }, [isConnected, fetchCatalog]);

  const currentModel = sessionState?.effectiveModel ?? sessionState?.model ?? "unknown";
  const currentProvider = sessionState?.provider ?? "unknown";

  const connectedProviders = catalog.filter((p) => p.status === "connected");
  const allModels = connectedProviders.flatMap((p) =>
    (p.models ?? []).map((model) => ({ provider: p.id, model })),
  );

  const handleSelectModel = async (model: string) => {
    const client = getActiveCoworkJsonRpcClient();
    if (!client || !activeWorkspaceCwd) return;
    try {
      await client.call("cowork/session/model/set", { cwd: activeWorkspaceCwd, model });
      await fetchSessionState();
    } catch {
      // Failed to set model
    }
  };

  if (!isConnected) {
    return (
      <Screen scroll>
        <SectionCard title="Models" description="Connect to a desktop to select models.">
          <Text selectable style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>
            Model selection will load here once connected to a workspace.
          </Text>
        </SectionCard>
      </Screen>
    );
  }

  return (
    <Screen scroll contentStyle={{ gap: 18 }}>
      <SectionCard
        title="Current model"
        description={`${currentProvider} / ${currentModel}`}
      />

      {allModels.length > 0 ? (
        <SectionCard title="Available models" description={`${allModels.length} models from connected providers`}>
          <View style={{ gap: 8 }}>
            {allModels.map(({ provider, model }) => {
              const isActive = model === currentModel;
              return (
                <Pressable
                  key={`${provider}:${model}`}
                  onPress={() => void handleSelectModel(model)}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    justifyContent: "space-between",
                    alignItems: "center",
                    paddingVertical: 12,
                    paddingHorizontal: 14,
                    borderRadius: 14,
                    borderCurve: "continuous",
                    borderWidth: isActive ? 2 : 1,
                    borderColor: isActive ? theme.primary : pressed ? theme.primary : theme.borderMuted,
                    backgroundColor: isActive ? theme.surfaceMuted : theme.surfaceElevated,
                  })}
                >
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ color: theme.text, fontSize: 14, fontWeight: "600" }}>{model}</Text>
                    <Text style={{ color: theme.textTertiary, fontSize: 11 }}>{provider}</Text>
                  </View>
                  {isActive ? <StatusPill label="active" tone="success" /> : null}
                </Pressable>
              );
            })}
          </View>
        </SectionCard>
      ) : (
        <SectionCard title="No models" description="Connect a provider to see available models." />
      )}
    </Screen>
  );
}
