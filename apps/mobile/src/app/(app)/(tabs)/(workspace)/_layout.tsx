import { Stack } from "expo-router";

import { useAppTheme } from "@/theme/use-app-theme";

export default function WorkspaceStackLayout() {
  const theme = useAppTheme();

  return (
    <Stack
      screenOptions={{
        headerLargeTitle: true,
        headerTransparent: true,
        headerShadowVisible: false,
        headerTintColor: theme.text,
        headerStyle: {
          backgroundColor: theme.background,
        },
        headerLargeTitleStyle: {
          color: theme.text,
        },
        headerTitleStyle: {
          color: theme.text,
        },
      }}
    >
      <Stack.Screen name="index" options={{ title: "Workspace" }} />
      <Stack.Screen name="general" options={{ title: "General" }} />
      <Stack.Screen name="skills" options={{ title: "Skills" }} />
      <Stack.Screen name="memory" options={{ title: "Memory" }} />
      <Stack.Screen name="backups" options={{ title: "Backup" }} />
    </Stack>
  );
}
