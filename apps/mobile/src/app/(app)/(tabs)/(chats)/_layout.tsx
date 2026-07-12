import { Stack } from "expo-router/stack";

import { useAppTheme } from "@/theme/use-app-theme";

export const unstable_settings = {
  initialRouteName: "threads/index",
};

export default function ChatsStackLayout() {
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
