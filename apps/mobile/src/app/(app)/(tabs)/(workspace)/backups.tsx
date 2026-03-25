import { Text } from "react-native";

import { Screen } from "@/components/ui/screen";
import { SectionCard } from "@/components/ui/section-card";
import { useAppTheme } from "@/theme/use-app-theme";

export default function BackupsScreen() {
  const theme = useAppTheme();

  return (
    <Screen scroll>
      <SectionCard title="Backups" description="Manage workspace session backups and checkpoints.">
        <Text selectable style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>
          Backup management will load here once connected to a workspace.
        </Text>
      </SectionCard>
    </Screen>
  );
}
