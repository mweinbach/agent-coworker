import { Text } from "react-native";

import { Screen } from "@/components/ui/screen";
import { SectionCard } from "@/components/ui/section-card";
import { useAppTheme } from "@/theme/use-app-theme";

export default function MemoryScreen() {
  const theme = useAppTheme();

  return (
    <Screen scroll>
      <SectionCard title="Memory" description="View and edit workspace and user memory entries.">
        <Text selectable style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>
          Memory entries will load here once connected to a workspace.
        </Text>
      </SectionCard>
    </Screen>
  );
}
