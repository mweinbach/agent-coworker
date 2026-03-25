import { Stack } from "expo-router";

import { useAppTheme } from "@/theme/use-app-theme";

export default function ConnectionStackLayout() {
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
      <Stack.Screen
        name="index"
        options={{
          title: "Connection",
        }}
      />
    </Stack>
  );
}
