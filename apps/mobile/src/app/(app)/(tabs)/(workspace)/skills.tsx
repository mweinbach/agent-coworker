import { Text } from "react-native";

import { Screen } from "@/components/ui/screen";
import { SectionCard } from "@/components/ui/section-card";
import { useAppTheme } from "@/theme/use-app-theme";

export default function SkillsScreen() {
  const theme = useAppTheme();

  return (
    <Screen scroll>
      <SectionCard title="Skills" description="Browse, install, and manage workspace skills.">
        <Text selectable style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>
          Skills catalog will load here once connected to a workspace.
        </Text>
      </SectionCard>
    </Screen>
  );
}
