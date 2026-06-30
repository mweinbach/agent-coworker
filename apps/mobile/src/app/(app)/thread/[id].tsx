import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { FlatList, KeyboardAvoidingView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ComposerBar } from "@/components/ComposerBar";
import { PendingRequestCard } from "@/components/thread/pending-request-card";
import { ThreadRenderItem } from "@/components/thread/thread-render-item";
import { Screen } from "@/components/ui/screen";
import { StatusPill } from "@/components/ui/status-pill";
import { buildChatRenderItems, type ChatRenderItem } from "@/features/cowork/activityGroups";
import { filterFeedForDisplay } from "@/features/cowork/feedDisplay";
import { getActiveCoworkJsonRpcClient } from "@/features/cowork/runtimeClient";
import type { PendingServerRequest } from "@/features/cowork/threadStore";
import { useThreadStore } from "@/features/cowork/threadStore";
import { usePairingStore } from "@/features/pairing/pairingStore";
import { useDisplayPreferencesStore } from "@/features/preferences/displayPreferencesStore";
import { useAppTheme } from "@/theme/use-app-theme";

type ThreadDetailListItem =
  | {
      type: "pending";
      data: PendingServerRequest;
    }
  | {
      type: "render";
      data: ChatRenderItem;
    };

function renderItemKey(item: ChatRenderItem): string {
  return item.kind === "activity-group" ? item.id : item.item.id;
}

export default function ThreadDetailScreen() {
  const params = useLocalSearchParams<{ id?: string }>();
  const threadId = typeof params.id === "string" ? params.id : "";
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const thread = useThreadStore((state) => state.getThread(threadId));
  const pendingRequest = useThreadStore((state) => state.getPendingRequest(threadId));
  const showDebugMessages = useDisplayPreferencesStore((state) => state.showDebugMessages);
  const activeTurnStartedAt = useThreadStore((state) => state.getActiveTurnStartedAt(threadId));
  const setComposerDraft = useThreadStore((state) => state.setComposerDraft);
  const submitComposer = useThreadStore((state) => state.submitComposer);
  const interruptThread = useThreadStore((state) => state.interruptThread);
  const clearPendingRequest = useThreadStore((state) => state.clearPendingRequest);
  const [askDraft, setAskDraft] = useState("");
  const runtimeClient = getActiveCoworkJsonRpcClient();

  const isDraftThread = threadId.startsWith("draft-");

  const connectionState = usePairingStore((state) => state.connectionState);
  const isConnected =
    connectionState.status === "connected" && connectionState.transportMode === "native";
  const isOfflineReadOnly = !isConnected && !isDraftThread;

  useEffect(() => {
    let active = true;
    async function loadThreadFeed() {
      if (!threadId || isDraftThread || !isConnected || !runtimeClient) {
        return;
      }
      try {
        await runtimeClient.resumeThread(threadId);
        const reread = await runtimeClient.readThread(threadId);
        if (active && reread.coworkSnapshot) {
          useThreadStore.getState().hydrate(reread.coworkSnapshot);
        }
      } catch (error) {
        console.error("Failed to load thread feed:", error);
      }
    }
    void loadThreadFeed();
    return () => {
      active = false;
    };
  }, [threadId, isConnected, runtimeClient, isDraftThread]);

  const renderItems = useMemo(
    () => buildChatRenderItems(filterFeedForDisplay(thread?.feed ?? [], showDebugMessages)),
    [thread?.feed, showDebugMessages],
  );

  const liveActivityGroupId = useMemo(() => {
    if (!activeTurnStartedAt) return null;
    for (let index = renderItems.length - 1; index >= 0; index -= 1) {
      const entry = renderItems[index];
      if (entry?.kind === "activity-group") {
        return entry.id;
      }
    }
    return null;
  }, [activeTurnStartedAt, renderItems]);

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

  const activePendingRequest = isConnected ? pendingRequest : null;
  const showSessionBadge = isDraftThread || activePendingRequest !== null || isOfflineReadOnly;

  return (
    <>
      <Stack.Screen
        options={{
          title: activeThread.title,
        }}
      />
      {activePendingRequest ? (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button
            icon="xmark.circle.fill"
            accessibilityLabel="Stop turn"
            onPress={() => {
              void interruptCurrentThread();
            }}
          />
        </Stack.Toolbar>
      ) : null}
      <KeyboardAvoidingView
        style={{ flex: 1, backgroundColor: theme.background, position: "relative" }}
        behavior={
          process.env.EXPO_OS === "ios"
            ? "padding"
            : process.env.EXPO_OS === "android"
              ? "height"
              : undefined
        }
      >
        <FlatList
          style={{ flex: 1, backgroundColor: theme.background }}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{
            gap: 20,
            paddingHorizontal: 22,
            paddingTop: 8,
            paddingBottom: Math.max(insets.bottom + 96, 112),
          }}
          keyboardShouldPersistTaps="handled"
          data={
            [
              ...renderItems.map((item) => ({ type: "render", data: item })),
              ...(activePendingRequest ? [{ type: "pending", data: activePendingRequest }] : []),
            ] as ThreadDetailListItem[]
          }
          keyExtractor={(item) => (item.type === "pending" ? "pending" : renderItemKey(item.data))}
          ListHeaderComponent={
            showSessionBadge
              ? () => (
                  <View
                    style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingBottom: 4 }}
                  >
                    {isDraftThread ? <StatusPill label="local draft" tone="primary" /> : null}
                    {isOfflineReadOnly ? (
                      <StatusPill label="offline · read only" tone="warning" />
                    ) : null}
                    {activePendingRequest ? (
                      <StatusPill label="needs response" tone="warning" />
                    ) : null}
                  </View>
                )
              : undefined
          }
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
              const request = item.data;
              return (
                <PendingRequestCard
                  request={request}
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
            return (
              <ThreadRenderItem
                renderItem={item.data}
                showDebugMessages={showDebugMessages}
                live={item.data.kind === "activity-group" && item.data.id === liveActivityGroupId}
                liveStartedAt={activeTurnStartedAt}
              />
            );
          }}
        />

        <View
          pointerEvents="box-none"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            alignSelf: "stretch",
            width: "100%",
            paddingHorizontal: 16,
            paddingTop: 8,
            paddingBottom: Math.max(insets.bottom, 8),
            backgroundColor: "transparent",
          }}
        >
          <ComposerBar
            value={activeThread.composerDraft}
            onChangeText={(text) => setComposerDraft(activeThread.id, text)}
            onSubmit={async () => {
              if (!isConnected) {
                return;
              }
              if (runtimeClient && !isDraftThread && activeThread.composerDraft.trim()) {
                const draft = activeThread.composerDraft;
                const clientMessageId = (globalThis as any).crypto.randomUUID() as string;
                useThreadStore
                  .getState()
                  .appendOptimisticUserMessage(activeThread.id, draft, clientMessageId);
                setComposerDraft(activeThread.id, "");
                try {
                  await runtimeClient.startTurn(activeThread.id, draft, clientMessageId);
                } catch (error) {
                  console.error("Failed to start turn:", error);
                }
                return;
              }
              submitComposer(activeThread.id);
            }}
            helperText={
              isOfflineReadOnly
                ? "Showing cached messages. Connect to your desktop to send."
                : isDraftThread
                  ? "This draft stays local until you pair with a desktop."
                  : null
            }
            submitLabel={isDraftThread ? "Save draft" : "Send"}
            disabled={!isConnected || !activeThread.composerDraft.trim()}
          />
        </View>
      </KeyboardAvoidingView>
    </>
  );
}
