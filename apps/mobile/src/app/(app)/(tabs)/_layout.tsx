import { NativeTabs } from "expo-router/unstable-native-tabs";
import { useThreadStore } from "@/features/cowork/threadStore";
import { MOBILE_TABS, pendingInputBadgeValue } from "@/features/navigation/mobile-navigation";
import { useAppTheme } from "@/theme/use-app-theme";

export const unstable_settings = {
  initialRouteName: "(chats)",
};

export default function AppTabsLayout() {
  const theme = useAppTheme();
  const pendingInputBadge = useThreadStore((state) =>
    pendingInputBadgeValue(state.pendingRequests),
  );
  const chatsTab = MOBILE_TABS[0];
  const workspaceTab = MOBILE_TABS[1];
  const skillsTab = MOBILE_TABS[2];
  const settingsTab = MOBILE_TABS[3];

  return (
    <NativeTabs
      backBehavior="history"
      backgroundColor={theme.surface}
      badgeBackgroundColor={theme.danger}
      badgeTextColor={theme.primaryText}
      iconColor={{
        default: theme.textTertiary,
        selected: theme.primary,
      }}
      indicatorColor={theme.primaryMuted}
      labelStyle={{
        default: {
          color: theme.textTertiary,
          fontSize: 12,
          fontWeight: "500",
        },
        selected: {
          color: theme.primary,
          fontSize: 12,
          fontWeight: "600",
        },
      }}
      labelVisibilityMode="labeled"
      minimizeBehavior="onScrollDown"
      rippleColor={theme.primaryMuted}
      shadowColor={theme.borderMuted}
      tintColor={theme.primary}
    >
      <NativeTabs.Trigger name={chatsTab.route}>
        <NativeTabs.Trigger.Icon sf={chatsTab.iosIcon} md={chatsTab.androidIcon} />
        <NativeTabs.Trigger.Label>{chatsTab.label}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Badge hidden={pendingInputBadge === undefined}>
          {pendingInputBadge}
        </NativeTabs.Trigger.Badge>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name={workspaceTab.route}>
        <NativeTabs.Trigger.Icon sf={workspaceTab.iosIcon} md={workspaceTab.androidIcon} />
        <NativeTabs.Trigger.Label>{workspaceTab.label}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name={skillsTab.route}>
        <NativeTabs.Trigger.Icon sf={skillsTab.iosIcon} md={skillsTab.androidIcon} />
        <NativeTabs.Trigger.Label>{skillsTab.label}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name={settingsTab.route}>
        <NativeTabs.Trigger.Icon sf={settingsTab.iosIcon} md={settingsTab.androidIcon} />
        <NativeTabs.Trigger.Label>{settingsTab.label}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
