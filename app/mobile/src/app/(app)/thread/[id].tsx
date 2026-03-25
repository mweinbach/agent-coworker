import { useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { ComposerBar } from "../../../components/ComposerBar";
import { useThreadStore, type MobileThreadFeedEntry } from "../../../features/cowork/threadStore";

export default function ThreadDetailScreen() {
  const params = useLocalSearchParams<{ id?: string }>();
  const threadId = typeof params.id === "string" ? params.id : "";
  const thread = useThreadStore((state) => state.getThread(threadId));
  const setComposerDraft = useThreadStore((state) => state.setComposerDraft);
  const submitComposer = useThreadStore((state) => state.submitComposer);
  const interruptThread = useThreadStore((state) => state.interruptThread);

  if (!thread) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.emptyState}>
          <Text style={styles.title}>Thread not found</Text>
          <Text style={styles.subtitle}>Return to the threads tab and choose another conversation.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.title}>{thread.title}</Text>
            <Text style={styles.subtitle}>Rendered directly from the shared `coworkSnapshot.feed` contract.</Text>
          </View>
          <Pressable onPress={() => interruptThread(thread.id)} style={styles.interruptButton}>
            <Text style={styles.interruptLabel}>Interrupt</Text>
          </Pressable>
        </View>

        <ScrollView
          style={styles.feedScroll}
          contentContainerStyle={styles.feedContent}
          keyboardShouldPersistTaps="handled"
        >
          {thread.feed.map((item: MobileThreadFeedEntry) => (
            <View key={item.id} style={styles.feedItem}>
              <Text style={styles.feedItemKind}>{item.kind.toUpperCase()}</Text>
              <Text style={styles.feedItemTitle}>{describeFeedItemTitle(item)}</Text>
              <Text style={styles.feedItemBody}>{describeFeedItemBody(item)}</Text>
            </View>
          ))}
        </ScrollView>

        <ComposerBar
          value={thread.composerDraft}
          onChangeText={(text) => setComposerDraft(thread.id, text)}
          onSubmit={() => {
            submitComposer(thread.id);
          }}
        />
      </View>
    </SafeAreaView>
  );
}

function describeFeedItemTitle(item: MobileThreadFeedEntry): string {
  switch (item.kind) {
    case "message":
      return item.role === "assistant" ? "Assistant" : "You";
    case "reasoning":
      return item.mode === "summary" ? "Summary" : "Reasoning";
    case "tool":
      return item.name;
    case "todos":
      return "Todos";
    case "log":
      return "Log";
    case "error":
      return "Error";
    case "system":
      return "System";
  }
}

function describeFeedItemBody(item: MobileThreadFeedEntry): string {
  switch (item.kind) {
    case "message":
      return item.text;
    case "reasoning":
      return item.text;
    case "tool":
      return item.state;
    case "todos":
      return item.todos.map((todo) => `${todo.status}: ${todo.content}`).join("\n");
    case "log":
      return item.line;
    case "error":
      return item.message;
    case "system":
      return item.line;
  }
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#0b1020",
  },
  container: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
    gap: 16,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  headerText: {
    flex: 1,
    gap: 6,
  },
  title: {
    color: "#f8fafc",
    fontSize: 26,
    fontWeight: "800",
  },
  subtitle: {
    color: "#94a3b8",
    fontSize: 14,
    lineHeight: 20,
  },
  interruptButton: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#ef4444",
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  interruptLabel: {
    color: "#fca5a5",
    fontWeight: "700",
  },
  feedScroll: {
    flex: 1,
  },
  feedContent: {
    gap: 12,
    paddingBottom: 12,
  },
  feedItem: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#1e293b",
    backgroundColor: "#111827",
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 8,
  },
  feedItemKind: {
    color: "#38bdf8",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1.2,
  },
  feedItemTitle: {
    color: "#f8fafc",
    fontSize: 16,
    fontWeight: "700",
  },
  feedItemBody: {
    color: "#cbd5e1",
    fontSize: 14,
    lineHeight: 21,
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 24,
  },
});
