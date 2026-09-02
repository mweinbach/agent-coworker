import { ActivityIndicator, Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { StatusPill } from "@/components/ui/status-pill";
import {
  MAX_DYNAMIC_TYPE_MULTIPLIER,
  minimumTouchTarget,
  useAccessibilityAnnouncement,
  useReducedMotionEnabled,
} from "@/features/accessibility/mobile-accessibility";
import { useWorkspaceStore } from "@/features/cowork/workspaceStore";
import { switchMobileWorkspace } from "@/features/cowork/workspaceSwitchBootstrap";
import { useAppTheme } from "@/theme/use-app-theme";

type WorkspaceSwitcherProps = {
  visible: boolean;
  onClose: () => void;
};

export function WorkspaceSwitcher({ visible, onClose }: WorkspaceSwitcherProps) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const loading = useWorkspaceStore(
    (state) => state.loading || Boolean(state.switchingWorkspaceId),
  );
  const switchIncomplete = useWorkspaceStore((state) => state.switchIncomplete);
  const error = useWorkspaceStore((state) => state.error);
  const reducedMotionEnabled = useReducedMotionEnabled();
  useAccessibilityAnnouncement(error ?? (loading ? "Switching workspace" : null));

  const handleSwitch = async (workspaceId: string) => {
    const current = useWorkspaceStore.getState();
    if (current.loading || current.switchingWorkspaceId) return;
    try {
      await switchMobileWorkspace(workspaceId);
      onClose();
    } catch {
      // Keep the sheet open so the same selection can retry the incomplete operation.
    }
  };

  return (
    <Modal
      visible={visible}
      animationType={reducedMotionEnabled ? "none" : "slide"}
      presentationStyle="pageSheet"
      onRequestClose={onClose}
      accessibilityViewIsModal
    >
      <View
        style={{ flex: 1, backgroundColor: theme.background, paddingTop: Math.max(insets.top, 8) }}
      >
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
            paddingHorizontal: 20,
            paddingBottom: 16,
          }}
        >
          <Text
            accessibilityRole="header"
            maxFontSizeMultiplier={MAX_DYNAMIC_TYPE_MULTIPLIER}
            style={{ color: theme.text, fontSize: 22, fontWeight: "800" }}
          >
            Switch workspace
          </Text>
          <Pressable
            accessibilityLabel="Close workspace switcher"
            accessibilityRole="button"
            onPress={onClose}
            style={{ minHeight: minimumTouchTarget(), justifyContent: "center" }}
          >
            <Text
              maxFontSizeMultiplier={MAX_DYNAMIC_TYPE_MULTIPLIER}
              style={{ color: theme.primary, fontSize: 16, fontWeight: "600" }}
            >
              Done
            </Text>
          </Pressable>
        </View>

        {error ? (
          <View style={{ paddingHorizontal: 20, paddingBottom: 16, gap: 6 }}>
            <Text
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              maxFontSizeMultiplier={MAX_DYNAMIC_TYPE_MULTIPLIER}
              style={{ color: theme.danger }}
            >
              {error}
            </Text>
            {switchIncomplete ? (
              <Text style={{ color: theme.textSecondary }}>
                Select this workspace again to retry.
              </Text>
            ) : null}
          </View>
        ) : null}

        {loading ? (
          <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
            <ActivityIndicator size="large" color={theme.primary} />
            <Text
              accessibilityLiveRegion="polite"
              maxFontSizeMultiplier={MAX_DYNAMIC_TYPE_MULTIPLIER}
              style={{ color: theme.textSecondary, marginTop: 12, fontSize: 14 }}
            >
              Switching workspace...
            </Text>
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={{
              paddingHorizontal: 20,
              gap: 10,
              paddingBottom: Math.max(insets.bottom + 16, 32),
            }}
          >
            {workspaces.map((workspace) => {
              const isActive = workspace.id === activeWorkspaceId;
              return (
                <Pressable
                  key={workspace.id}
                  accessibilityLabel={`${workspace.name}, ${workspace.path}`}
                  accessibilityRole="radio"
                  accessibilityState={{ busy: loading, selected: isActive }}
                  disabled={loading}
                  onPress={() => {
                    void handleSwitch(workspace.id);
                  }}
                  style={({ pressed }) => ({
                    minHeight: minimumTouchTarget(),
                    gap: 6,
                    borderRadius: 22,
                    borderCurve: "continuous",
                    borderWidth: isActive ? 2 : 1,
                    borderColor: isActive
                      ? theme.primary
                      : pressed
                        ? theme.primary
                        : theme.borderMuted,
                    backgroundColor: isActive
                      ? theme.surfaceMuted
                      : pressed
                        ? theme.surfaceMuted
                        : theme.surfaceElevated,
                    paddingHorizontal: 16,
                    paddingVertical: 14,
                  })}
                >
                  <View
                    style={{
                      flexDirection: "row",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <Text
                      maxFontSizeMultiplier={MAX_DYNAMIC_TYPE_MULTIPLIER}
                      style={{ color: theme.text, fontSize: 16, fontWeight: "700", flex: 1 }}
                    >
                      {workspace.name}
                    </Text>
                    {isActive ? <StatusPill label="active" tone="success" /> : null}
                  </View>
                  <Text
                    maxFontSizeMultiplier={MAX_DYNAMIC_TYPE_MULTIPLIER}
                    style={{ color: theme.textSecondary, fontSize: 13 }}
                  >
                    {workspace.path}
                  </Text>
                  {workspace.defaultProvider || workspace.defaultModel ? (
                    <Text
                      maxFontSizeMultiplier={MAX_DYNAMIC_TYPE_MULTIPLIER}
                      style={{ color: theme.textTertiary, fontSize: 12 }}
                    >
                      {[workspace.defaultProvider, workspace.defaultModel]
                        .filter(Boolean)
                        .join(" / ")}
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
