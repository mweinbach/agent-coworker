import { Stack } from "expo-router";

import { useAppTheme } from "@/theme/use-app-theme";

export default function SettingsTabLayout() {
  const theme = useAppTheme();

  return (
    <Stack
      screenOptions={{
        headerTransparent: true,
        headerShadowVisible: false,
        headerLargeTitle: true,
        headerLargeTitleShadowVisible: false,
        headerBlurEffect: "none",
        headerTintColor: theme.text,
        headerLargeStyle: {
          backgroundColor: "transparent",
        },
        headerTitleStyle: {
          color: theme.text,
          fontWeight: "700",
        },
        headerLargeTitleStyle: {
          color: theme.text,
          fontWeight: "800",
        },
        contentStyle: {
          backgroundColor: theme.background,
        },
      }}
    >
      <Stack.Screen name="index" options={{ title: "Settings" }} />
    </Stack>
  );
}
