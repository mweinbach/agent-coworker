import { Stack } from "expo-router";

import { useAppTheme } from "@/theme/use-app-theme";

export default function PairingLayout() {
  const theme = useAppTheme();

  return (
    <Stack
      screenOptions={{
        headerLargeTitle: true,
        headerTransparent: true,
        headerShadowVisible: false,
        headerLargeTitleShadowVisible: false,
        headerBlurEffect: "none",
        headerLargeStyle: {
          backgroundColor: "transparent",
        },
        headerTintColor: theme.text,
        headerLargeTitleStyle: {
          color: theme.text,
          fontWeight: "700",
        },
        headerTitleStyle: {
          color: theme.text,
        },
        headerBackButtonDisplayMode: "minimal",
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
          presentation: "modal",
        }}
      />
    </Stack>
  );
}
