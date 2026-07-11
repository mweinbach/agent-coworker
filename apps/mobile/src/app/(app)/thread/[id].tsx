import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ComposerBar } from "@/components/ComposerBar";
import { PendingRequestCard } from "@/components/thread/pending-request-card";
import { SubagentBar } from "@/components/thread/subagent-bar";
import { ThreadRenderItem } from "@/components/thread/thread-render-item";
import { Screen } from "@/components/ui/screen";
import { StatusPill } from "@/components/ui/status-pill";
import { buildChatRenderItems, type ChatRenderItem } from "@/features/cowork/activityGroups";
import {
  type ComposerSubmission,
  getComposerPolicy,
  hasComposerContent,
  toComposerTurnInput,
} from "@/features/cowork/composer-policy";
import { filterFeedForDisplay } from "@/features/cowork/feedDisplay";
import { getActiveCoworkJsonRpcClient } from "@/features/cowork/runtimeClient";
import {
  copyPendingServerRequestIdentity,
  hasPendingServerRequestIdentity,
  type PendingServerRequestIdentity,
} from "@/features/cowork/server-request-identity";
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

type ThreadActionError =
  | { kind: "load"; message: string }
  | { kind: "send"; message: string }
  | {
      kind: "respond";
      message: string;
      response: {
        identity: PendingServerRequestIdentity;
        result: unknown;
      };
    }
  | { kind: "interrupt"; message: string };

const NEAR_BOTTOM_THRESHOLD_PX = 96;
const EMPTY_AGENTS: unknown[] = [];

