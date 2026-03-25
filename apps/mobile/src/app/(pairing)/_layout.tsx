import { Stack } from "expo-router";

import { useAppTheme } from "@/theme/use-app-theme";

export default function PairingLayout() {
  const theme = useAppTheme();

  return (
    <Stack
      screenOptions={{
        headerLargeTitle: true,
        headerShadowVisible: false,
        headerTransparent: true,
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
          title: "Remote Access",
        }}
      />
      <Stack.Screen
        name="scan"
        options={{
          title: "Scan Desktop",
          headerLargeTitle: false,
          headerBackButtonDisplayMode: "minimal",
          presentation: "card",
        }}
      />
    </Stack>
  );
}
