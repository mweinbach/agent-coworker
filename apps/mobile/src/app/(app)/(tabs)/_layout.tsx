import { NativeTabs, Icon, Label } from "expo-router/unstable-native-tabs";

import { useAppTheme } from "@/theme/use-app-theme";

export default function AppTabsLayout() {
  const theme = useAppTheme();

  return (
    <NativeTabs tintColor={theme.primary}>
      <NativeTabs.Trigger name="(threads)">
        <Label>Threads</Label>
        <Icon sf={{ default: "bubble.left", selected: "bubble.left.fill" }} />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(workspace)">
        <Label>Workspace</Label>
        <Icon sf={{ default: "square.grid.2x2", selected: "square.grid.2x2.fill" }} />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(settings)">
        <Label>Settings</Label>
        <Icon sf={{ default: "gearshape", selected: "gearshape.fill" }} />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(connection)">
        <Label>Remote Access</Label>
        <Icon sf={{ default: "wifi", selected: "wifi" }} />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
