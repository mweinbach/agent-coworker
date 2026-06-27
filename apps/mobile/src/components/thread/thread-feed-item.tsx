import { Text, View } from "react-native";

import type { SessionFeedItem } from "@/features/cowork/protocolTypes";
import { alpha, radius } from "@/theme/tokens";
import { useAppTheme } from "@/theme/use-app-theme";
import { A2uiSurfaceCard } from "./a2ui-surface-card";
import { MarkdownText } from "./markdown-text";
import { TodoCard } from "./todo-card";

type ThreadFeedItemProps = {
  item: SessionFeedItem;
  a2uiEnabled: boolean;
  showDebugMessages: boolean;
};

export function ThreadFeedItem({ item, a2uiEnabled, showDebugMessages }: ThreadFeedItemProps) {
  const theme = useAppTheme();

  if (item.kind === "message") {
    const isAssistant = item.role === "assistant";
    return (
      <View
        style={{
          alignSelf: isAssistant ? "stretch" : "flex-end",
          maxWidth: isAssistant ? "100%" : "88%",
        }}
      >
        <View
          style={{
            borderRadius: isAssistant ? 0 : radius.card,
            borderCurve: "continuous",
            borderWidth: isAssistant ? 0 : 1,
            // Desktop user bubble: bg-primary/12 + border-primary/22 + foreground text.
            borderColor: isAssistant ? undefined : alpha(theme.primary, 0.22),
            backgroundColor: isAssistant ? "transparent" : alpha(theme.primary, 0.12),
            paddingHorizontal: isAssistant ? 0 : 14,
            paddingVertical: isAssistant ? 0 : 10,
          }}
        >
          {isAssistant ? (
            <MarkdownText text={item.text} color={theme.text} />
          ) : (
            <Text
              selectable
              style={{
                color: theme.text,
                fontSize: 16,
                lineHeight: 24,
              }}
            >
              {item.text}
            </Text>
          )}
        </View>
      </View>
    );
  }

  if (item.kind === "reasoning" || item.kind === "tool") {
    return null;
  }

  if (item.kind === "todos") {
    return <TodoCard todos={item.todos} />;
  }

  if (item.kind === "ui_surface") {
    if (!a2uiEnabled) {
      return null;
    }
    return <A2uiSurfaceCard item={item} />;
  }

  if ((item.kind === "system" || item.kind === "log") && !showDebugMessages) {
    return null;
  }

  const chrome = describeChrome(item, theme);

  return (
    <View
      style={{
        gap: 6,
        borderRadius: 14,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: chrome.borderColor,
        backgroundColor: chrome.backgroundColor,
        paddingHorizontal: 14,
        paddingVertical: 12,
      }}
    >
      <Text
        selectable
        style={{
          color: chrome.toneColor,
          fontSize: 11,
          fontWeight: "600",
          letterSpacing: 0.4,
          textTransform: "uppercase",
        }}
      >
        {chrome.label}
      </Text>
      <Text
        selectable
        style={{
          color: theme.textSecondary,
          fontSize: 13,
          lineHeight: 19,
          fontFamily: item.kind === "system" ? theme.fontFamilyMono : theme.fontFamilySans,
        }}
      >
        {chrome.body}
      </Text>
    </View>
  );
}

function describeChrome(
  item: Extract<SessionFeedItem, { kind: "log" | "error" | "system" }>,
  theme: ReturnType<typeof useAppTheme>,
) {
  switch (item.kind) {
    case "log":
      return {
        label: "Log",
        toneColor: theme.textSecondary,
        backgroundColor: theme.surface,
        borderColor: theme.border,
        body: item.line,
      };
    case "error":
      return {
        label: "Error",
        toneColor: theme.danger,
        backgroundColor: theme.dangerMuted,
        borderColor: theme.danger,
        body: item.message,
      };
    case "system":
      return {
        label: "System",
        toneColor: theme.textSecondary,
        backgroundColor: theme.surfaceMuted,
        borderColor: theme.borderMuted,
        body: item.line,
      };
  }
}
