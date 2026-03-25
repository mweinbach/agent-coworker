import { Text } from "react-native";

import { Screen } from "@/components/ui/screen";
import { SectionCard } from "@/components/ui/section-card";
import { useAppTheme } from "@/theme/use-app-theme";

export default function ProvidersScreen() {
  const theme = useAppTheme();

  return (
    <Screen scroll>
      <SectionCard title="Providers" description="Configure AI provider API keys and authentication.">
        <Text selectable style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>
          Provider management will load here once connected to a workspace.
        </Text>
      </SectionCard>
    </Screen>
  );
}
