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
      <NativeTabs.Trigger name="(settings)">
        <Label>Connection</Label>
        <Icon sf={{ default: "gearshape", selected: "gearshape.fill" }} />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
