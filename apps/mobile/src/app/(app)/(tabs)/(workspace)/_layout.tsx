import { Stack } from "expo-router/stack";

import { useAppTheme } from "@/theme/use-app-theme";

export const unstable_settings = {
  initialRouteName: "workspace/index",
};

export default function WorkspaceStackLayout() {
  const theme = useAppTheme();

  return (
    <Stack
      screenOptions={{
        headerBackButtonDisplayMode: "minimal",
        headerBlurEffect: "none",
        headerLargeStyle: { backgroundColor: "transparent" },
        headerLargeTitle: true,
        headerLargeTitleShadowVisible: false,
        headerLargeTitleStyle: { color: theme.text },
        headerShadowVisible: false,
        headerTintColor: theme.text,
        headerTitleStyle: { color: theme.text },
        headerTransparent: true,
        contentStyle: { backgroundColor: theme.backgroundMuted },
      }}
    >
      <Stack.Screen name="workspace/index" options={{ title: "Workspace" }} />
      <Stack.Screen
        name="workspace/general"
        options={{ headerLargeTitle: false, title: "General" }}
      />
      <Stack.Screen
        name="workspace/memory"
        options={{ headerLargeTitle: false, title: "Memory" }}
      />
      <Stack.Screen
        name="workspace/backups"
        options={{ headerLargeTitle: false, title: "Backups" }}
      />
    </Stack>
  );
}