function normalizeAgents(agents: unknown[]): Array<{
  sessionId?: string;
  nickname?: string | null;
  role?: string | null;
  executionState?: string | null;
}> {
  return agents
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      return {
        sessionId:
          typeof record.sessionId === "string"
            ? record.sessionId
            : typeof record.agentId === "string"
              ? record.agentId
              : undefined,
        nickname: typeof record.nickname === "string" ? record.nickname : null,
        role: typeof record.role === "string" ? record.role : null,
        executionState: typeof record.executionState === "string" ? record.executionState : null,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
}

function renderItemKey(item: ChatRenderItem): string {
  return item.kind === "activity-group" ? item.id : item.item.id;
}

function describeError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

function reconcileActiveTurn(
  threadId: string,
  turns: Array<{ id: string; status: string }> | undefined,
): void {
  const latestTurn = turns?.at(-1);
  const store = useThreadStore.getState();
  if (!latestTurn) return;
  if (latestTurn?.status === "inProgress") {
    if (store.getActiveTurnStartedAt(threadId) === null) {
      store.markTurnStarted(threadId, new Date().toISOString());
    }
    return;
  }
  store.markTurnCompleted(threadId);
}

export default function ThreadDetailScreen() {
  const params = useLocalSearchParams<{ id?: string }>();
  const threadId = typeof params.id === "string" ? params.id : "";
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const thread = useThreadStore((state) => state.getThread(threadId));
  const pendingRequest = useThreadStore((state) => state.getPendingRequest(threadId));
  const snapshotAgents = useThreadStore(
    (state) => state.snapshots?.[threadId]?.agents ?? EMPTY_AGENTS,
  );
  const normalizedAgents = useMemo(() => normalizeAgents(snapshotAgents), [snapshotAgents]);
  const showDebugMessages = useDisplayPreferencesStore((state) => state.showDebugMessages);
  const activeTurnStartedAt = useThreadStore((state) => state.getActiveTurnStartedAt(threadId));
  const setComposerDraft = useThreadStore((state) => state.setComposerDraft);
  const submitComposer = useThreadStore((state) => state.submitComposer);
  const beginComposerSubmission = useThreadStore((state) => state.beginComposerSubmission);
  const retryComposerSubmission = useThreadStore((state) => state.retryComposerSubmission);
  const failComposerSubmission = useThreadStore((state) => state.failComposerSubmission);
  const acceptComposerSubmission = useThreadStore((state) => state.acceptComposerSubmission);
  const appendOptimisticUserMessage = useThreadStore((state) => state.appendOptimisticUserMessage);
  const removeOptimisticUserMessage = useThreadStore((state) => state.removeOptimisticUserMessage);
  const interruptThread = useThreadStore((state) => state.interruptThread);
  const clearPendingRequest = useThreadStore((state) => state.clearPendingRequest);
  const [askDraft, setAskDraft] = useState("");
  const [actionError, setActionError] = useState<ThreadActionError | null>(null);
  const [isStopping, setIsStopping] = useState(false);

  const [stickToBottom, setStickToBottom] = useState(true);
  const listRef = useRef<FlatList<ThreadDetailListItem>>(null);
  const loadRequestIdRef = useRef(0);
  const stoppingRef = useRef(false);
  const runtimeClient = getActiveCoworkJsonRpcClient();

  const isDraftThread = threadId.startsWith("draft-");
  const turnActive = activeTurnStartedAt !== null;

  const connectionState = usePairingStore((state) => state.connectionState);
  const isConnected =
    connectionState.status === "connected" && connectionState.transportMode === "native";
  const isOfflineReadOnly = !isConnected && !isDraftThread;

  const loadThreadFeed = useCallback(async () => {
    const requestId = ++loadRequestIdRef.current;
    if (!threadId || isDraftThread || !isConnected || !runtimeClient) {
      return;
    }
    try {
      await runtimeClient.resumeThread(threadId);
      if (requestId !== loadRequestIdRef.current) return;
      const reread = await runtimeClient.readThread(threadId, { includeTurns: true });
      if (requestId !== loadRequestIdRef.current) return;
      if (reread.coworkSnapshot) {
        useThreadStore.getState().hydrate(reread.coworkSnapshot);
      }
      reconcileActiveTurn(threadId, reread.thread.turns);
      setActionError((current) => (current?.kind === "load" ? null : current));
    } catch (error) {
      if (requestId !== loadRequestIdRef.current) return;
      setActionError({
        kind: "load",
        message: describeError(error, "Failed to load this conversation."),
      });
    }
  }, [threadId, isConnected, runtimeClient, isDraftThread]);

  useEffect(() => {
    void loadThreadFeed();
    return () => {
      loadRequestIdRef.current += 1;
    };
  }, [loadThreadFeed]);

  const showStop = turnActive || (isConnected && pendingRequest !== null);
  useEffect(() => {
    if (showStop) return;
    stoppingRef.current = false;
    setIsStopping(false);
  }, [showStop]);

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

  const listData = useMemo(() => {
    const activePendingRequest = isConnected ? pendingRequest : null;
    return [
      ...renderItems.map((item) => ({ type: "render" as const, data: item })),
      ...(activePendingRequest ? [{ type: "pending" as const, data: activePendingRequest }] : []),
    ] as ThreadDetailListItem[];
  }, [isConnected, pendingRequest, renderItems]);

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
    setStickToBottom(distanceFromBottom <= NEAR_BOTTOM_THRESHOLD_PX);
  }, []);

  const scrollToLatest = useCallback((animated = true) => {
    listRef.current?.scrollToEnd({ animated });
    setStickToBottom(true);
  }, []);

  const handleContentSizeChange = useCallback(() => {
    if (!stickToBottom) return;
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated: true });
    });
  }, [stickToBottom]);

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
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    setIsStopping(true);
    setActionError((current) => (current?.kind === "interrupt" ? null : current));
    if (runtimeClient && !isDraftThread) {
      try {
        await runtimeClient.interruptTurn(activeThread.id);
      } catch (error) {
        stoppingRef.current = false;
        setIsStopping(false);
        setActionError({
          kind: "interrupt",
          message: describeError(error, "Failed to stop this turn."),
        });
        return;
      }
      try {
        const reread = await runtimeClient.readThread(activeThread.id, { includeTurns: true });
        if (reread.coworkSnapshot) {
          useThreadStore.getState().hydrate(reread.coworkSnapshot);
        }
        reconcileActiveTurn(activeThread.id, reread.thread.turns);
      } catch (error) {
        setActionError({
          kind: "load",
          message: describeError(error, "Stop sent. Failed to refresh this conversation."),
        });
      }
      return;
    }
    interruptThread(activeThread.id);
  }

  async function answerServerRequest(identity: PendingServerRequestIdentity, result: unknown) {
    const client = getActiveCoworkJsonRpcClient();
    if (!client) {
      return false;
    }
    setActionError((current) => (current?.kind === "respond" ? null : current));
    try {
      await client.respondServerRequest(identity.requestId, result);
      const currentRequest = useThreadStore.getState().getPendingRequest(activeThread.id);
      if (currentRequest && hasPendingServerRequestIdentity(currentRequest, identity)) {
        clearPendingRequest(activeThread.id);
      }
      return true;
    } catch (error) {
      setActionError({
        kind: "respond",
        message: describeError(error, "Failed to send your response."),
        response: { identity, result },
      });
      return false;
    }
  }

  async function sendComposerSubmission(submission: ComposerSubmission) {
    const client = getActiveCoworkJsonRpcClient();
    const optimisticText =
      submission.text || submission.attachments.map((attachment) => attachment.filename).join(", ");
    appendOptimisticUserMessage(activeThread.id, optimisticText, submission.clientMessageId);
    setActionError((current) => (current?.kind === "send" ? null : current));
    setStickToBottom(true);
    try {
      if (!client) {
        throw new Error("Desktop connection is unavailable.");
      }
      await client.startTurn(
        activeThread.id,
        toComposerTurnInput(submission),
        submission.clientMessageId,
      );
      acceptComposerSubmission(activeThread.id, submission.clientMessageId);
    } catch (error) {
      const message = describeError(error, "Failed to send message.");
      removeOptimisticUserMessage(activeThread.id, submission.clientMessageId);
      failComposerSubmission(activeThread.id, submission.clientMessageId, message);
      setActionError({ kind: "send", message });
    }
  }

  async function retryFailedComposerSubmission() {
    const submission = retryComposerSubmission(activeThread.id);
    if (submission) {
      await sendComposerSubmission(submission);
    }
  }

  async function handleSubmitComposer() {
    if (isDraftThread) {
      submitComposer(activeThread.id);
      return;
    }
    if (!isConnected || !runtimeClient) return;
    const clientMessageId = (globalThis as { crypto?: { randomUUID: () => string } }).crypto
      ?.randomUUID
      ? (globalThis as { crypto: { randomUUID: () => string } }).crypto.randomUUID()
      : `local-${Date.now()}`;
    const submission = beginComposerSubmission(activeThread.id, clientMessageId);
    if (submission) {
      await sendComposerSubmission(submission);
    }
  }

  const activePendingRequest = isConnected ? pendingRequest : null;
  const isSubmitting = activeThread.composerSubmission?.status === "submitting";
  const composerPolicy = getComposerPolicy({
    connected: isConnected,
    draftThread: isDraftThread,
    hasContent: hasComposerContent(
      activeThread.composerDraft,
      activeThread.composerAttachments ?? [],
    ),
    isBusy: showStop,
    isSubmitting,
    hasFailedSubmission: activeThread.composerSubmission?.status === "failed",
  });

  function retryActionError(error: ThreadActionError): void {
    switch (error.kind) {
      case "load":
        void loadThreadFeed();
        return;
      case "send":
        void retryFailedComposerSubmission();
        return;
      case "respond": {
        if (
          !activePendingRequest ||
          !hasPendingServerRequestIdentity(activePendingRequest, error.response.identity)
        ) {
          setActionError({
            ...error,
            message:
              "That request is no longer pending. Review the current request before responding.",
          });
          return;
        }
        void answerServerRequest(error.response.identity, error.response.result);
        return;
      }
      case "interrupt":
        void interruptCurrentThread();
        return;
      default: {
        const exhaustive: never = error;
        throw new Error(`Unhandled thread action error: ${String(exhaustive)}`);
      }
    }
  }

  const showSessionBadge =
    isDraftThread || activePendingRequest !== null || isOfflineReadOnly || turnActive;

  return (
    <>
      <Stack.Screen
        options={{
          title: activeThread.title,
        }}
      />
      {showStop ? (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button
            icon="xmark.circle.fill"
            accessibilityLabel={isStopping ? "Stopping turn" : "Stop turn"}
            disabled={isStopping}
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
          ref={listRef}
          style={{ flex: 1, backgroundColor: theme.background }}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{
            gap: 20,
            paddingHorizontal: 22,
            paddingTop: 8,
            paddingBottom: Math.max(insets.bottom + 96, 112),
          }}
          keyboardShouldPersistTaps="handled"
          data={listData}
          keyExtractor={(item) => (item.type === "pending" ? "pending" : renderItemKey(item.data))}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          onContentSizeChange={handleContentSizeChange}
          ListHeaderComponent={
            showSessionBadge || normalizedAgents.length > 0
              ? () => (
                  <View style={{ gap: 10, paddingBottom: 4 }}>
                    {normalizedAgents.length > 0 ? <SubagentBar agents={normalizedAgents} /> : null}
                    {showSessionBadge ? (
                      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                        {isDraftThread ? <StatusPill label="local draft" tone="primary" /> : null}
                        {isOfflineReadOnly ? (
                          <StatusPill label="offline · read only" tone="warning" />
                        ) : null}
                        {turnActive && !activePendingRequest ? (
                          <StatusPill label="working" tone="primary" />
                        ) : null}
                        {activePendingRequest ? (
                          <StatusPill label="needs response" tone="warning" />
                        ) : null}
                      </View>
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
                    void answerServerRequest(copyPendingServerRequestIdentity(request), { answer });
                  }}
                  onAnswerText={() => {
                    void answerServerRequest(copyPendingServerRequestIdentity(request), {
                      answer: askDraft || "ok",
                    }).then((sent) => {
                      if (sent) setAskDraft("");
                    });
                  }}
                  onApprove={() => {
                    void answerServerRequest(copyPendingServerRequestIdentity(request), {
                      decision: "accept",
                    });
                  }}
                  onReject={() => {
                    void answerServerRequest(copyPendingServerRequestIdentity(request), {
                      decision: "reject",
                    });
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

        {!stickToBottom && listData.length > 0 ? (
          <View
            pointerEvents="box-none"
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: Math.max(insets.bottom + 72, 88),
              alignItems: "center",
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Jump to latest messages"
              onPress={() => scrollToLatest(true)}
              style={({ pressed }) => ({
                borderRadius: 999,
                borderCurve: "continuous",
                borderWidth: 1,
                borderColor: theme.border,
                backgroundColor: pressed ? theme.surfaceMuted : theme.surface,
                paddingHorizontal: 14,
                paddingVertical: 8,
                boxShadow: "0 8px 20px rgba(0, 0, 0, 0.12)",
              })}
            >
              <Text style={{ color: theme.text, fontSize: 13, fontWeight: "600" }}>
                Jump to latest
              </Text>
            </Pressable>
          </View>
        ) : null}

        <View
          pointerEvents="box-none"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            alignSelf: "stretch",
            width: "100%",
            gap: 8,
            paddingHorizontal: 16,
            paddingTop: 8,
            paddingBottom: Math.max(insets.bottom, 8),
            backgroundColor: "transparent",
          }}
        >
          {actionError ? (
            <View
              testID="composer-recovery"
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                borderRadius: 16,
                borderCurve: "continuous",
                borderWidth: 1,
                borderColor: theme.danger,
                backgroundColor: theme.dangerMuted,
                paddingHorizontal: 14,
                paddingVertical: 10,
              }}
            >
              <Text
                selectable
                style={{ flex: 1, color: theme.danger, fontSize: 13, lineHeight: 18 }}
              >
                {actionError.message}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Retry ${actionError.kind}`}
                onPress={() => {
                  retryActionError(actionError);
                }}
                style={({ pressed }) => ({
                  borderRadius: 999,
                  borderCurve: "continuous",
                  backgroundColor: pressed ? theme.primaryMuted : theme.primary,
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                })}
              >
                <Text style={{ color: theme.primaryText, fontWeight: "600" }}>Retry</Text>
              </Pressable>
            </View>
          ) : null}
          <ComposerBar
            value={activeThread.composerDraft}
            onChangeText={(text) => setComposerDraft(activeThread.id, text)}
            onSubmit={() => {
              void handleSubmitComposer();
            }}
            onStop={() => {
              void interruptCurrentThread();
            }}
            canEdit={composerPolicy.canEdit}
            canSubmit={composerPolicy.canSubmit}
            isSubmitting={isSubmitting}
            isBusy={showStop}
            isStopping={isStopping}
            helperText={
              isOfflineReadOnly
                ? "Showing cached messages. Connect to your desktop to send."
                : isDraftThread
                  ? "This draft stays local until you pair with a desktop."
                  : null
            }
            submitLabel={isDraftThread ? "Save draft" : "Send"}
          />
        </View>
      </KeyboardAvoidingView>
    </>
  );
}
