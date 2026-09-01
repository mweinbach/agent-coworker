import { Text, View } from "react-native";

import { Screen } from "@/components/ui/screen";
import { SectionCard } from "@/components/ui/section-card";
import { useThreadStore } from "@/features/cowork/threadStore";
import { summarizeLoadedUsage } from "@/features/cowork/usageSummary";
import { usePairingStore } from "@/features/pairing/pairingStore";
import { isWorkspaceConnectionReady } from "@/features/relay/connectionState";
import { useAppTheme } from "@/theme/use-app-theme";

function UsageRow({ label, value }: { label: string; value: string }) {
  const theme = useAppTheme();
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 8 }}>
      <Text style={{ color: theme.textSecondary, fontSize: 14 }}>{label}</Text>
      <Text
        style={{
          color: theme.text,
          fontSize: 14,
          fontWeight: "600",
          fontVariant: ["tabular-nums"],
        }}
      >
        {value}
      </Text>
    </View>
  );
}

export default function UsageScreen() {
  const theme = useAppTheme();
  const snapshots = useThreadStore((s) => s.snapshots);
  const isConnected = usePairingStore((s) => isWorkspaceConnectionReady(s.connectionState));

  const usage = summarizeLoadedUsage(Object.values(snapshots));

  if (!isConnected && usage.sessionsWithUsage === 0) {
    return (
      <Screen scroll>
        <SectionCard title="Usage" description="Connect to a desktop to view usage statistics.">
          <Text selectable style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>
            Usage statistics will load here once connected to a workspace.
          </Text>
        </SectionCard>
      </Screen>
    );
  }

  return (
    <Screen scroll contentStyle={{ gap: 18 }}>
      <SectionCard
        title="Loaded chat usage"
        description="Includes only conversations loaded on this phone, not your full desktop history."
      >
        <View>
          <UsageRow label="Chats with usage" value={String(usage.sessionsWithUsage)} />
          <UsageRow label="Input tokens" value={usage.inputTokens.toLocaleString()} />
          <UsageRow label="Output tokens" value={usage.outputTokens.toLocaleString()} />
          <UsageRow
            label="Estimated cost"
            value={
              usage.estimatedCostUsd === null
                ? "Unavailable"
                : `$${usage.estimatedCostUsd.toFixed(4)}`
            }
          />
        </View>
      </SectionCard>
    </Screen>
  );
}
