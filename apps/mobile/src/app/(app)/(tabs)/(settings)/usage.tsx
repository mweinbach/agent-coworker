import { Text } from "react-native";

import { Screen } from "@/components/ui/screen";
import { SectionCard } from "@/components/ui/section-card";
import { useAppTheme } from "@/theme/use-app-theme";

export default function UsageScreen() {
  const theme = useAppTheme();

  return (
    <Screen scroll>
      <SectionCard title="Usage" description="Token and cost breakdown for the active workspace.">
        <Text selectable style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>
          Usage statistics will load here once connected to a workspace.
        </Text>
      </SectionCard>
    </Screen>
  );
}
