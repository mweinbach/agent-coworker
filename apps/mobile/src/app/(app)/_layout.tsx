import { Stack } from "expo-router/stack";
import { PlatformColor } from "react-native";

export default function AppLayout() {
  return (
    <Stack
      screenOptions={{
        headerLargeTitle: true,
        headerTransparent: true,
        headerShadowVisible: false,
        headerLargeTitleShadowVisible: false,
        headerLargeStyle: { backgroundColor: "transparent" },
        headerTitleStyle: { color: PlatformColor("label") as any },
        headerBlurEffect: "none",
        headerBackButtonDisplayMode: "minimal",
      }}
    >
      <Stack.Screen
        name="index"
        options={{
          title: "Threads",
          // The title should actually probably be the workspace name according to design, 
          // or we can set it dynamically in the screen itself using Stack.Screen.
        }}
      />
      <Stack.Screen
        name="thread/[id]"
        options={{
          headerLargeTitle: false,
          title: "Conversation",
        }}
      />
      
      {/* Settings Modal or Pushed Group */}
      <Stack.Screen
        name="settings/index"
        options={{ title: "Settings" }}
      />
      <Stack.Screen
        name="settings/providers"
        options={{ title: "Providers", headerLargeTitle: false }}
      />
      <Stack.Screen
        name="settings/mcp"
        options={{ title: "Integrations", headerLargeTitle: false }}
      />
      <Stack.Screen
        name="settings/usage"
        options={{ title: "Usage", headerLargeTitle: false }}
      />
      
      {/* Skills Screen */}
      <Stack.Screen
        name="skills/index"
        options={{ title: "Skills" }}
      />

      {/* Workspace Settings */}
      <Stack.Screen
        name="workspace/index"
        options={{ title: "Workspace" }}
      />
      <Stack.Screen
        name="workspace/general"
        options={{ title: "General", headerLargeTitle: false }}
      />
      <Stack.Screen
        name="workspace/memory"
        options={{ title: "Memory", headerLargeTitle: false }}
      />
      <Stack.Screen
        name="workspace/backups"
        options={{ title: "Backups", headerLargeTitle: false }}
      />

      {/* Modals and Sheets */}
      <Stack.Screen
        name="workspace-switcher"
        options={{
          presentation: "formSheet",
          sheetGrabberVisible: true,
          sheetAllowedDetents: [0.5, 1.0],
          contentStyle: { backgroundColor: "transparent" },
        }}
      />
    </Stack>
  );
}
