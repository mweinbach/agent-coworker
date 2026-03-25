import { useEffect } from "react";
import { ActivityIndicator, Alert, Pressable, Text, View } from "react-native";

import { Screen } from "@/components/ui/screen";
import { SectionCard } from "@/components/ui/section-card";
import { StatusPill } from "@/components/ui/status-pill";
import { useMcpStore } from "@/features/cowork/mcpStore";
import { usePairingStore } from "@/features/pairing/pairingStore";
import { useAppTheme } from "@/theme/use-app-theme";

export default function McpServersScreen() {
  const theme = useAppTheme();
  const servers = useMcpStore((s) => s.servers);
  const validationByName = useMcpStore((s) => s.validationByName);
  const loading = useMcpStore((s) => s.loading);
  const error = useMcpStore((s) => s.error);
  const fetchServers = useMcpStore((s) => s.fetchServers);
  const validateServer = useMcpStore((s) => s.validateServer);
  const deleteServer = useMcpStore((s) => s.deleteServer);
  const isConnected = usePairingStore((s) => s.connectionState.status === "connected");

  useEffect(() => {
    if (isConnected) {
      void fetchServers();
    }
  }, [isConnected, fetchServers]);

  const handleDelete = (name: string) => {
    Alert.alert("Delete MCP server?", `Remove "${name}" from this workspace?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => void deleteServer(name) },
    ]);
  };

  if (!isConnected) {
    return (
      <Screen scroll>
        <SectionCard title="MCP Servers" description="Connect to a desktop to manage MCP servers.">
          <Text selectable style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>
            MCP server management will load here once connected to a workspace.
          </Text>
        </SectionCard>
      </Screen>
    );
  }

  return (
    <Screen scroll contentStyle={{ gap: 18 }}>
      {loading && servers.length === 0 ? (
        <View style={{ padding: 40, alignItems: "center" }}>
          <ActivityIndicator size="large" color={theme.primary} />
        </View>
      ) : null}

      {error ? <SectionCard title="Error" description={error} /> : null}

      {servers.length > 0 ? (
        <SectionCard title="Configured servers" description={`${servers.length} MCP servers`}>
          <View style={{ gap: 10 }}>
            {servers.map((server) => {
              const validation = validationByName[server.name];
              return (
                <View
                  key={server.name}
                  style={{
                    gap: 8,
                    borderRadius: 18,
                    borderCurve: "continuous",
                    borderWidth: 1,
                    borderColor: theme.borderMuted,
                    backgroundColor: theme.surfaceElevated,
                    paddingHorizontal: 14,
                    paddingVertical: 12,
                  }}
                >
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                    <Text style={{ color: theme.text, fontSize: 15, fontWeight: "700", flex: 1 }}>
                      {server.name}
                    </Text>
                    <StatusPill
                      label={server.enabled !== false ? "enabled" : "disabled"}
                      tone={server.enabled !== false ? "success" : "neutral"}
                    />
                  </View>
                  {server.command ? (
                    <Text
                      selectable
                      numberOfLines={1}
                      style={{ fontFamily: "Menlo", fontSize: 11, color: theme.textSecondary }}
                    >
                      {server.command} {server.args?.join(" ") ?? ""}
                    </Text>
                  ) : server.url ? (
                    <Text selectable numberOfLines={1} style={{ fontSize: 12, color: theme.textSecondary }}>
                      {server.url}
                    </Text>
                  ) : null}
                  {server.tools && server.tools.length > 0 ? (
                    <Text style={{ color: theme.textTertiary, fontSize: 11 }}>
                      {server.tools.length} tools
                    </Text>
                  ) : null}
                  {validation ? (
                    <Text
                      style={{
                        color: validation.valid ? theme.success : theme.danger,
                        fontSize: 12,
                        fontWeight: "600",
                      }}
                    >
                      {validation.valid ? "Valid" : `Invalid: ${validation.error ?? "unknown error"}`}
                    </Text>
                  ) : null}
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <Pressable
                      onPress={() => void validateServer(server.name)}
                      style={({ pressed }) => ({
                        borderRadius: 999,
                        borderWidth: 1,
                        borderColor: theme.border,
                        backgroundColor: pressed ? theme.surfaceMuted : "transparent",
                        paddingHorizontal: 10,
                        paddingVertical: 5,
                      })}
                    >
                      <Text style={{ color: theme.text, fontSize: 12, fontWeight: "600" }}>Validate</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => handleDelete(server.name)}
                      style={({ pressed }) => ({
                        borderRadius: 999,
                        borderWidth: 1,
                        borderColor: theme.danger,
                        backgroundColor: pressed ? theme.dangerMuted : "transparent",
                        paddingHorizontal: 10,
                        paddingVertical: 5,
                      })}
                    >
                      <Text style={{ color: theme.danger, fontSize: 12, fontWeight: "600" }}>Delete</Text>
                    </Pressable>
                  </View>
                </View>
              );
            })}
          </View>
        </SectionCard>
      ) : !loading ? (
        <SectionCard title="No servers" description="No MCP servers configured for this workspace." />
      ) : null}
    </Screen>
  );
}
