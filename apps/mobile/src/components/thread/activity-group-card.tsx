import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import type { ActivityFeedItem, ActivityGroupSummary } from "@/features/cowork/activityGroups";
import {
  activityTimestampMs,
  firstActivityTimestampMs,
  formatActivityElapsedMs,
  parseReasoningSections,
  summarizeActivityGroup,
} from "@/features/cowork/activityGroups";
import { formatToolCard } from "@/features/cowork/toolCardFormatting";
import type { ToolFeedState } from "@/features/cowork/toolFeedState";
import { useAppTheme } from "@/theme/use-app-theme";
import { SFSymbol } from "../ui/sf-symbol";
import { MarkdownText } from "./markdown-text";

type ActivityGroupCardProps = {
  items: ActivityFeedItem[];
  live?: boolean;
  liveStartedAt?: string | null;
};

function toolIconName(title: string): string {
  const t = title.toLowerCase();
  if (t.includes("todo") || t.includes("task")) return "checklist";
  if (t.includes("search") || t.includes("grep") || t.includes("glob")) return "magnifyingglass";
  if (t.includes("fetch") || t.includes("web") || t.includes("browser")) return "globe";
  if (t.includes("bash") || t.includes("shell") || t.includes("run")) return "terminal";
  return "wrench.and.screwdriver";
}

function TimelineNode({
  iconName,
  isLast,
  children,
}: {
  iconName: string;
  isLast: boolean;
  children: ReactNode;
}) {
  const theme = useAppTheme();

  return (
    <View style={{ flexDirection: "row", gap: 10 }}>
      <View style={{ alignItems: "center", width: 18 }}>
        <View style={{ marginTop: 2 }}>
          <SFSymbol name={iconName} size={14} color={theme.textTertiary} />
        </View>
        {!isLast ? (
          <View
            style={{
              marginTop: 4,
              width: 1,
              flex: 1,
              minHeight: 12,
              backgroundColor: theme.borderMuted,
            }}
          />
        ) : null}
      </View>
      <View style={{ flex: 1, minWidth: 0, paddingBottom: isLast ? 0 : 12 }}>{children}</View>
    </View>
  );
}

function ReasoningSectionNode({
  title,
  body,
  isMostRecent,
}: {
  title: string;
  body: string;
  isMostRecent: boolean;
}) {
  const theme = useAppTheme();
  const [open, setOpen] = useState(isMostRecent);

  useEffect(() => {
    setOpen(isMostRecent);
  }, [isMostRecent]);

  if (!title) {
    return <MarkdownText text={body} color={theme.textSecondary} variant="reasoning" />;
  }

  return (
    <View style={{ gap: 6, paddingBottom: 10 }}>
      <Pressable
        onPress={() => setOpen(!open)}
        style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
      >
        <Text
          selectable
          style={{
            flex: 1,
            color: theme.text,
            fontSize: 14,
            fontWeight: "600",
            lineHeight: 20,
          }}
        >
          {title}
        </Text>
        <SFSymbol
          name="chevron.right"
          size={12}
          color={theme.textTertiary}
          style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}
        />
      </Pressable>
      {open && body ? (
        <MarkdownText text={body} color={theme.textSecondary} variant="reasoning" />
      ) : null}
    </View>
  );
}

function ReasoningTimelineNode({
  text,
  isLast,
  live,
  isMostRecent,
}: {
  text: string;
  isLast: boolean;
  live?: boolean;
  isMostRecent: boolean;
}) {
  const theme = useAppTheme();
  const reasoningText = text.trim();
  const sections = useMemo(() => parseReasoningSections(reasoningText), [reasoningText]);

  if (!reasoningText) {
    return (
      <TimelineNode iconName="clock" isLast={isLast}>
        <Text
          style={{
            color: theme.textSecondary,
            fontSize: 14,
            fontStyle: "italic",
            lineHeight: 20,
          }}
        >
          Thinking
        </Text>
      </TimelineNode>
    );
  }

  return (
    <TimelineNode iconName="clock" isLast={isLast}>
      <View style={{ gap: 4 }}>
        {sections.map((section, idx) => {
          const isSectionMostRecent = live ? isMostRecent && idx === sections.length - 1 : true;
          return (
            <ReasoningSectionNode
              key={`${section.title || "reasoning"}-${section.body.slice(0, 32)}`}
              title={section.title}
              body={section.body}
              isMostRecent={isSectionMostRecent}
            />
          );
        })}
      </View>
    </TimelineNode>
  );
}

