import { Text, View } from "react-native";

import { Screen } from "@/components/ui/screen";
import { SectionCard } from "@/components/ui/section-card";
import { useThreadStore } from "@/features/cowork/threadStore";
import { useWorkspaceStore } from "@/features/cowork/workspaceStore";
import { usePairingStore } from "@/features/pairing/pairingStore";
import { isWorkspaceConnectionReady } from "@/features/relay/connectionState";
import { useAppTheme } from "@/theme/use-app-theme";

function UsageRow({ label, value }: { label: string; value: string }) {
  const theme = useAppTheme();
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 8 }}>
      <Text style={{ color: theme.textSecondary, fontSize: 14 }}>{label}</Text>
      <Text style={{ color: theme.text, fontSize: 14, fontWeight: "600", fontVariant: ["tabular-nums"] }}>
        {value}
      </Text>
    </View>
  );
}

export default function UsageScreen() {
  const theme = useAppTheme();
  const threads = useThreadStore((s) => s.threads);
  const snapshots = useThreadStore((s) => s.snapshots);
  const activeWorkspaceName = useWorkspaceStore((s) => s.activeWorkspaceName);
  const controlSnapshot = useWorkspaceStore((s) => s.controlSnapshot);
  const isConnected = usePairingStore((s) => isWorkspaceConnectionReady(s.connectionState));

  // Aggregate usage from thread snapshots
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCost = 0;
  for (const snapshot of Object.values(snapshots)) {
    const usage = snapshot.sessionUsage as Record<string, unknown> | null | undefined;
    if (usage) {
      if (typeof usage.inputTokens === "number") totalInputTokens += usage.inputTokens;
      if (typeof usage.outputTokens === "number") totalOutputTokens += usage.outputTokens;
      if (typeof usage.totalCostUsd === "number") totalCost += usage.totalCostUsd;
    }
  }

  if (!isConnected) {
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
        title={activeWorkspaceName ?? "Workspace"}
        description={`${controlSnapshot?.config?.provider ?? "provider"} / ${controlSnapshot?.config?.model ?? "model"}`}
      >
        <View>
          <UsageRow label="Threads" value={String(threads.length)} />
          <UsageRow label="Input tokens" value={totalInputTokens.toLocaleString()} />
          <UsageRow label="Output tokens" value={totalOutputTokens.toLocaleString()} />
          {totalCost > 0 ? (
            <UsageRow label="Estimated cost" value={`$${totalCost.toFixed(4)}`} />
          ) : null}
        </View>
      </SectionCard>
    </Screen>
  );
}
