import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, Text, View } from "react-native";

import { Screen } from "@/components/ui/screen";
import { SectionCard } from "@/components/ui/section-card";
import { StatusPill } from "@/components/ui/status-pill";
import { useBackupStore } from "@/features/cowork/backupStore";
import { usePairingStore } from "@/features/pairing/pairingStore";
import { isWorkspaceConnectionReady } from "@/features/relay/connectionState";
import { useAppTheme } from "@/theme/use-app-theme";

export default function BackupsScreen() {
  const theme = useAppTheme();
  const backups = useBackupStore((s) => s.backups);
  const workspacePath = useBackupStore((s) => s.workspacePath);
  const deltasByCheckpointKey = useBackupStore((s) => s.deltasByCheckpointKey);
  const loading = useBackupStore((s) => s.loading);
  const error = useBackupStore((s) => s.error);
  const fetchBackups = useBackupStore((s) => s.fetchBackups);
  const createCheckpoint = useBackupStore((s) => s.createCheckpoint);
  const fetchDelta = useBackupStore((s) => s.fetchDelta);
  const restoreBackup = useBackupStore((s) => s.restoreBackup);
  const deleteCheckpoint = useBackupStore((s) => s.deleteCheckpoint);
  const deleteEntry = useBackupStore((s) => s.deleteEntry);
  const isConnected = usePairingStore((s) => isWorkspaceConnectionReady(s.connectionState));
  const [expandedCheckpointKey, setExpandedCheckpointKey] = useState<string | null>(null);

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

  const handleRestoreOriginal = (targetSessionId: string) => {
    Alert.alert("Restore original workspace?", "This restores the original snapshot instead of a checkpoint.", [
      { text: "Cancel", style: "cancel" },
      { text: "Restore", onPress: () => void restoreBackup(targetSessionId) },
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

  const handleDeleteEntry = (targetSessionId: string) => {
    Alert.alert("Delete backup entry?", "This removes the original snapshot and all checkpoints for this session.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => void deleteEntry(targetSessionId) },
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
      <SectionCard title="Backup" description={workspacePath ?? "Workspace backup metadata"}>
        <Text selectable style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>
          Create checkpoints, inspect backup deltas, restore the original snapshot, or remove stale backup entries.
        </Text>
      </SectionCard>

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
            title={backup.title ?? `Session ${backup.targetSessionId.slice(0, 8)}`}
            description={`${backup.checkpoints.length} checkpoints · ${backup.lifecycle} · ${backup.status}`}
            action={<StatusPill label={backup.status} tone={backup.status === "failed" ? "danger" : "primary"} />}
          >
            <View style={{ gap: 8 }}>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                <Pressable
                  onPress={() => {
                    void createCheckpoint(backup.targetSessionId);
                  }}
                  style={({ pressed }) => ({
                    borderRadius: 999,
                    backgroundColor: pressed ? theme.accent : theme.primary,
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                  })}
                >
                  <Text style={{ color: theme.primaryText, fontSize: 12, fontWeight: "700" }}>Checkpoint</Text>
                </Pressable>
                <Pressable
                  onPress={() => handleRestoreOriginal(backup.targetSessionId)}
                  style={({ pressed }) => ({
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: theme.border,
                    backgroundColor: pressed ? theme.surfaceMuted : "transparent",
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                  })}
                >
                  <Text style={{ color: theme.text, fontSize: 12, fontWeight: "700" }}>Restore original</Text>
                </Pressable>
                <Pressable
                  onPress={() => handleDeleteEntry(backup.targetSessionId)}
                  style={({ pressed }) => ({
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: theme.danger,
                    backgroundColor: pressed ? theme.dangerMuted : "transparent",
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                  })}
                >
                  <Text style={{ color: theme.danger, fontSize: 12, fontWeight: "700" }}>Delete entry</Text>
                </Pressable>
              </View>

              {backup.checkpoints.map((cp) => (
                <View key={cp.id} style={{ gap: 8 }}>
                  <View
                    style={{
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
                    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text style={{ color: theme.text, fontSize: 13, fontWeight: "600" }}>
                          Checkpoint {cp.index} · {cp.trigger}
                        </Text>
                        <Text style={{ color: theme.textTertiary, fontSize: 11 }}>
                          {cp.createdAt} · {cp.patchBytes.toLocaleString()} bytes
                        </Text>
                      </View>
                      <StatusPill label={cp.changed ? "changed" : "no changes"} tone={cp.changed ? "warning" : "neutral"} />
                    </View>

                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
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
                        onPress={() => {
                          const checkpointKey = `${backup.targetSessionId}:${cp.id}`;
                          setExpandedCheckpointKey((state) => state === checkpointKey ? null : checkpointKey);
                          if (!deltasByCheckpointKey[checkpointKey]) {
                            void fetchDelta(backup.targetSessionId, cp.id);
                          }
                        }}
                        style={({ pressed }) => ({
                          borderRadius: 999,
                          borderWidth: 1,
                          borderColor: theme.border,
                          backgroundColor: pressed ? theme.surfaceMuted : "transparent",
                          paddingHorizontal: 10,
                          paddingVertical: 5,
                        })}
                      >
                        <Text style={{ color: theme.text, fontSize: 12, fontWeight: "600" }}>
                          {expandedCheckpointKey === `${backup.targetSessionId}:${cp.id}` ? "Hide delta" : "Inspect delta"}
                        </Text>
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
                  </View>

                  {expandedCheckpointKey === `${backup.targetSessionId}:${cp.id}` && deltasByCheckpointKey[`${backup.targetSessionId}:${cp.id}`] ? (
                    <View
                      style={{
                        gap: 6,
                        borderRadius: 14,
                        borderCurve: "continuous",
                        borderWidth: 1,
                        borderColor: theme.border,
                        backgroundColor: theme.surfaceMuted,
                        paddingHorizontal: 12,
                        paddingVertical: 10,
                      }}
                    >
                      <Text style={{ color: theme.text, fontSize: 13, fontWeight: "700" }}>
                        Delta · +{deltasByCheckpointKey[`${backup.targetSessionId}:${cp.id}`].counts.added} / ~{deltasByCheckpointKey[`${backup.targetSessionId}:${cp.id}`].counts.modified} / -{deltasByCheckpointKey[`${backup.targetSessionId}:${cp.id}`].counts.deleted}
                      </Text>
                      {deltasByCheckpointKey[`${backup.targetSessionId}:${cp.id}`].files.slice(0, 8).map((file) => (
                        <Text key={file.path} selectable style={{ color: theme.textSecondary, fontSize: 12 }}>
                          {file.change} · {file.path}
                        </Text>
                      ))}
                    </View>
                  ) : null}
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
