import { Stack } from "expo-router/stack";
import { Platform } from "react-native";

import { useAppTheme } from "@/theme/use-app-theme";

export const unstable_settings = {
  initialRouteName: "threads/index",
};

export default function ChatsStackLayout() {
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
        headerStyle: { backgroundColor: useNativeChrome ? "transparent" : theme.background },
        headerTintColor: theme.text,
        headerTitleStyle: { color: theme.text },
        headerTransparent: useNativeChrome,
        contentStyle: { backgroundColor: theme.background },
      }}
    >
      <Stack.Screen name="threads/index" options={{ title: "Cowork" }} />
      <Stack.Screen
        name="thread/[id]"
        options={{ headerLargeTitle: false, title: "Conversation" }}
      />
    </Stack>
  );
}
