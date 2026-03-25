import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { StatusPill } from "@/components/ui/status-pill";
import { useAppTheme } from "@/theme/use-app-theme";

type ToolCallCardProps = {
  name: string;
  state: string;
  args?: unknown;
  result?: unknown;
  approval?: {
    approvalId: string;
    reason?: unknown;
    toolCall?: unknown;
  };
};

function stateTone(state: string): "warning" | "success" | "danger" | "neutral" | "primary" {
  switch (state) {
    case "input-streaming":
    case "input-available":
      return "neutral";
    case "approval-requested":
      return "warning";
    case "output-available":
      return "success";
    case "output-error":
    case "output-denied":
      return "danger";
    default:
      return "neutral";
  }
}

function stateLabel(state: string): string {
  switch (state) {
    case "input-streaming":
      return "streaming";
    case "input-available":
      return "ready";
    case "approval-requested":
      return "needs approval";
    case "output-available":
      return "done";
    case "output-error":
      return "error";
    case "output-denied":
      return "denied";
    default:
      return state;
  }
}

function CollapsibleJson({ label, data }: { label: string; data: unknown }) {
  const theme = useAppTheme();
  const [expanded, setExpanded] = useState(false);

  if (data === undefined || data === null) return null;

  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const lines = text.split("\n");
  const isLong = lines.length > 4;
  const preview = isLong ? lines.slice(0, 3).join("\n") + "\n..." : text;

  return (
    <View style={{ gap: 4 }}>
      <Pressable onPress={() => setExpanded(!expanded)} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text style={{ color: theme.textTertiary, fontSize: 11, fontWeight: "600", textTransform: "uppercase" }}>
          {label}
        </Text>
        {isLong ? (
          <Text style={{ color: theme.primary, fontSize: 11, fontWeight: "600" }}>
            {expanded ? "collapse" : "expand"}
          </Text>
        ) : null}
      </Pressable>
      <Text
        selectable
        style={{
          fontFamily: "Menlo",
          fontSize: 11,
          lineHeight: 16,
          color: theme.textSecondary,
          backgroundColor: theme.surfaceMuted,
          borderRadius: 10,
          borderCurve: "continuous",
          padding: 10,
          overflow: "hidden",
        }}
      >
        {expanded ? text : preview}
      </Text>
    </View>
  );
}

export function ToolCallCard({ name, state, args, result, approval }: ToolCallCardProps) {
  const theme = useAppTheme();

  return (
    <View
      style={{
        gap: 10,
        borderRadius: 22,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: theme.border,
        backgroundColor: theme.surface,
        paddingHorizontal: 16,
        paddingVertical: 14,
      }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text
          selectable
          style={{
            color: theme.warning,
            fontSize: 11,
            fontWeight: "700",
            letterSpacing: 0.6,
            textTransform: "uppercase",
          }}
        >
          {name}
        </Text>
        <StatusPill label={stateLabel(state)} tone={stateTone(state)} />
      </View>

      {approval ? (
        <View
          style={{
            backgroundColor: theme.warningMuted ?? theme.surfaceMuted,
            borderRadius: 10,
            borderCurve: "continuous",
            padding: 10,
          }}
        >
          <Text style={{ color: theme.warning, fontSize: 12, fontWeight: "600" }}>
            Approval requested
          </Text>
          {typeof approval.reason === "string" ? (
            <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 4 }}>
              {approval.reason}
            </Text>
          ) : null}
        </View>
      ) : null}

      <CollapsibleJson label="Arguments" data={args} />
      <CollapsibleJson label="Result" data={result} />
    </View>
  );
}
