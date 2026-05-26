import { Stack } from "expo-router";
import { Platform } from "react-native";

import { useAppTheme } from "@/theme/use-app-theme";

export default function PairingLayout() {
  const theme = useAppTheme();
  const useNativeChrome = Platform.OS === "ios";

  return (
    <Stack
      screenOptions={{
        headerLargeTitle: true,
        headerTransparent: useNativeChrome,
        headerShadowVisible: false,
        headerLargeTitleShadowVisible: false,
        headerStyle: {
          backgroundColor: useNativeChrome ? "transparent" : theme.background,
        },
        headerLargeStyle: {
          backgroundColor: useNativeChrome ? "transparent" : theme.background,
        },
        headerTintColor: theme.text,
        headerLargeTitleStyle: {
          color: theme.text,
          fontWeight: "700",
        },
        headerTitleStyle: {
          color: theme.text,
          fontWeight: "600",
        },
        headerBackButtonDisplayMode: "minimal",
        contentStyle: {
          flex: 1,
          backgroundColor: useNativeChrome ? "transparent" : theme.background,
        },
      }}
    >
      <Stack.Screen
        name="index"
        options={{
          title: "Remote Access",
          headerRight: () => null,
          unstable_headerRightItems: () => [],
        }}
      />
      <Stack.Screen
        name="scan"
        options={{
          title: "Scan Code",
          headerLargeTitle: false,
          presentation: "modal",
        }}
      />
    </Stack>
  );
}
