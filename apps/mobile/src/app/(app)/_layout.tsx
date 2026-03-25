import { Stack } from "expo-router";

export default function AppShellLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, animation: "fade" }}>
      <Stack.Screen name="(tabs)" />
    </Stack>
  );
}
