import { NativeTabs, Badge, Icon, Label } from "expo-router/unstable-native-tabs";

import { useThreadStore } from "@/features/cowork/threadStore";
import { useAppTheme } from "@/theme/use-app-theme";

export default function AppTabsLayout() {
  const theme = useAppTheme();
  const pendingCount = useThreadStore((state) =>
    state.threads.filter((thread) => thread.pendingPrompt).length,
  );

  return (
    <NativeTabs
      tintColor={theme.primary}
      backgroundColor={theme.surface}
      badgeBackgroundColor={theme.accent}
      blurEffect={theme.isDark ? "systemChromeMaterialDark" : "systemChromeMaterialLight"}
      iconColor={{
        default: theme.textTertiary,
        selected: theme.primary,
      }}
      labelStyle={{
        default: {
          color: theme.textTertiary,
          fontSize: 11,
          fontWeight: "600",
        },
        selected: {
          color: theme.primary,
          fontSize: 11,
          fontWeight: "700",
        },
      }}
      minimizeBehavior="onScrollDown"
      shadowColor={theme.border}
    >
      <NativeTabs.Trigger name="workspace">
        <Icon
          sf={{
            default: "square.grid.2x2",
            selected: "square.grid.2x2.fill",
          }}
        />
        <Label>Workspace</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="threads">
        <Icon
          sf={{
            default: "bubble.left.and.bubble.right",
            selected: "bubble.left.and.bubble.right.fill",
          }}
        />
        <Label>Threads</Label>
        {pendingCount > 0 ? (
          <Badge>{pendingCount > 9 ? "9+" : String(pendingCount)}</Badge>
        ) : null}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="skills">
        <Icon
          sf={{
            default: "sparkles",
            selected: "sparkles",
          }}
        />
        <Label>Skills</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <Icon
          sf={{
            default: "slider.horizontal.3",
            selected: "slider.horizontal.3",
          }}
        />
        <Label>Settings</Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
