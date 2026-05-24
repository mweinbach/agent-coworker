import { Link, Stack, useRouter } from "expo-router";
import { Fragment, useEffect, useMemo, useState } from "react";
import {
  LayoutAnimation,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  UIManager,
  View,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { HeaderGlassButton, HeaderGlassMenu } from "@/components/ui/header-glass-button";
import { Screen } from "@/components/ui/screen";
import { SFSymbol } from "@/components/ui/sf-symbol";
import { useThreadStore, type MobileThreadSummary } from "@/features/cowork/threadStore";
import { useWorkspaceStore } from "@/features/cowork/workspaceStore";
import { useAppTheme } from "@/theme/use-app-theme";

if (Platform.OS === "android") {
  UIManager.setLayoutAnimationEnabledExperimental?.(true);
}

const SETTINGS_ACTIONS = [
  { title: "Settings", icon: "slider.horizontal.3", href: "/(app)/settings" },
  { title: "Workspace", icon: "square.grid.2x2", href: "/(app)/(tabs)/workspace" },
  { title: "Skills", icon: "sparkles", href: "/(app)/(tabs)/skills" },
  { title: "Remote access", icon: "iphone.and.arrow.forward", href: "/(pairing)" },
] as const;

const COLLAPSED_PROJECT_LIMIT = 5;

function formatRelative(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return "now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  const years = Math.floor(days / 365);
  return `${years}y`;
}

function SectionHeader({ children }: { children: string }) {
  const theme = useAppTheme();
  return (
    <Text
      style={{
        color: theme.textTertiary,
        fontSize: 12,
        fontWeight: "700",
        letterSpacing: 0.8,
        textTransform: "uppercase",
        paddingHorizontal: 20,
        paddingTop: 20,
        paddingBottom: 6,
      }}
    >
      {children}
    </Text>
  );
}

function ChatRow({
  thread,
  isLast,
  onPress,
}: {
  thread: MobileThreadSummary;
  isLast: boolean;
  onPress: () => void;
}) {
  const theme = useAppTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingHorizontal: 20,
        paddingVertical: 14,
        borderBottomWidth: isLast ? 0 : StyleSheet.hairlineWidth,
        borderBottomColor: theme.borderMuted,
        backgroundColor: pressed ? theme.surfaceMuted : "transparent",
      })}
    >
      <SFSymbol name="bubble.left.fill" size={18} color={theme.textSecondary} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text
          numberOfLines={1}
          style={{ color: theme.text, fontSize: 16, fontWeight: "600" }}
        >
          {thread.title}
        </Text>
        {thread.preview && thread.preview !== "No activity yet." ? (
          <Text
            numberOfLines={1}
            style={{ color: theme.textTertiary, fontSize: 13 }}
          >
            {thread.preview}
          </Text>
        ) : null}
      </View>
      <Text
        style={{
          color: theme.textTertiary,
          fontSize: 12,
          fontVariant: ["tabular-nums"],
        }}
      >
        {formatRelative(thread.updatedAt)}
      </Text>
      {thread.pendingPrompt ? (
        <View style={{ width: 8, height: 8, borderRadius: 999, backgroundColor: theme.primary }} />
      ) : null}
    </Pressable>
  );
}

function Chevron({ expanded }: { expanded: boolean }) {
  const rotation = useSharedValue(expanded ? 90 : 0);
  useEffect(() => {
    rotation.value = withTiming(expanded ? 90 : 0, { duration: 180 });
  }, [expanded, rotation]);
  const style = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));
  const theme = useAppTheme();
  return (
    <Animated.View style={[{ width: 14, alignItems: "center" }, style]}>
      <SFSymbol name="chevron.right" size={11} color={theme.textTertiary} />
    </Animated.View>
  );
}

function ProjectHeader({
  name,
  count,
  expanded,
  onToggle,
}: {
  name: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const theme = useAppTheme();
  return (
    <Pressable
      onPress={onToggle}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingHorizontal: 20,
        paddingVertical: 12,
        backgroundColor: pressed ? theme.surfaceMuted : "transparent",
      })}
    >
      <Chevron expanded={expanded} />
      <SFSymbol
        name={expanded ? "folder.fill" : "folder"}
        size={17}
        color={theme.primary}
      />
      <Text
        numberOfLines={1}
        style={{ color: theme.text, fontSize: 16, fontWeight: "600", flex: 1 }}
      >
        {name}
      </Text>
      <Text
        style={{
          color: theme.textTertiary,
          fontSize: 13,
          fontVariant: ["tabular-nums"],
        }}
      >
        {count}
      </Text>
    </Pressable>
  );
}

