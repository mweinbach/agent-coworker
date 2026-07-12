import { Stack } from "expo-router/stack";

import { useAppTheme } from "@/theme/use-app-theme";

export const unstable_settings = {
  initialRouteName: "skills/index",
};

export default function SkillsStackLayout() {
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
      <Stack.Screen name="skills/index" options={{ title: "Skills" }} />
    </Stack>
  );
}
