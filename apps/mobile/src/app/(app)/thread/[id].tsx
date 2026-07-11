import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  type LayoutChangeEvent,
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
import { buildChatRenderItems } from "@/features/cowork/activityGroups";
import { filterFeedForDisplay } from "@/features/cowork/feedDisplay";
import { getMobileListPerformanceContract } from "@/features/cowork/mobilePerformanceContracts";
import { getActiveCoworkJsonRpcClient } from "@/features/cowork/runtimeClient";
import {
  buildThreadDetailList,
  type ThreadDetailListItem,
} from "@/features/cowork/threadListModel";
import {
  beginThreadProgrammaticMomentum,
  beginThreadProgrammaticScroll,
  finishThreadProgrammaticScroll,
  initialThreadProgrammaticScrollGuard,
  isThreadProgrammaticScrollActive,
  shouldApplyThreadUserScroll,
  shouldFinishInstantThreadScroll,
} from "@/features/cowork/threadProgrammaticScrollGuard";
import {
  changedThreadRows,
  initialThreadScrollState,
  measuredThreadDistanceFromBottom,
  reduceThreadScrollState,
  shouldFollowChangedRows,
  THREAD_NEAR_TAIL_THRESHOLD_PX,
  type ThreadRowRevision,
  type ThreadScrollEvent,
  type ThreadScrollMetrics,
} from "@/features/cowork/threadScrollState";
import { useThreadStore } from "@/features/cowork/threadStore";
import { usePairingStore } from "@/features/pairing/pairingStore";
import { useDisplayPreferencesStore } from "@/features/preferences/displayPreferencesStore";
import { useAppTheme } from "@/theme/use-app-theme";

type ThreadActionError = {
  kind: "load" | "send";
  message: string;
};

const EMPTY_AGENTS: unknown[] = [];
const THREAD_LIST_PERFORMANCE = getMobileListPerformanceContract(
  process.env.EXPO_OS === "ios" ? "ios" : "android",
  "thread",
);

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

