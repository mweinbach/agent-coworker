import { Alert, Modal, Pressable, Text, View, ActivityIndicator, ScrollView } from "react-native";

import { StatusPill } from "@/components/ui/status-pill";
import { refreshWorkspaceBoundStores } from "@/features/cowork/workspaceBootstrap";
import { useWorkspaceStore } from "@/features/cowork/workspaceStore";
import { useThreadStore } from "@/features/cowork/threadStore";
import { getActiveCoworkJsonRpcClient } from "@/features/cowork/runtimeClient";
import { bootstrapWorkspaceSwitchSession } from "@/features/cowork/workspaceSwitchBootstrap";
import { useAppTheme } from "@/theme/use-app-theme";
import type { SessionSnapshotLike } from "@/features/cowork/protocolTypes";

function createThreadSnapshot(thread: {
  id: string;
  title: string;
  lastEventSeq: number;
}): SessionSnapshotLike {
  const now = new Date().toISOString();
  return {
    sessionId: thread.id,
    title: thread.title,
    titleSource: "manual",
    provider: "opencode",
    model: "remote-session",
    sessionKind: "primary",
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    lastEventSeq: thread.lastEventSeq,
    feed: [],
    agents: [],
    todos: [],
    hasPendingAsk: false,
    hasPendingApproval: false,
  };
}

type WorkspaceSwitcherProps = {
  visible: boolean;
  onClose: () => void;
};

export function WorkspaceSwitcher({ visible, onClose }: WorkspaceSwitcherProps) {
  const theme = useAppTheme();
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const switchWorkspace = useWorkspaceStore((state) => state.switchWorkspace);
  const loading = useWorkspaceStore((state) => state.loading);

  const handleSwitch = async (workspaceId: string) => {
    if (workspaceId === activeWorkspaceId) {
      onClose();
      return;
    }
    try {
      await switchWorkspace(workspaceId);

      const client = getActiveCoworkJsonRpcClient();
      if (client) {
        try {
          const threadStore = useThreadStore.getState();
          await bootstrapWorkspaceSwitchSession({
            client,
            clearThreads: () => {
              threadStore.clearAll();
            },
            hydrateThread: (thread) => {
              threadStore.hydrate(createThreadSnapshot(thread));
            },
            refreshWorkspaceBoundStores,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Could not refresh workspace data after switching.";
          useWorkspaceStore.setState({ error: message, loading: false });
          Alert.alert("Workspace switch incomplete", message);
          return;
        }
      }
      onClose();
    } catch {
      // The store already captured the error for UI display.
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, backgroundColor: theme.background, paddingTop: 20 }}>
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
            paddingHorizontal: 20,
            paddingBottom: 16,
          }}
        >
          <Text style={{ color: theme.text, fontSize: 22, fontWeight: "800" }}>
            Switch workspace
          </Text>
          <Pressable onPress={onClose}>
            <Text style={{ color: theme.primary, fontSize: 16, fontWeight: "600" }}>Done</Text>
          </Pressable>
        </View>

        {loading ? (
          <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
            <ActivityIndicator size="large" color={theme.primary} />
            <Text style={{ color: theme.textSecondary, marginTop: 12, fontSize: 14 }}>
              Switching workspace...
            </Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={{ paddingHorizontal: 20, gap: 10, paddingBottom: 40 }}>
            {workspaces.map((workspace) => {
              const isActive = workspace.id === activeWorkspaceId;
              return (
                <Pressable
                  key={workspace.id}
                  onPress={() => {
                    void handleSwitch(workspace.id);
                  }}
                  style={({ pressed }) => ({
                    gap: 6,
                    borderRadius: 22,
                    borderCurve: "continuous",
                    borderWidth: isActive ? 2 : 1,
                    borderColor: isActive ? theme.primary : pressed ? theme.primary : theme.borderMuted,
                    backgroundColor: isActive ? theme.surfaceMuted : pressed ? theme.surfaceMuted : theme.surfaceElevated,
                    paddingHorizontal: 16,
                    paddingVertical: 14,
                  })}
                >
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                    <Text style={{ color: theme.text, fontSize: 16, fontWeight: "700", flex: 1 }}>
                      {workspace.name}
                    </Text>
                    {isActive ? <StatusPill label="active" tone="success" /> : null}
                  </View>
                  <Text
                    numberOfLines={1}
                    style={{ color: theme.textSecondary, fontSize: 13 }}
                  >
                    {workspace.path}
                  </Text>
                  {workspace.defaultProvider || workspace.defaultModel ? (
                    <Text style={{ color: theme.textTertiary, fontSize: 12 }}>
                      {[workspace.defaultProvider, workspace.defaultModel].filter(Boolean).join(" / ")}
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}