function ProjectChildRow({
  thread,
  onPress,
}: {
  thread: MobileThreadSummary;
  onPress: () => void;
}) {
  const theme = useAppTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingLeft: 44,
        paddingRight: 20,
        paddingVertical: 9,
        backgroundColor: pressed ? theme.surfaceMuted : "transparent",
      })}
    >
      <View
        style={{
          position: "absolute",
          left: 33,
          top: 0,
          bottom: 0,
          width: StyleSheet.hairlineWidth,
          backgroundColor: theme.borderMuted,
        }}
      />
      <Text
        numberOfLines={1}
        style={{ color: theme.text, fontSize: 14, fontWeight: "500", flex: 1 }}
      >
        {thread.title}
      </Text>
      <Text
        style={{
          color: theme.textTertiary,
          fontSize: 12,
          fontVariant: ["tabular-nums"],
        }}
      >
        {formatRelative(thread.updatedAt)}
      </Text>
      {thread.pendingPrompt ? (
        <View style={{ width: 6, height: 6, borderRadius: 999, backgroundColor: theme.primary }} />
      ) : null}
    </Pressable>
  );
}

function ShowMoreRow({ count, onPress }: { count: number; onPress: () => void }) {
  const theme = useAppTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingLeft: 44,
        paddingRight: 20,
        paddingVertical: 10,
        backgroundColor: pressed ? theme.surfaceMuted : "transparent",
      })}
    >
      <View
        style={{
          position: "absolute",
          left: 33,
          top: 0,
          bottom: 0,
          width: StyleSheet.hairlineWidth,
          backgroundColor: theme.borderMuted,
        }}
      />
      <Text style={{ color: theme.primary, fontSize: 13, fontWeight: "600" }}>
        Show {count} more
      </Text>
    </Pressable>
  );
}

