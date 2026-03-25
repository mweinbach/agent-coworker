import { useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useState } from "react";

import { ComposerBar } from "../../../components/ComposerBar";
import { useThreadStore, type MobileThreadFeedEntry } from "../../../features/cowork/threadStore";
import { getActiveCoworkJsonRpcClient } from "../../../features/cowork/runtimeClient";

export default function ThreadDetailScreen() {
  const params = useLocalSearchParams<{ id?: string }>();
  const threadId = typeof params.id === "string" ? params.id : "";
  const thread = useThreadStore((state) => state.getThread(threadId));
  const pendingRequest = useThreadStore((state) => state.getPendingRequest(threadId));
  const setComposerDraft = useThreadStore((state) => state.setComposerDraft);
  const submitComposer = useThreadStore((state) => state.submitComposer);
  const interruptThread = useThreadStore((state) => state.interruptThread);
  const clearPendingRequest = useThreadStore((state) => state.clearPendingRequest);
  const [askDraft, setAskDraft] = useState("");
  const runtimeClient = getActiveCoworkJsonRpcClient();

  const isDraftThread = threadId.startsWith("draft-");

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
          <Pressable
            onPress={async () => {
              if (runtimeClient && !isDraftThread) {
                await runtimeClient.interruptTurn(thread.id);
                const reread = await runtimeClient.readThread(thread.id);
                if (reread.coworkSnapshot) {
                  useThreadStore.getState().hydrate(reread.coworkSnapshot);
                }
                return;
              }
              interruptThread(thread.id);
            }}
            style={styles.interruptButton}
          >
            <Text style={styles.interruptLabel}>Interrupt</Text>
          </Pressable>
        </View>

        <ScrollView
          style={styles.feedScroll}
          contentContainerStyle={styles.feedContent}
          keyboardShouldPersistTaps="handled"
        >
          {pendingRequest ? (
            <View style={styles.pendingCard}>
              <Text style={styles.pendingTitle}>
                {pendingRequest.kind === "approval" ? "Approval needed" : "Question from desktop"}
              </Text>
              <Text style={styles.pendingBody}>
                {pendingRequest.kind === "approval"
                  ? `${pendingRequest.command}\n${pendingRequest.reason}`
                  : pendingRequest.question}
              </Text>
              {pendingRequest.kind === "ask" ? (
                <>
                  <TextInput
                    value={askDraft}
                    onChangeText={setAskDraft}
                    placeholder="Type a response…"
                    placeholderTextColor="#64748b"
                    style={styles.pendingInput}
                  />
                  <View style={styles.pendingActions}>
                    {pendingRequest.options?.map((option: string) => (
                      <Pressable
                        key={option}
                        onPress={async () => {
                          const client = getActiveCoworkJsonRpcClient();
                          if (!client) return;
                          await client.respondServerRequest(pendingRequest.requestId, { answer: option });
                          clearPendingRequest(thread.id);
                        }}
                        style={styles.pendingSecondaryButton}
                      >
                        <Text style={styles.pendingSecondaryLabel}>{option}</Text>
                      </Pressable>
                    ))}
                    <Pressable
                      onPress={async () => {
                        const client = getActiveCoworkJsonRpcClient();
                        if (!client) return;
                        await client.respondServerRequest(pendingRequest.requestId, { answer: askDraft || "ok" });
                        clearPendingRequest(thread.id);
                        setAskDraft("");
                      }}
                      style={styles.pendingPrimaryButton}
                    >
                      <Text style={styles.pendingPrimaryLabel}>Send answer</Text>
                    </Pressable>
                  </View>
                </>
              ) : (
                <View style={styles.pendingActions}>
                  <Pressable
                    onPress={async () => {
                      const client = getActiveCoworkJsonRpcClient();
                      if (!client) return;
                      await client.respondServerRequest(pendingRequest.requestId, { decision: "accept" });
                      clearPendingRequest(thread.id);
                    }}
                    style={styles.pendingPrimaryButton}
                  >
                    <Text style={styles.pendingPrimaryLabel}>Approve</Text>
                  </Pressable>
                  <Pressable
                    onPress={async () => {
                      const client = getActiveCoworkJsonRpcClient();
                      if (!client) return;
                      await client.respondServerRequest(pendingRequest.requestId, { decision: "reject" });
                      clearPendingRequest(thread.id);
                    }}
                    style={styles.pendingSecondaryButton}
                  >
                    <Text style={styles.pendingSecondaryLabel}>Decline</Text>
                  </Pressable>
                </View>
              )}
            </View>
          ) : null}
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
          onSubmit={async () => {
            if (runtimeClient && !isDraftThread && thread.composerDraft.trim()) {
              const draft = thread.composerDraft;
              setComposerDraft(thread.id, "");
              await runtimeClient.startTurn(thread.id, draft);
              return;
            }
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
  pendingCard: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#7c2d12",
    backgroundColor: "#1c1917",
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 10,
  },
  pendingTitle: {
    color: "#fdba74",
    fontSize: 15,
    fontWeight: "800",
  },
  pendingBody: {
    color: "#fed7aa",
    fontSize: 14,
    lineHeight: 21,
  },
  pendingInput: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#44403c",
    backgroundColor: "#0c0a09",
    color: "#f8fafc",
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  pendingActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  pendingPrimaryButton: {
    borderRadius: 999,
    backgroundColor: "#ea580c",
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  pendingPrimaryLabel: {
    color: "#fff7ed",
    fontWeight: "800",
  },
  pendingSecondaryButton: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#57534e",
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  pendingSecondaryLabel: {
    color: "#e7e5e4",
    fontWeight: "700",
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 24,
  },
});
