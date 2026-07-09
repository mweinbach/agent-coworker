import { Tabs } from "expo-router";
import { Platform } from "react-native";

import { useAppTheme } from "@/theme/use-app-theme";

export const unstable_settings = {
  initialRouteName: "threads",
};

/**
 * Bottom tabs for primary mobile destinations (Chats / Workspace / Skills).
 * Thread detail, settings, and workspace subpages stay on the parent stack.
 */
export default function AppTabsLayout() {
  const theme = useAppTheme();
  const headerTransparent = Platform.OS !== "web";

  return (
    <Tabs
      screenOptions={{
        headerTransparent,
        headerShadowVisible: false,
        headerLargeTitle: true,
        headerLargeTitleShadowVisible: false,
        headerBlurEffect: "none",
        headerLargeStyle: { backgroundColor: headerTransparent ? "transparent" : theme.background },
        headerTitleStyle: { color: theme.text, fontWeight: "700" },
        headerLargeTitleStyle: { color: theme.text, fontWeight: "800" },
        headerTintColor: theme.text,
        headerBackButtonDisplayMode: "minimal",
        sceneStyle: { backgroundColor: theme.background },
        tabBarActiveTintColor: theme.primary,
        tabBarInactiveTintColor: theme.textTertiary,
        tabBarStyle: {
          backgroundColor: theme.surface,
          borderTopColor: theme.borderMuted,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: "600",
        },
      }}
    >
      <Tabs.Screen
        name="threads/index"
        options={{
          title: "Chats",
          tabBarLabel: "Chats",
          headerTitle: "Cowork",
        }}
      />
      <Tabs.Screen
        name="workspace/index"
        options={{
          title: "Workspace",
          tabBarLabel: "Workspace",
        }}
      />
      <Tabs.Screen
        name="skills/index"
        options={{
          title: "Skills",
          tabBarLabel: "Skills",
        }}
      />
    </Tabs>
  );
}