export default function ThreadsScreen() {
  const theme = useAppTheme();
  const router = useRouter();
  const threads = useThreadStore((state) => state.threads);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const expandedWorkspaceIds = useThreadStore((state) => state.expandedWorkspaceIds);
  const expandWorkspace = useThreadStore((state) => state.expandWorkspace);
  const toggleWorkspaceExpanded = useThreadStore((state) => state.toggleWorkspaceExpanded);
  const [searchQuery, setSearchQuery] = useState("");
  const [showAllProjects, setShowAllProjects] = useState<Set<string>>(new Set());

  const filteredThreads = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return threads;
    return threads.filter(
      (thread) =>
        thread.title.toLowerCase().includes(query) ||
        thread.preview.toLowerCase().includes(query),
    );
  }, [threads, searchQuery]);

  const { chats, projects } = useMemo(() => {
    const chatList = filteredThreads.filter((thread) => thread.workspaceKind === "oneOffChat");
    const projectWorkspaces = workspaces.filter(
      (workspace) => workspace.workspaceKind !== "oneOffChat",
    );
    const threadsByWorkspaceId = new Map<string, MobileThreadSummary[]>();
    for (const thread of filteredThreads) {
      if (thread.workspaceKind === "oneOffChat" || !thread.workspaceId) {
        continue;
      }
      const bucket = threadsByWorkspaceId.get(thread.workspaceId);
      if (bucket) {
        bucket.push(thread);
      } else {
        threadsByWorkspaceId.set(thread.workspaceId, [thread]);
      }
    }

    const byUpdated = (a: MobileThreadSummary, b: MobileThreadSummary) => {
      const at = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const bt = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      return bt - at;
    };
    chatList.sort(byUpdated);

    const projectGroups = projectWorkspaces
      .map((workspace) => ({
        workspace,
        items: [...(threadsByWorkspaceId.get(workspace.id) ?? [])].sort(byUpdated),
      }))
      .sort((left, right) => left.workspace.name.localeCompare(right.workspace.name));

    return {
      chats: chatList,
      projects: projectGroups,
    };
  }, [filteredThreads, workspaces]);

  function toggleProject(workspaceId: string) {
    LayoutAnimation.configureNext({
      duration: 180,
      create: { type: "easeInEaseOut", property: "opacity" },
      update: { type: "easeInEaseOut" },
      delete: { type: "easeInEaseOut", property: "opacity" },
    });
    toggleWorkspaceExpanded(workspaceId);
  }

  function toggleShowAll(name: string) {
    LayoutAnimation.configureNext({
      duration: 180,
      create: { type: "easeInEaseOut", property: "opacity" },
      update: { type: "easeInEaseOut" },
      delete: { type: "easeInEaseOut", property: "opacity" },
    });
    setShowAllProjects((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  return (
    <Fragment>
      <Stack.Screen
        options={{
          title: "Cowork",
          headerSearchBarOptions: {
            placeholder: "Search",
            hideWhenScrolling: false,
            onChangeText: (event) => setSearchQuery(event.nativeEvent.text),
            onCancelButtonPress: () => setSearchQuery(""),
          },
          headerLeft: () => (
            <>
              {Platform.OS === "ios" ? (
                <HeaderGlassMenu
                  icon="ellipsis"
                  actions={SETTINGS_ACTIONS.map((action) => ({
                    title: action.title,
                    icon: action.icon,
                    onPress: () => router.push(action.href),
                  }))}
                />
              ) : (
                <Link href="/(app)/(tabs)/threads" asChild>
                  <Link.Trigger>
                    <HeaderGlassButton icon="ellipsis" accessibilityLabel="Open menu" />
                  </Link.Trigger>
                  <Link.Menu>
                    {SETTINGS_ACTIONS.map((action) => (
                      <Link.MenuAction
                        key={action.title}
                        title={action.title}
                        icon={action.icon}
                        onPress={() => router.push(action.href)}
                      />
                    ))}
                  </Link.Menu>
                </Link>
              )}
            </>
          ),
        }}
      />
      <Screen scroll contentStyle={{ paddingHorizontal: 0, paddingTop: 0, gap: 0 }}>
        {chats.length === 0 && projects.length === 0 ? (
          <Text
            style={{
              color: theme.textSecondary,
              fontSize: 14,
              lineHeight: 21,
              padding: 32,
              textAlign: "center",
            }}
          >
            {searchQuery
              ? "No thread matches the current search."
              : "Threads will appear here when you start a conversation."}
          </Text>
        ) : null}

        {chats.length > 0 ? (
          <View>
            <SectionHeader>Chats</SectionHeader>
            {chats.map((thread, idx) => (
              <ChatRow
                key={thread.id}
                thread={thread}
                isLast={idx === chats.length - 1}
                onPress={() => router.push(`/(app)/thread/${thread.id}` as const)}
              />
            ))}
          </View>
        ) : null}

        {projects.length > 0 ? (
          <View style={{ paddingBottom: 24 }}>
            <SectionHeader>Projects</SectionHeader>
            {projects.map(({ workspace, items }) => {
              const expanded = expandedWorkspaceIds[workspace.id] === true;
              const showAll = showAllProjects.has(workspace.id);
              const visible = expanded
                ? showAll
                  ? items
                  : items.slice(0, COLLAPSED_PROJECT_LIMIT)
                : [];
              const hidden = items.length - visible.length;
              return (
                <Fragment key={workspace.id}>
                  <ProjectHeader
                    name={workspace.name}
                    count={items.length}
                    expanded={expanded}
                    onToggle={() => toggleProject(workspace.id)}
                  />
                  {expanded ? (
                    <View>
                      {visible.map((thread) => (
                        <ProjectChildRow
                          key={thread.id}
                          thread={thread}
                          onPress={() => {
                            expandWorkspace(workspace.id);
                            router.push(`/(app)/thread/${thread.id}` as const);
                          }}
                        />
                      ))}
                      {hidden > 0 ? (
                        <ShowMoreRow count={hidden} onPress={() => toggleShowAll(workspace.id)} />
                      ) : null}
                    </View>
                  ) : null}
                </Fragment>
              );
            })}
          </View>
        ) : null}
      </Screen>
    </Fragment>
  );
}