function ToolStateIndicator({ state }: { state: ToolFeedState }) {
  const theme = useAppTheme();

  if (state === "output-available") return null;
  if (state === "output-error" || state === "output-denied") {
    return <SFSymbol name="xmark.circle.fill" size={12} color={theme.danger} />;
  }
  if (state === "approval-requested") {
    return (
      <View
        style={{
          borderRadius: 999,
          backgroundColor: theme.dangerMuted,
          paddingHorizontal: 6,
          paddingVertical: 2,
        }}
      >
        <Text style={{ color: theme.danger, fontSize: 10, fontWeight: "700" }}>Review</Text>
      </View>
    );
  }
  return <SFSymbol name="clock" size={12} color={theme.primary} />;
}

function ActivityTimeline({ summary, live }: { summary: ActivityGroupSummary; live?: boolean }) {
  const theme = useAppTheme();

  const lastReasoningEntryId = useMemo(() => {
    const reasoningEntries = summary.entries.filter((entry) => entry.kind === "reasoning");
    if (reasoningEntries.length === 0) return null;
    return reasoningEntries[reasoningEntries.length - 1]?.item.id ?? null;
  }, [summary.entries]);

  return (
    <ScrollView style={{ maxHeight: 420 }} nestedScrollEnabled showsVerticalScrollIndicator={false}>
      {summary.entries.map((entry, index) => {
        const isLast = index === summary.entries.length - 1;

        if (entry.kind === "reasoning") {
          const isMostRecent = entry.item.id === lastReasoningEntryId;
          return (
            <ReasoningTimelineNode
              key={entry.item.id}
              text={entry.item.text}
              isLast={isLast}
              live={live}
              isMostRecent={isMostRecent}
            />
          );
        }

        const formatting = formatToolCard(
          entry.item.name,
          entry.item.args,
          entry.item.result,
          entry.item.state,
        );

        return (
          <TimelineNode
            key={entry.item.id}
            iconName={toolIconName(formatting.title)}
            isLast={isLast}
          >
            <View style={{ gap: 2, paddingTop: 1 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Text
                  selectable
                  style={{
                    color: theme.text,
                    fontSize: 14,
                    fontWeight: "600",
                    lineHeight: 20,
                  }}
                >
                  {formatting.title}
                </Text>
                <ToolStateIndicator state={entry.item.state} />
              </View>
              {formatting.subtitle ? (
                <Text
                  selectable
                  style={{
                    color: theme.textTertiary,
                    fontSize: 12,
                    lineHeight: 17,
                  }}
                >
                  {formatting.subtitle}
                </Text>
              ) : null}
            </View>
          </TimelineNode>
        );
      })}
    </ScrollView>
  );
}

export function ActivityGroupCard({ items, live, liveStartedAt }: ActivityGroupCardProps) {
  const theme = useAppTheme();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const summary = useMemo(() => summarizeActivityGroup(items), [items]);
  const displayStatus = live && summary.status === "done" ? "running" : summary.status;
  const isComplete = displayStatus === "done";
  const liveStartedAtMs =
    liveStartedAt !== null && liveStartedAt !== undefined
      ? activityTimestampMs(liveStartedAt)
      : null;
  const liveElapsedLabel =
    live === true
      ? formatActivityElapsedMs(
          nowMs - (liveStartedAtMs ?? firstActivityTimestampMs(items) ?? nowMs),
        )
      : null;
  const displayElapsedLabel = liveElapsedLabel ?? summary.elapsedLabel;
  const shouldAutoExpand =
    displayStatus === "approval" || displayStatus === "issue" || displayStatus === "running";
  const [expanded, setExpanded] = useState(shouldAutoExpand);

  useEffect(() => {
    if (!live) return;
    setNowMs(Date.now());
    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [live]);

  useEffect(() => {
    if (shouldAutoExpand) {
      setExpanded(true);
    } else if (isComplete) {
      setExpanded(false);
    }
  }, [shouldAutoExpand, isComplete]);

  const showStateBadge = displayStatus === "approval" || displayStatus === "issue";
  const isPendingReasoning = displayStatus === "running" && summary.preview === "Thinking...";
  const useCompactElapsedHeader = isComplete || (live === true && !showStateBadge);

  const elapsedHeaderLabel = live
    ? displayElapsedLabel
      ? `Working for ${displayElapsedLabel}`
      : "Working"
    : displayElapsedLabel
      ? `Worked for ${displayElapsedLabel}`
      : "Worked";

  if (useCompactElapsedHeader) {
    return (
      <View style={{ gap: 8, maxWidth: "100%" }}>
        <Pressable
          onPress={() => setExpanded(!expanded)}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            paddingVertical: 6,
            borderBottomWidth: expanded ? 1 : 0,
            borderBottomColor: theme.borderMuted,
          }}
        >
          <Text
            selectable
            style={{
              color: theme.textSecondary,
              fontSize: 13,
              fontFamily: theme.fontFamilyMono,
              letterSpacing: -0.2,
            }}
          >
            {elapsedHeaderLabel}
          </Text>
          <SFSymbol
            name="chevron.right"
            size={12}
            color={theme.textTertiary}
            style={{ transform: [{ rotate: expanded ? "90deg" : "0deg" }] }}
          />
        </Pressable>
        {expanded ? (
          <View style={{ paddingTop: 4, paddingBottom: 8 }}>
            <ActivityTimeline summary={summary} live={live} />
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <View
      style={{
        gap: 0,
        maxWidth: "100%",
        borderRadius: 16,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: theme.borderMuted,
        backgroundColor: theme.surfaceMuted,
        overflow: "hidden",
      }}
    >
      <Pressable
        onPress={() => setExpanded(!expanded)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          paddingHorizontal: 12,
          paddingVertical: 10,
        }}
      >
        <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 }}>
          <SFSymbol
            name="clock"
            size={16}
            color={isPendingReasoning ? theme.primary : theme.textTertiary}
          />
          <Text
            selectable
            numberOfLines={1}
            style={{
              flex: 1,
              color: isPendingReasoning ? theme.textSecondary : theme.textSecondary,
              fontSize: 14,
              fontStyle: "italic",
              lineHeight: 20,
            }}
          >
            {isPendingReasoning ? "Thinking" : summary.preview}
          </Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {showStateBadge ? (
            <View
              style={{
                borderRadius: 999,
                backgroundColor: theme.dangerMuted,
                paddingHorizontal: 8,
                paddingVertical: 3,
              }}
            >
              <Text style={{ color: theme.danger, fontSize: 10, fontWeight: "700" }}>
                {summary.statusLabel}
              </Text>
            </View>
          ) : null}
          <SFSymbol
            name="chevron.down"
            size={12}
            color={theme.textTertiary}
            style={{ transform: [{ rotate: expanded ? "180deg" : "0deg" }] }}
          />
        </View>
      </Pressable>
      {expanded ? (
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: theme.borderMuted,
            paddingHorizontal: 12,
            paddingTop: 10,
            paddingBottom: 12,
          }}
        >
          <ActivityTimeline summary={summary} live={live} />
        </View>
      ) : null}
    </View>
  );
}
