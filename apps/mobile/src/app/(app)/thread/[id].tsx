import { Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Pressable, FlatList, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ComposerBar } from "@/components/ComposerBar";
import { PendingRequestCard } from "@/components/thread/pending-request-card";
import { ThreadFeedItem } from "@/components/thread/thread-feed-item";
import { Screen } from "@/components/ui/screen";
import { SFSymbol } from "@/components/ui/sf-symbol";
import { StatusPill } from "@/components/ui/status-pill";
import { FileExplorerDrawer } from "@/components/FileExplorerDrawer";
import { getActiveCoworkJsonRpcClient } from "@/features/cowork/runtimeClient";
import { useThreadStore } from "@/features/cowork/threadStore";
import { useAppTheme } from "@/theme/use-app-theme";

export default function ThreadDetailScreen() {
  const params = useLocalSearchParams<{ id?: string }>();
  const threadId = typeof params.id === "string" ? params.id : "";
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const thread = useThreadStore((state) => state.getThread(threadId));
  const pendingRequest = useThreadStore((state) => state.getPendingRequest(threadId));
  const setComposerDraft = useThreadStore((state) => state.setComposerDraft);
  const submitComposer = useThreadStore((state) => state.submitComposer);
  const interruptThread = useThreadStore((state) => state.interruptThread);
  const clearPendingRequest = useThreadStore((state) => state.clearPendingRequest);
  const [askDraft, setAskDraft] = useState("");
  const [drawerVisible, setDrawerVisible] = useState(false);
  const runtimeClient = getActiveCoworkJsonRpcClient();

  const isDraftThread = threadId.startsWith("draft-");

  if (!thread) {
    return (
      <Screen scroll contentStyle={{ justifyContent: "center" }}>
        <Text selectable style={{ color: theme.text, fontSize: 22, fontWeight: "700" }}>
          Thread not found
        </Text>
        <Text selectable style={{ color: theme.textSecondary, fontSize: 15, lineHeight: 22 }}>
          Return to the thread list and choose another conversation.
        </Text>
      </Screen>
    );
  }

  const activeThread = thread;

  async function interruptCurrentThread() {
    if (runtimeClient && !isDraftThread) {
      await runtimeClient.interruptTurn(activeThread.id);
      const reread = await runtimeClient.readThread(activeThread.id);
      if (reread.coworkSnapshot) {
        useThreadStore.getState().hydrate(reread.coworkSnapshot);
      }
      return;
    }
    interruptThread(activeThread.id);
  }

  async function answerServerRequest(result: unknown) {
    const client = getActiveCoworkJsonRpcClient();
    if (!client || !pendingRequest) {
      return;
    }
    await client.respondServerRequest(pendingRequest.requestId, result);
    clearPendingRequest(activeThread.id);
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: activeThread.title,
          headerRight: () => (
            <View style={{ flexDirection: "row", gap: 16 }}>
              <Pressable onPress={() => setDrawerVisible(true)}>
                <SFSymbol name="folder" size={24} color={theme.text} />
              </Pressable>
              <Pressable onPress={() => {/* open overflow */}}>
                <SFSymbol name="ellipsis" size={24} color={theme.text} />
              </Pressable>
              {pendingRequest ? (
                <Pressable onPress={() => { void interruptCurrentThread(); }}>
                  <Text style={{ color: theme.danger, fontWeight: "700" }}>Stop</Text>
                </Pressable>
              ) : null}
            </View>
          ),
        }}
      />
      <KeyboardAvoidingView
        style={{ flex: 1, backgroundColor: theme.background }}
        behavior={process.env.EXPO_OS === "ios" ? "padding" : undefined}
      >
        <FlatList
          style={{ flex: 1, backgroundColor: theme.background }}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{
            gap: 16,
            paddingHorizontal: 20,
            paddingTop: 12,
            paddingBottom: 28,
          }}
          keyboardShouldPersistTaps="handled"
          inverted
          data={
            // Reversed feed + pending request at the top (visually bottom since it's inverted)
            [
              ...(pendingRequest ? [{ type: "pending", data: pendingRequest }] : []),
              ...[...activeThread.feed].reverse().map(item => ({ type: "feed", data: item }))
            ]
          }
          keyExtractor={(item) => item.type === "pending" ? "pending" : (item.data as any).id}
          ListFooterComponent={() => (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
              <StatusPill label={isDraftThread ? "local draft" : "remote session"} tone={isDraftThread ? "primary" : "success"} />
              {pendingRequest ? <StatusPill label="needs response" tone="warning" /> : null}
            </View>
          )}
          ListEmptyComponent={() => (
            <View
              style={{
                gap: 8,
                borderRadius: 22,
                borderCurve: "continuous",
                borderWidth: 1,
                borderColor: theme.border,
                backgroundColor: theme.surface,
                padding: 16,
              }}
            >
              <Text selectable style={{ color: theme.text, fontSize: 16, fontWeight: "700" }}>
                No messages yet
              </Text>
              <Text selectable style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>
                Start the conversation below and Cowork will stream new items into this feed.
              </Text>
            </View>
          )}
          renderItem={({ item }) => {
            if (item.type === "pending") {
              return (
                <PendingRequestCard
                  request={pendingRequest!}
                  askDraft={askDraft}
                  onChangeAskDraft={setAskDraft}
                  onAnswerOption={(answer) => {
                    void answerServerRequest({ answer });
                  }}
                  onAnswerText={() => {
                    void answerServerRequest({ answer: askDraft || "ok" }).then(() => {
                      setAskDraft("");
                    });
                  }}
                  onApprove={() => {
                    void answerServerRequest({ decision: "accept" });
                  }}
                  onReject={() => {
                    void answerServerRequest({ decision: "reject" });
                  }}
                />
              );
            }
            return <ThreadFeedItem item={item.data as any} />;
          }}
        />

        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: theme.borderMuted,
            backgroundColor: theme.background,
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: Math.max(insets.bottom, 12),
          }}
        >
          <ComposerBar
            value={activeThread.composerDraft}
            onChangeText={(text) => setComposerDraft(activeThread.id, text)}
            onSubmit={async () => {
              if (runtimeClient && !isDraftThread && activeThread.composerDraft.trim()) {
                const draft = activeThread.composerDraft;
                await runtimeClient.startTurn(activeThread.id, draft);
                setComposerDraft(activeThread.id, "");
                return;
              }
              submitComposer(activeThread.id);
            }}
            helperText={isDraftThread
              ? "This draft stays local until you pair with a desktop."
              : "Send follow-ups directly into the live desktop thread."}
            submitLabel={isDraftThread ? "Save draft" : "Send"}
            disabled={!activeThread.composerDraft.trim()}
          />
        </View>
      </KeyboardAvoidingView>

      <FileExplorerDrawer 
        visible={drawerVisible} 
        onClose={() => setDrawerVisible(false)} 
        workspaceName="Cowork" 
      />
    </>
  );
}
