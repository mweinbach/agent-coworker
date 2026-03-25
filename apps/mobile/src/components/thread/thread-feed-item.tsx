import { Text, View } from "react-native";

import type { SessionFeedItem } from "@/features/cowork/protocolTypes";
import { useAppTheme } from "@/theme/use-app-theme";

type ThreadFeedItemProps = {
  item: SessionFeedItem;
};

export function ThreadFeedItem({ item }: ThreadFeedItemProps) {
  const theme = useAppTheme();

  if (item.kind === "message") {
    const isAssistant = item.role === "assistant";
    return (
      <View
        style={{
          alignSelf: isAssistant ? "flex-start" : "flex-end",
          maxWidth: "90%",
          gap: 8,
          borderRadius: 24,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: isAssistant ? theme.border : theme.primary,
          backgroundColor: isAssistant ? theme.surface : theme.primary,
          paddingHorizontal: 16,
          paddingVertical: 14,
          boxShadow: theme.shadow,
        }}
      >
        <Text
          selectable
          style={{
            color: isAssistant ? theme.textSecondary : theme.primaryText,
            fontSize: 11,
            fontWeight: "700",
            letterSpacing: 0.6,
            textTransform: "uppercase",
          }}
        >
          {isAssistant ? "Assistant" : "You"}
        </Text>
        <Text
          selectable
          style={{
            color: isAssistant ? theme.text : theme.primaryText,
            fontSize: 15,
            lineHeight: 22,
          }}
        >
          {item.text}
        </Text>
      </View>
    );
  }

  const chrome = describeChrome(item, theme);

  return (
    <View
      style={{
        gap: 8,
        borderRadius: 22,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: chrome.borderColor,
        backgroundColor: chrome.backgroundColor,
        paddingHorizontal: 16,
        paddingVertical: 14,
      }}
    >
      <Text
        selectable
        style={{
          color: chrome.toneColor,
          fontSize: 11,
          fontWeight: "700",
          letterSpacing: 0.6,
          textTransform: "uppercase",
        }}
      >
        {chrome.label}
      </Text>
      <Text
        selectable
        style={{
          color: theme.text,
          fontSize: 14,
          lineHeight: 21,
        }}
      >
        {chrome.body}
      </Text>
    </View>
  );
}

function describeChrome(item: SessionFeedItem, theme: ReturnType<typeof useAppTheme>) {
  switch (item.kind) {
    case "reasoning":
      return {
        label: item.mode === "summary" ? "Summary" : "Reasoning",
        toneColor: theme.accent,
        backgroundColor: theme.surface,
        borderColor: theme.border,
        body: item.text,
      };
    case "tool":
      return {
        label: item.name,
        toneColor: theme.warning,
        backgroundColor: theme.surface,
        borderColor: theme.border,
        body: item.state,
      };
    case "todos":
      return {
        label: "Todos",
        toneColor: theme.success,
        backgroundColor: theme.surface,
        borderColor: theme.border,
        body: item.todos.map((todo) => `${todo.status}: ${todo.content}`).join("\n"),
      };
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
    case "message":
      return {
        label: item.role === "assistant" ? "Assistant" : "You",
        toneColor: theme.text,
        backgroundColor: theme.surface,
        borderColor: theme.border,
        body: item.text,
      };
  }
}