function describeError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
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
  const feedMutation = useThreadStore(
    (state) => state.lastFeedMutationByThread?.[threadId] ?? null,
  );
  const setComposerDraft = useThreadStore((state) => state.setComposerDraft);
  const submitComposer = useThreadStore((state) => state.submitComposer);
  const appendOptimisticUserMessage = useThreadStore((state) => state.appendOptimisticUserMessage);
  const removeOptimisticUserMessage = useThreadStore((state) => state.removeOptimisticUserMessage);
  const interruptThread = useThreadStore((state) => state.interruptThread);
  const clearPendingRequest = useThreadStore((state) => state.clearPendingRequest);
  const [askDraft, setAskDraft] = useState("");
  const [actionError, setActionError] = useState<ThreadActionError | null>(null);
  const [scrollState, setScrollState] = useState(initialThreadScrollState);
  const scrollStateRef = useRef(scrollState);
  const listRef = useRef<FlatList<ThreadDetailListItem>>(null);
  const previousRowsRef = useRef<ThreadRowRevision[]>([]);
  const userGestureActiveRef = useRef(false);
  const programmaticScrollGuardRef = useRef(initialThreadProgrammaticScrollGuard());
  const scrollMetricsRef = useRef<ThreadScrollMetrics>({
    contentHeight: null,
    offsetY: 0,
    viewportHeight: null,
  });
  const forceFollowNextRowsRef = useRef(false);
  const previousFeedMutationRevisionRef = useRef<number | null>(null);
  const scrollThreadIdRef = useRef(threadId);
  const loadRequestIdRef = useRef(0);
  const runtimeClient = getActiveCoworkJsonRpcClient();

  const isDraftThread = threadId.startsWith("draft-");
  const turnActive = activeTurnStartedAt !== null;

  const connectionState = usePairingStore((state) => state.connectionState);
  const isConnected =
    connectionState.status === "connected" && connectionState.transportMode === "native";
  const isOfflineReadOnly = !isConnected && !isDraftThread;

  useEffect(() => {
    if (scrollThreadIdRef.current === threadId) {
      return;
    }
    const initialState = initialThreadScrollState();
    scrollThreadIdRef.current = threadId;
    scrollStateRef.current = initialState;
    previousRowsRef.current = [];
    userGestureActiveRef.current = false;
    programmaticScrollGuardRef.current = initialThreadProgrammaticScrollGuard();
    scrollMetricsRef.current = {
      contentHeight: null,
      offsetY: 0,
      viewportHeight: null,
    };
    forceFollowNextRowsRef.current = false;
    previousFeedMutationRevisionRef.current = null;
    setScrollState(initialState);
  }, [threadId]);

  const loadThreadFeed = useCallback(async () => {
    const requestId = ++loadRequestIdRef.current;
    if (!threadId || isDraftThread || !isConnected || !runtimeClient) {
      return;
    }
    try {
      await runtimeClient.resumeThread(threadId);
      if (requestId !== loadRequestIdRef.current) return;
      const reread = await runtimeClient.readThread(threadId);
      if (requestId !== loadRequestIdRef.current) return;
      if (reread.coworkSnapshot) {
        useThreadStore.getState().hydrate(reread.coworkSnapshot);
      }
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

  const listData = useMemo(
    () => buildThreadDetailList(renderItems, isConnected ? pendingRequest : null),
    [isConnected, pendingRequest, renderItems],
  );
  const rowRevisions = useMemo<ThreadRowRevision[]>(
    () => listData.map(({ key, revision }) => ({ key, revision })),
    [listData],
  );

  const applyScrollEvent = useCallback((event: ThreadScrollEvent) => {
    const currentScrollState = scrollStateRef.current;
    const nextScrollState = reduceThreadScrollState(currentScrollState, event);
    if (nextScrollState === currentScrollState) {
      return nextScrollState;
    }
    scrollStateRef.current = nextScrollState;
    setScrollState(nextScrollState);
    return nextScrollState;
  }, []);

  const beginProgrammaticScrollToEnd = useCallback((animated: boolean) => {
    programmaticScrollGuardRef.current = beginThreadProgrammaticScroll(animated);
    listRef.current?.scrollToEnd({ animated });
  }, []);

  const observeScrollDistance = useCallback(
    (distanceFromBottom: number) => {
      applyScrollEvent({
        type: "position-observed",
        distanceFromBottom,
      });

      const guard = programmaticScrollGuardRef.current;
      if (shouldApplyThreadUserScroll(guard, userGestureActiveRef.current)) {
        applyScrollEvent({
          type: "user-scroll",
          distanceFromBottom,
        });
      }
      if (shouldFinishInstantThreadScroll(guard, distanceFromBottom)) {
        programmaticScrollGuardRef.current = finishThreadProgrammaticScroll();
      }
    },
    [applyScrollEvent],
  );

  const observeCurrentMetrics = useCallback(
    (establishUnmeasuredTail: boolean) => {
      const metrics = scrollMetricsRef.current;
      if (listData.length === 0) {
        return;
      }
      const distanceFromBottom = measuredThreadDistanceFromBottom(metrics);
      if (distanceFromBottom === null) {
        return;
      }
      const shouldEstablishTail =
        establishUnmeasuredTail &&
        scrollStateRef.current.position === "unmeasured" &&
        scrollStateRef.current.followTailIntent &&
        distanceFromBottom > THREAD_NEAR_TAIL_THRESHOLD_PX;
      observeScrollDistance(distanceFromBottom);
      if (shouldEstablishTail) {
        beginProgrammaticScrollToEnd(false);
      }
    },
    [beginProgrammaticScrollToEnd, listData.length, observeScrollDistance],
  );

  useEffect(() => {
    const previousRows = previousRowsRef.current;
    previousRowsRef.current = rowRevisions;
    if (previousRows.length === 0) {
      return;
    }
    const changedKeys = changedThreadRows(previousRows, rowRevisions);
    if (changedKeys.length === 0) {
      return;
    }
    const hasNewFeedMutation =
      feedMutation !== null && feedMutation.revision !== previousFeedMutationRevisionRef.current;
    previousFeedMutationRevisionRef.current = feedMutation?.revision ?? null;

    const currentScrollState = scrollStateRef.current;
    applyScrollEvent({
      type: "rows-changed",
      changedKeys,
    });

    const forceFollow = forceFollowNextRowsRef.current;
    forceFollowNextRowsRef.current = false;
    const isStreamingMutation =
      feedMutation?.kind === "started" ||
      feedMutation?.kind === "delta" ||
      feedMutation?.kind === "local";
    if (
      forceFollow ||
      shouldFollowChangedRows(
        currentScrollState,
        changedKeys,
        turnActive && hasNewFeedMutation && isStreamingMutation,
      )
    ) {
      beginProgrammaticScrollToEnd(false);
    }
  }, [applyScrollEvent, beginProgrammaticScrollToEnd, feedMutation, rowRevisions, turnActive]);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      scrollMetricsRef.current = {
        contentHeight: contentSize.height,
        offsetY: contentOffset.y,
        viewportHeight: layoutMeasurement.height,
      };
      const distanceFromBottom = Math.max(
        0,
        contentSize.height - layoutMeasurement.height - contentOffset.y,
      );
      observeScrollDistance(distanceFromBottom);
    },
    [observeScrollDistance],
  );

  const scrollToLatest = useCallback(
    (animated = true) => {
      applyScrollEvent({ type: "jump" });
      beginProgrammaticScrollToEnd(animated);
    },
    [applyScrollEvent, beginProgrammaticScrollToEnd],
  );

  const handleContentSizeChange = useCallback(
    (_width: number, height: number) => {
      scrollMetricsRef.current.contentHeight = height;
      observeCurrentMetrics(true);
    },
    [observeCurrentMetrics],
  );

  const handleListLayout = useCallback(
    (event: LayoutChangeEvent) => {
      scrollMetricsRef.current.viewportHeight = event.nativeEvent.layout.height;
      observeCurrentMetrics(true);
    },
    [observeCurrentMetrics],
  );

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

  async function handleSubmitComposer() {
    if (!isConnected) {
      if (isDraftThread) {
        submitComposer(activeThread.id);
      }
      return;
    }
    if (runtimeClient && !isDraftThread && activeThread.composerDraft.trim()) {
      const draft = activeThread.composerDraft;
      const clientMessageId = (globalThis as { crypto?: { randomUUID: () => string } }).crypto
        ?.randomUUID
        ? (globalThis as { crypto: { randomUUID: () => string } }).crypto.randomUUID()
        : `local-${Date.now()}`;
      appendOptimisticUserMessage(activeThread.id, draft, clientMessageId);
      setComposerDraft(activeThread.id, "");
      setActionError((current) => (current?.kind === "send" ? null : current));
      forceFollowNextRowsRef.current = true;
      applyScrollEvent({ type: "jump" });
      try {
        await runtimeClient.startTurn(activeThread.id, draft, clientMessageId);
      } catch (error) {
        removeOptimisticUserMessage(activeThread.id, clientMessageId);
        setComposerDraft(activeThread.id, draft);
        setActionError({
          kind: "send",
          message: describeError(error, "Failed to send message."),
        });
      }
      return;
    }
    submitComposer(activeThread.id);
  }

  const activePendingRequest = isConnected ? pendingRequest : null;
  const showStop = turnActive || activePendingRequest !== null;
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
          keyExtractor={(item) => item.key}
          initialNumToRender={THREAD_LIST_PERFORMANCE.initialNumToRender}
          maxToRenderPerBatch={THREAD_LIST_PERFORMANCE.maxToRenderPerBatch}
          updateCellsBatchingPeriod={THREAD_LIST_PERFORMANCE.updateCellsBatchingPeriod}
          windowSize={THREAD_LIST_PERFORMANCE.windowSize}
          removeClippedSubviews={THREAD_LIST_PERFORMANCE.removeClippedSubviews}
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          onScrollBeginDrag={(event) => {
            programmaticScrollGuardRef.current = finishThreadProgrammaticScroll();
            userGestureActiveRef.current = true;
            handleScroll(event);
          }}
          onScroll={handleScroll}
          onScrollEndDrag={(event) => {
            handleScroll(event);
            userGestureActiveRef.current = false;
          }}
          onMomentumScrollBegin={() => {
            if (isThreadProgrammaticScrollActive(programmaticScrollGuardRef.current)) {
              programmaticScrollGuardRef.current = beginThreadProgrammaticMomentum(
                programmaticScrollGuardRef.current,
              );
              userGestureActiveRef.current = false;
              return;
            }
            userGestureActiveRef.current = true;
          }}
          onMomentumScrollEnd={(event) => {
            handleScroll(event);
            programmaticScrollGuardRef.current = finishThreadProgrammaticScroll();
            userGestureActiveRef.current = false;
          }}
          scrollEventThrottle={16}
          onContentSizeChange={handleContentSizeChange}
          onLayout={handleListLayout}
          ListHeaderComponent={
            showSessionBadge || actionError || normalizedAgents.length > 0
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
                    {actionError ? (
                      <View
                        style={{
                          gap: 10,
                          borderRadius: 16,
                          borderCurve: "continuous",
                          borderWidth: 1,
                          borderColor: theme.danger,
                          backgroundColor: theme.dangerMuted,
                          paddingHorizontal: 14,
                          paddingVertical: 12,
                        }}
                      >
                        <Text
                          selectable
                          style={{ color: theme.danger, fontSize: 14, lineHeight: 20 }}
                        >
                          {actionError.message}
                        </Text>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={
                            actionError.kind === "load" ? "Retry loading thread" : "Retry send"
                          }
                          onPress={() => {
                            if (actionError.kind === "load") {
                              void loadThreadFeed();
                              return;
                            }
                            void handleSubmitComposer();
                          }}
                          style={({ pressed }) => ({
                            alignSelf: "flex-start",
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
                revision={item.revision}
              />
            );
          }}
        />

        {!scrollState.followTail && listData.length > 0 ? (
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
              accessibilityLabel={
                scrollState.unseenKeys.length > 0
                  ? `${scrollState.unseenKeys.length} new. Jump to latest messages`
                  : "Jump to latest messages"
              }
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
                {scrollState.unseenKeys.length > 0
                  ? `${scrollState.unseenKeys.length} new · Jump to latest`
                  : "Jump to latest"}
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
            paddingHorizontal: 16,
            paddingTop: 8,
            paddingBottom: Math.max(insets.bottom, 8),
            backgroundColor: "transparent",
          }}
        >
          <ComposerBar
            value={activeThread.composerDraft}
            onChangeText={(text) => setComposerDraft(activeThread.id, text)}
            onSubmit={() => {
              void handleSubmitComposer();
            }}
            helperText={
              isOfflineReadOnly
                ? "Showing cached messages. Connect to your desktop to send."
                : isDraftThread
                  ? "This draft stays local until you pair with a desktop."
                  : null
            }
            submitLabel={isDraftThread ? "Save draft" : "Send"}
            disabled={isOfflineReadOnly}
          />
        </View>
      </KeyboardAvoidingView>
    </>
  );
}
