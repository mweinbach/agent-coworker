import { Link, Stack, useRouter } from "expo-router";
import { Fragment, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";

import { HeaderGlassButton, HeaderGlassMenu } from "@/components/ui/header-glass-button";
import { Screen } from "@/components/ui/screen";
import { SectionCard } from "@/components/ui/section-card";
import { StatusPill } from "@/components/ui/status-pill";
import { useThreadStore, type MobileThreadSummary } from "@/features/cowork/threadStore";
import { useWorkspaceStore } from "@/features/cowork/workspaceStore";
import { useAppTheme } from "@/theme/use-app-theme";

type ThreadGroupMode = "chats" | "projects";

const SETTINGS_ACTIONS = [
  {
    title: "Settings",
    icon: "slider.horizontal.3",
    href: "/(app)/settings",
  },
  {
    title: "Workspace",
    icon: "square.grid.2x2",
    href: "/(app)/(tabs)/workspace",
  },
  {
    title: "Skills",
    icon: "sparkles",
    href: "/(app)/(tabs)/skills",
  },
  {
    title: "Remote access",
    icon: "iphone.and.arrow.forward",
    href: "/(pairing)",
  },
] as const;

function ThreadRow({ thread }: { thread: MobileThreadSummary }) {
  const theme = useAppTheme();
  return (
    <Link href={`/(app)/thread/${thread.id}` as const} asChild>
      <Pressable
        style={({ pressed }) => ({
          gap: 6,
          borderRadius: 22,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: pressed ? theme.primary : theme.borderMuted,
          backgroundColor: pressed ? theme.surfaceMuted : theme.surfaceElevated,
          paddingHorizontal: 16,
          paddingVertical: 15,
        })}
      >
        <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
          <View style={{ flex: 1, gap: 5 }}>
            <Text
              selectable
              style={{ color: theme.text, fontSize: 16, fontWeight: "700" }}
            >
              {thread.title}
            </Text>
            <Text
              numberOfLines={2}
              selectable
              style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 20 }}
            >
              {thread.preview}
            </Text>
          </View>
          {thread.pendingPrompt ? <StatusPill label="needs reply" tone="warning" /> : null}
        </View>
      </Pressable>
    </Link>
  );
}

export default function ThreadsScreen() {
  const theme = useAppTheme();
  const router = useRouter();
  const threads = useThreadStore((state) => state.threads);
  const activeWorkspaceName = useWorkspaceStore((state) => state.activeWorkspaceName);
  const [searchQuery, setSearchQuery] = useState("");
  const [groupMode, setGroupMode] = useState<ThreadGroupMode>("chats");

  const filteredThreads = threads.filter((thread) => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return true;
    }
    return (
      thread.title.toLowerCase().includes(query) || thread.preview.toLowerCase().includes(query)
    );
  });

  const groupedByProject: Array<[string, MobileThreadSummary[]]> = (() => {
    const groups = new Map<string, MobileThreadSummary[]>();
    for (const thread of filteredThreads) {
      const key = thread.projectName ?? "No project";
      const bucket = groups.get(key);
      if (bucket) {
        bucket.push(thread);
      } else {
        groups.set(key, [thread]);
      }
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  })();

  const groupModeIcon = groupMode === "chats" ? "bubble.left.and.bubble.right" : "folder";

  return (
    <Fragment>
      <Stack.Screen
        options={{
          title: activeWorkspaceName ?? "Threads",
          headerSearchBarOptions: {
            placeholder: "Search threads",
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
          headerRight: () => (
            <>
              {Platform.OS === "ios" ? (
                <HeaderGlassMenu
                  icon={groupModeIcon}
                  actions={[
                    {
                      title: "Chats",
                      icon: "bubble.left.and.bubble.right",
                      onPress: () => setGroupMode("chats"),
                    },
                    {
                      title: "Projects",
                      icon: "folder",
                      onPress: () => setGroupMode("projects"),
                    },
                  ]}
                />
              ) : (
                <Link href="/(app)/(tabs)/threads" asChild>
                  <Link.Trigger>
                    <HeaderGlassButton icon={groupModeIcon} accessibilityLabel="Change grouping" />
                  </Link.Trigger>
                  <Link.Menu>
                    <Link.MenuAction
                      title="Chats"
                      icon="bubble.left.and.bubble.right"
                      onPress={() => setGroupMode("chats")}
                    />
                    <Link.MenuAction
                      title="Projects"
                      icon="folder"
                      onPress={() => setGroupMode("projects")}
                    />
                  </Link.Menu>
                </Link>
              )}
            </>
          ),
        }}
      />
      <Screen scroll contentStyle={{ gap: 16 }}>
        {filteredThreads.length === 0 ? (
          <SectionCard title={searchQuery ? "No matches" : "No threads yet"}>
            <Text selectable style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>
              {searchQuery
                ? "No thread matches the current search."
                : "Open or resume a thread on desktop and it will appear here."}
            </Text>
          </SectionCard>
        ) : groupMode === "chats" ? (
          <View style={{ gap: 10 }}>
            {filteredThreads.map((thread) => (
              <ThreadRow key={thread.id} thread={thread} />
            ))}
          </View>
        ) : (
          groupedByProject.map(([projectName, projectThreads]) => (
            <SectionCard key={projectName} title={projectName}>
              {projectThreads.map((thread) => (
                <ThreadRow key={thread.id} thread={thread} />
              ))}
            </SectionCard>
          ))
        )}
      </Screen>
    </Fragment>
  );
}
