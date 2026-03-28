import { Stack } from "expo-router/stack";

import { useAppTheme } from "@/theme/use-app-theme";

export default function AppLayout() {
  const theme = useAppTheme();

  return (
    <Stack
      screenOptions={{
        headerTransparent: true,
        headerShadowVisible: false,
        headerLargeTitle: true,
        headerLargeTitleShadowVisible: false,
        headerBlurEffect: "none",
        headerLargeStyle: { backgroundColor: "transparent" },
        headerTitleStyle: { color: theme.text, fontWeight: "700" },
        headerLargeTitleStyle: { color: theme.text, fontWeight: "800" },
        headerTintColor: theme.text,
        headerBackButtonDisplayMode: "minimal",
        contentStyle: { backgroundColor: theme.background },
      }}
    >
      <Stack.Screen
        name="(tabs)"
        options={{
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="thread/[id]"
        options={{
          headerLargeTitle: false,
          title: "Conversation",
        }}
      />
      
      {/* Settings Modal or Pushed Group */}
      <Stack.Screen
        name="settings/providers"
        options={{ title: "Providers", headerLargeTitle: false }}
      />
      <Stack.Screen
        name="settings/mcp"
        options={{ title: "Integrations", headerLargeTitle: false }}
      />
      <Stack.Screen
        name="settings/usage"
        options={{ title: "Usage", headerLargeTitle: false }}
      />
      
      <Stack.Screen
        name="workspace/general"
        options={{ title: "General", headerLargeTitle: false }}
      />
      <Stack.Screen
        name="workspace/memory"
        options={{ title: "Memory", headerLargeTitle: false }}
      />
      <Stack.Screen
        name="workspace/backups"
        options={{ title: "Backups", headerLargeTitle: false }}
      />

    </Stack>
  );
}
