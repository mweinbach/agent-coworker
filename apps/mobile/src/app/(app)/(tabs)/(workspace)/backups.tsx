import { useEffect } from "react";
import { ActivityIndicator, Alert, Pressable, Text, View } from "react-native";

import { Screen } from "@/components/ui/screen";
import { SectionCard } from "@/components/ui/section-card";
import { useBackupStore } from "@/features/cowork/backupStore";
import { usePairingStore } from "@/features/pairing/pairingStore";
import { isWorkspaceConnectionReady } from "@/features/relay/connectionState";
import { useAppTheme } from "@/theme/use-app-theme";

export default function BackupsScreen() {
  const theme = useAppTheme();
  const backups = useBackupStore((s) => s.backups);
  const loading = useBackupStore((s) => s.loading);
  const error = useBackupStore((s) => s.error);
  const fetchBackups = useBackupStore((s) => s.fetchBackups);
  const restoreBackup = useBackupStore((s) => s.restoreBackup);
  const deleteCheckpoint = useBackupStore((s) => s.deleteCheckpoint);
  const isConnected = usePairingStore((s) => isWorkspaceConnectionReady(s.connectionState));

  useEffect(() => {
    if (isConnected) {
      void fetchBackups();
    }
  }, [isConnected, fetchBackups]);

  const handleRestore = (targetSessionId: string, checkpointId: string) => {
    Alert.alert("Restore backup?", "This will restore the session to this checkpoint.", [
      { text: "Cancel", style: "cancel" },
      { text: "Restore", onPress: () => void restoreBackup(targetSessionId, checkpointId) },
    ]);
  };

  const handleDelete = (targetSessionId: string, checkpointId: string) => {
    Alert.alert("Delete checkpoint?", "This cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => void deleteCheckpoint(targetSessionId, checkpointId),
      },
    ]);
  };

  if (!isConnected) {
    return (
      <Screen scroll>
        <SectionCard title="Backups" description="Connect to a desktop to manage backups.">
          <Text selectable style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>
            Backup management will load here once connected to a workspace.
          </Text>
        </SectionCard>
      </Screen>
    );
  }

  return (
    <Screen scroll contentStyle={{ gap: 18 }}>
      {loading && backups.length === 0 ? (
        <View style={{ padding: 40, alignItems: "center" }}>
          <ActivityIndicator size="large" color={theme.primary} />
        </View>
      ) : null}

      {error ? (
        <SectionCard title="Error" description={error}>
          <Pressable
            onPress={() => void fetchBackups()}
            style={({ pressed }) => ({
              alignSelf: "flex-start",
              borderRadius: 999,
              backgroundColor: pressed ? theme.accent : theme.primary,
              paddingHorizontal: 16,
              paddingVertical: 11,
            })}
          >
            <Text style={{ color: theme.primaryText, fontWeight: "700" }}>Retry</Text>
          </Pressable>
        </SectionCard>
      ) : null}

      {backups.length > 0 ? (
        backups.map((backup) => (
          <SectionCard
            key={backup.targetSessionId}
            title={`Session ${backup.targetSessionId.slice(0, 8)}`}
            description={`${backup.checkpoints.length} checkpoints`}
          >
            <View style={{ gap: 8 }}>
              {backup.checkpoints.map((cp) => (
                <View
                  key={cp.id}
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 8,
                    borderRadius: 14,
                    borderCurve: "continuous",
                    borderWidth: 1,
                    borderColor: theme.borderMuted,
                    backgroundColor: theme.surfaceElevated,
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                  }}
                >
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ color: theme.text, fontSize: 13, fontWeight: "600" }}>
                      {cp.label ?? cp.id.slice(0, 8)}
                    </Text>
                    <Text style={{ color: theme.textTertiary, fontSize: 11 }}>{cp.createdAt}</Text>
                  </View>
                  <Pressable
                    onPress={() => handleRestore(backup.targetSessionId, cp.id)}
                    style={({ pressed }) => ({
                      borderRadius: 999,
                      backgroundColor: pressed ? theme.accent : theme.primary,
                      paddingHorizontal: 10,
                      paddingVertical: 5,
                    })}
                  >
                    <Text style={{ color: theme.primaryText, fontSize: 12, fontWeight: "600" }}>Restore</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => handleDelete(backup.targetSessionId, cp.id)}
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
              ))}
            </View>
          </SectionCard>
        ))
      ) : !loading ? (
        <SectionCard title="No backups" description="No session backups found for this workspace." />
      ) : null}
    </Screen>
  );
}
