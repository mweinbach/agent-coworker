import { Text } from "react-native";

import { Screen } from "@/components/ui/screen";
import { SectionCard } from "@/components/ui/section-card";
import { useAppTheme } from "@/theme/use-app-theme";

export default function ModelsScreen() {
  const theme = useAppTheme();

  return (
    <Screen scroll>
      <SectionCard title="Models" description="Select the default model for the active workspace.">
        <Text selectable style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>
          Model selection will load here once connected to a workspace.
        </Text>
      </SectionCard>
    </Screen>
  );
}
