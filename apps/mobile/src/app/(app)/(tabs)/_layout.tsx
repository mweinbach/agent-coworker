import { Stack } from "expo-router";
import { Platform } from "react-native";

import { useAppTheme } from "@/theme/use-app-theme";

export const unstable_settings = {
  initialRouteName: "threads",
};

export default function AppTabsLayout() {
  const theme = useAppTheme();
  const headerTransparent = Platform.OS !== "web";

  return (
    <Stack
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
        contentStyle: { backgroundColor: theme.background },
      }}
    >
      <Stack.Screen name="threads/index" options={{ title: "Cowork" }} />
      <Stack.Screen name="workspace/index" options={{ title: "Workspace" }} />
      <Stack.Screen name="skills/index" options={{ title: "Skills" }} />
    </Stack>
  );
}
