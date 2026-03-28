import { Link, Stack, useRouter } from "expo-router";
import { Fragment, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { Screen } from "@/components/ui/screen";
import { SectionCard } from "@/components/ui/section-card";
import { SFSymbol } from "@/components/ui/sf-symbol";
import { StatusPill } from "@/components/ui/status-pill";
import { useThreadStore } from "@/features/cowork/threadStore";
import { useWorkspaceStore } from "@/features/cowork/workspaceStore";
import { useAppTheme } from "@/theme/use-app-theme";

export default function ThreadsScreen() {
  const theme = useAppTheme();
  const threads = useThreadStore((state) => state.threads);
  const activeWorkspaceName = useWorkspaceStore((state) => state.activeWorkspaceName);
  const [searchQuery, setSearchQuery] = useState("");

  const filteredThreads = threads.filter((thread) => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return true;
    }
    return (
      thread.title.toLowerCase().includes(query)
      || thread.preview.toLowerCase().includes(query)
    );
  });

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
        }}
      />
      <Screen scroll contentStyle={{ gap: 16 }}>
        <SectionCard
          title="Recent threads"
          description={
            filteredThreads.length === 0
              ? searchQuery
                ? "No thread matches the current search."
                : "Open or resume a thread on desktop and it will appear here."
              : `${filteredThreads.length} available on mobile`
          }
        >
          {filteredThreads.length === 0 ? (
            <Text selectable style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>
              {searchQuery
                ? "Try a different query or cancel the search from the header."
                : "This phone stays focused on live desktop threads, so the list populates as soon as your paired workspace publishes them."}
            </Text>
          ) : (
            filteredThreads.map((thread) => (
              <Link key={thread.id} href={`/(app)/thread/${thread.id}` as const} asChild>
                <Pressable
                  style={({ pressed }) => ({
                    gap: 10,
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
                      <Text selectable style={{ color: theme.text, fontSize: 16, fontWeight: "700" }}>
                        {thread.title}
                      </Text>
                      <Text
                        numberOfLines={2}
                        selectable
                        style={{
                          color: theme.textSecondary,
                          fontSize: 14,
                          lineHeight: 20,
                        }}
                      >
                        {thread.preview}
                      </Text>
                    </View>
                    {thread.pendingPrompt ? (
                      <StatusPill label="needs reply" tone="warning" />
                    ) : null}
                  </View>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
                    <Text
                      selectable
                      style={{
                        color: theme.textTertiary,
                        fontSize: 12,
                        fontVariant: ["tabular-nums"],
                      }}
                    >
                      {thread.updatedAtLabel}
                    </Text>
                    <Text
                      selectable
                      style={{
                        color: theme.textTertiary,
                        fontSize: 12,
                        fontVariant: ["tabular-nums"],
                      }}
                    >
                      {thread.feed.length > 0 ? "hydrated" : "tap to load"}
                    </Text>
                  </View>
                </Pressable>
              </Link>
            ))
          )}
        </SectionCard>
      </Screen>
    </Fragment>
  );
}
