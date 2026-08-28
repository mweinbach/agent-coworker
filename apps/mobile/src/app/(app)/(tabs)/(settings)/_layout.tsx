import { Stack } from "expo-router/stack";
import { Platform } from "react-native";

import { useAppTheme } from "@/theme/use-app-theme";

export const unstable_settings = {
  initialRouteName: "settings/index",
};

export default function SettingsStackLayout() {
  const theme = useAppTheme();
  const useNativeChrome = Platform.OS === "ios";

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
        headerStyle: { backgroundColor: useNativeChrome ? "transparent" : theme.backgroundMuted },
        headerTintColor: theme.text,
        headerTitleStyle: { color: theme.text },
        headerTransparent: useNativeChrome,
        contentStyle: { backgroundColor: theme.backgroundMuted },
      }}
    >
      <Stack.Screen name="settings/index" options={{ title: "Settings" }} />
      <Stack.Screen
        name="settings/providers"
        options={{ headerLargeTitle: false, title: "Providers" }}
      />
      <Stack.Screen
        name="settings/mcp"
        options={{ headerLargeTitle: false, title: "Integrations" }}
      />
      <Stack.Screen name="settings/usage" options={{ headerLargeTitle: false, title: "Usage" }} />
    </Stack>
  );
}
