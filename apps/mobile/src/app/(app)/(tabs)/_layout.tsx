import { Tabs } from "expo-router";
import { Platform } from "react-native";

import { SFSymbol } from "@/components/ui/sf-symbol";
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
        headerStyle: { backgroundColor: headerTransparent ? "transparent" : theme.background },
        headerTitleStyle: { color: theme.text, fontWeight: "700" },
        headerTintColor: theme.text,
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
          tabBarIcon: ({ color, size }) => (
            <SFSymbol name="bubble.left.and.bubble.right.fill" color={color} size={size ?? 22} />
          ),
          tabBarAccessibilityLabel: "Chats",
        }}
      />
      <Tabs.Screen
        name="workspace/index"
        options={{
          title: "Workspace",
          tabBarLabel: "Workspace",
          tabBarIcon: ({ color, size }) => (
            <SFSymbol name="folder.fill" color={color} size={size ?? 22} />
          ),
          tabBarAccessibilityLabel: "Workspace",
        }}
      />
      <Tabs.Screen
        name="skills/index"
        options={{
          title: "Skills",
          tabBarLabel: "Skills",
          tabBarIcon: ({ color, size }) => (
            <SFSymbol name="sparkles" color={color} size={size ?? 22} />
          ),
          tabBarAccessibilityLabel: "Skills",
        }}
      />
    </Tabs>
  );
}
