import { Text, View } from "react-native";

import type { SessionFeedItem } from "@/features/cowork/protocolTypes";
import { useAppTheme } from "@/theme/use-app-theme";
import { MarkdownText } from "./markdown-text";
import { ToolCallCard } from "./tool-call-card";
import { ReasoningCard } from "./reasoning-card";
import { TodoCard } from "./todo-card";
import { A2uiSurfaceCard } from "./a2ui-surface-card";

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
        {isAssistant ? (
          <MarkdownText text={item.text} color={theme.text} />
        ) : (
          <Text
            selectable
            style={{
              color: theme.primaryText,
              fontSize: 15,
              lineHeight: 22,
            }}
          >
            {item.text}
          </Text>
        )}
      </View>
    );
  }

  if (item.kind === "reasoning") {
    return <ReasoningCard mode={item.mode} text={item.text} />;
  }

  if (item.kind === "tool") {
    return (
      <ToolCallCard
        name={item.name}
        state={item.state}
        args={item.args}
        result={item.result}
        approval={item.approval}
      />
    );
  }

  if (item.kind === "todos") {
    return <TodoCard todos={item.todos} />;
  }

  if (item.kind === "ui_surface") {
    return <A2uiSurfaceCard item={item} />;
  }

  // log, error, system — simple chrome rendering
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
