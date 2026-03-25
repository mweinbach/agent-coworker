import { Stack } from "expo-router";

import { useAppTheme } from "@/theme/use-app-theme";

export default function SettingsStackLayout() {
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
      <Stack.Screen name="index" options={{ title: "Settings" }} />
      <Stack.Screen name="providers" options={{ title: "Providers" }} />
      <Stack.Screen name="mcp" options={{ title: "Integrations" }} />
      <Stack.Screen name="usage" options={{ title: "Usage" }} />
    </Stack>
  );
}
