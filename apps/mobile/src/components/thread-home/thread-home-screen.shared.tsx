import { Stack, useRouter } from "expo-router";
import {
  Fragment,
  memo,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";

import { SFSymbol } from "@/components/ui/sf-symbol";
import {
  minimumTouchTarget,
  runAccessibleLayoutAnimation,
  useAccessibilityAnnouncement,
  useReducedMotionEnabled,
} from "@/features/accessibility/mobile-accessibility";
import type { MobilePlatformContract } from "@/features/cowork/mobilePerformanceContracts";
import { getMobileListPerformanceContract } from "@/features/cowork/mobilePerformanceContracts";
import {
  buildThreadHomeListSections,
  type ThreadHomeListRow,
  type ThreadHomeListSection,
} from "@/features/cowork/threadHomeListModel";
import { formatThreadRelativeAge } from "@/features/cowork/threadHomeModel";
import { useThreadStore } from "@/features/cowork/threadStore";
import { useThreadHome } from "@/features/cowork/useThreadHome";
import { usePairingStore } from "@/features/pairing/pairingStore";
import { useAppTheme } from "@/theme/use-app-theme";

const MENU_ACTIONS = [
  { title: "Remote access", icon: "iphone.and.arrow.forward", href: "/(pairing)" },
] as const;

const LOAD_TIMEOUT_MS = 8_000;

type ThreadHomeRowActions = {
  onOpenThread: (threadId: string) => void;
  onToggleProject: (workspaceId: string) => void;
  onLoadMoreChats: () => void;
  onLoadMoreProject: (workspaceId: string) => void;
};

function describeLoadError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message;
    if (
      /\b(?:could not connect|connection refused|ECONNREFUSED|network request failed|Failed to connect|certificate mismatch|SSL|TLS|handshake)\b/i.test(
        message,
      )
    ) {
      return "Cowork Desktop is unreachable. The desktop may have restarted or rotated its certificate — open Remote access from the menu and scan the QR again to re-pair.";
    }
    if (/timed out/i.test(message)) {
      return "Couldn't reach Cowork. Check the desktop is online, or open Remote access from the menu and re-pair if the desktop recently restarted.";
    }
    return message;
  }
  return "Couldn't load. Try again.";
}

async function runWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error("Request timed out")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

function useLatestCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const callbackRef = useRef(callback);
  useLayoutEffect(() => {
    callbackRef.current = callback;
  }, [callback]);
  return useCallback((...args: Args) => callbackRef.current(...args), []);
}

function rowShellStyle(row: ThreadHomeListRow, backgroundColor: string): ViewStyle {
  return {
    overflow: "hidden",
    backgroundColor,
    borderTopLeftRadius: row.isFirst ? 12 : 0,
    borderTopRightRadius: row.isFirst ? 12 : 0,
    borderBottomLeftRadius: row.isLast ? 12 : 0,
    borderBottomRightRadius: row.isLast ? 12 : 0,
    borderCurve: "continuous",
  };
}

function RowTextContent({
  title,
  preview,
  age,
  indent = false,
}: {
  title: string;
  preview?: string;
  age: string;
  indent?: boolean;
}) {
  const theme = useAppTheme();
  return (
    <View
      style={{
        minHeight: preview ? 62 : minimumTouchTarget(),
        justifyContent: "center",
        paddingLeft: indent ? 45 : 16,
        paddingRight: 16,
        paddingVertical: preview ? 10 : 0,
        gap: 3,
      }}
    >
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 11 }}>
        {!indent ? <SFSymbol name="bubble.left.fill" size={18} color={theme.primary} /> : null}
        <Text
          selectable
          style={{
            color: theme.text,
            fontSize: indent ? 15 : 17,
            flex: 1,
            minWidth: 160,
          }}
        >
          {title}
        </Text>
        <Text
          style={{
            color: theme.textTertiary,
            fontSize: indent ? 12 : 13,
            fontVariant: ["tabular-nums"],
          }}
        >
          {age}
        </Text>
      </View>
      {preview ? (
        <Text
          selectable
          style={{
            color: theme.textSecondary,
            fontSize: 13,
            paddingLeft: 29,
          }}
        >
          {preview}
        </Text>
      ) : null}
    </View>
  );
}

function LoadMoreContent({
  label,
  loading,
  error,
}: {
  label: string;
  loading: boolean;
  error: string | null;
}) {
  const theme = useAppTheme();
  const showError = Boolean(error) && !loading;
  return (
    <View
      style={{
        minHeight: 48,
        paddingHorizontal: 16,
        paddingVertical: showError ? 10 : 0,
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
      }}
    >
      {showError ? (
        <>
          <Text
            selectable
            style={{
              color: theme.danger,
              fontSize: 13,
              textAlign: "center",
            }}
          >
            {error}
          </Text>
          <Text style={{ color: theme.primary, fontSize: 15, fontWeight: "600" }}>Try again</Text>
        </>
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {loading ? <ActivityIndicator size="small" color={theme.primary} /> : null}
          <Text style={{ color: theme.primary, fontSize: 15, fontWeight: "600" }}>{label}</Text>
        </View>
      )}
    </View>
  );
}

function ThreadHomeRow({
  row,
  actions,
}: {
  row: ThreadHomeListRow;
  actions: ThreadHomeRowActions;
}) {
  const theme = useAppTheme();
  const shellStyle = rowShellStyle(row, theme.surface);
  const separatorStyle: ViewStyle = {
    borderBottomWidth: row.isLast ? 0 : StyleSheet.hairlineWidth,
    borderBottomColor: theme.borderMuted,
  };

  switch (row.kind) {
    case "chat": {
      const preview =
        row.thread.preview && row.thread.preview !== "No activity yet."
          ? row.thread.preview
          : undefined;
      return (
        <View style={shellStyle}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open chat ${row.thread.title}${
              row.thread.pendingPrompt ? ", needs response" : ""
            }`}
            onPress={() => actions.onOpenThread(row.thread.id)}
            style={({ pressed }) => [
              separatorStyle,
              { backgroundColor: pressed ? theme.surfaceMuted : theme.surface },
            ]}
          >
            <RowTextContent
              title={row.thread.title}
              preview={preview}
              age={formatThreadRelativeAge(row.thread.updatedAt)}
            />
          </Pressable>
        </View>
      );
    }
    case "project":
      return (
        <View style={shellStyle}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: row.expanded }}
            accessibilityLabel={
              row.expanded
                ? `Collapse project ${row.workspaceName}`
                : `Expand project ${row.workspaceName}`
            }
            onPress={() => actions.onToggleProject(row.workspaceId)}
            style={({ pressed }) => [
              separatorStyle,
              {
                minHeight: 54,
                paddingHorizontal: 16,
                flexDirection: "row",
                alignItems: "center",
                gap: 11,
                backgroundColor: pressed ? theme.surfaceMuted : theme.surface,
              },
            ]}
          >
            <SFSymbol
              name={row.expanded ? "folder.fill" : "folder"}
              size={18}
              color={theme.primary}
            />
            <Text
              selectable
              style={{
                color: theme.text,
                fontSize: 17,
                flex: 1,
                minWidth: 160,
              }}
            >
              {row.workspaceName}
            </Text>
            <Text
              style={{ color: theme.textTertiary, fontSize: 13, fontVariant: ["tabular-nums"] }}
            >
              {row.count}
            </Text>
            <SFSymbol
              name="chevron.right"
              size={13}
              color={theme.textTertiary}
              style={{ transform: [{ rotate: row.expanded ? "90deg" : "0deg" }] }}
            />
          </Pressable>
        </View>
      );
    case "project-thread":
      return (
        <View style={shellStyle}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open chat ${row.thread.title}${
              row.thread.pendingPrompt ? ", needs response" : ""
            }`}
            onPress={() => actions.onOpenThread(row.thread.id)}
            style={({ pressed }) => [
              separatorStyle,
              { backgroundColor: pressed ? theme.surfaceMuted : theme.surface },
            ]}
          >
            <RowTextContent
              title={row.thread.title}
              age={formatThreadRelativeAge(row.thread.updatedAt)}
              indent
            />
          </Pressable>
        </View>
      );
    case "empty":
      return (
        <View style={[shellStyle, separatorStyle]}>
          <View style={{ minHeight: 52, paddingHorizontal: 16, justifyContent: "center" }}>
            <Text selectable style={{ color: theme.textSecondary, fontSize: 15 }}>
              {row.label}
            </Text>
          </View>
        </View>
      );
    case "chat-load-more":
      return (
        <View style={shellStyle}>
          <Pressable
            disabled={row.loading}
            accessibilityLabel={row.loading ? "Loading more chats" : row.label}
            accessibilityRole="button"
            accessibilityState={{ busy: row.loading, disabled: row.loading }}
            onPress={actions.onLoadMoreChats}
            style={({ pressed }) => [
              separatorStyle,
              { backgroundColor: pressed ? theme.surfaceMuted : theme.surface },
            ]}
          >
            <LoadMoreContent label={row.label} loading={row.loading} error={row.error} />
          </Pressable>
        </View>
      );
    case "project-load-more":
      return (
        <View style={shellStyle}>
          <Pressable
            disabled={row.loading}
            accessibilityLabel={row.loading ? "Loading more project chats" : row.label}
            accessibilityRole="button"
            accessibilityState={{ busy: row.loading, disabled: row.loading }}
            onPress={() => actions.onLoadMoreProject(row.workspaceId)}
            style={({ pressed }) => [
              separatorStyle,
              { backgroundColor: pressed ? theme.surfaceMuted : theme.surface },
            ]}
          >
            <LoadMoreContent label={row.label} loading={row.loading} error={row.error} />
          </Pressable>
        </View>
      );
    default: {
      const exhaustive: never = row;
      return exhaustive;
    }
  }
}

const MemoizedThreadHomeRow = memo(
  ThreadHomeRow,
  (previous, next) =>
    previous.row.key === next.row.key &&
    previous.row.revision === next.row.revision &&
    previous.row.isFirst === next.row.isFirst &&
    previous.row.isLast === next.row.isLast &&
    previous.actions === next.actions,
);

function SectionHeader({
  section,
}: {
  section: Pick<ThreadHomeListSection, "title" | "orderIndex">;
}) {
  const theme = useAppTheme();
  return (
    <Text
      accessibilityRole="header"
      style={{
        color: theme.textSecondary,
        fontSize: 13,
        textTransform: "uppercase",
        letterSpacing: 0.4,
        paddingHorizontal: 16,
        paddingTop: section.orderIndex === 0 ? 8 : 26,
        paddingBottom: 6,
        backgroundColor: theme.backgroundMuted,
      }}
    >
      {section.title}
    </Text>
  );
}

function DisconnectedBanner({ message, onPress }: { message: string; onPress: () => void }) {
  const theme = useAppTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Re-pair Cowork Desktop"
      onPress={onPress}
      style={({ pressed }) => ({
        borderRadius: 12,
        borderCurve: "continuous",
        backgroundColor: pressed ? theme.surfaceMuted : theme.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.danger,
        paddingHorizontal: 14,
        paddingVertical: 12,
        flexDirection: "row",
        alignItems: "center",
        gap: 11,
        marginBottom: 18,
      })}
    >
      <SFSymbol name="exclamationmark.triangle.fill" size={20} color={theme.danger} />
      <View style={{ flex: 1 }}>
        <Text
          style={{
            color: theme.text,
            fontSize: 15,
            fontWeight: "600",
          }}
        >
          Cowork Desktop disconnected
        </Text>
        <Text
          selectable
          style={{
            color: theme.textSecondary,
            fontSize: 13,
            lineHeight: 18,
            paddingTop: 2,
          }}
        >
          {message}
        </Text>
      </View>
      <Text style={{ color: theme.primary, fontSize: 15, fontWeight: "600" }}>Re-pair</Text>
    </Pressable>
  );
}

function EmptyHomeState({ children }: { children: ReactNode }) {
  const theme = useAppTheme();
  return (
    <View
      style={{
        borderRadius: 20,
        borderCurve: "continuous",
        backgroundColor: theme.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.borderMuted,
        padding: 24,
        marginTop: 8,
      }}
    >
      <Text
        selectable
        style={{
          color: theme.textSecondary,
          fontSize: 15,
          lineHeight: 21,
          textAlign: "center",
        }}
      >
        {children}
      </Text>
    </View>
  );
}

export function SharedThreadHomeScreen({ platform }: { platform: MobilePlatformContract }) {
  const theme = useAppTheme();
  const router = useRouter();
  const reducedMotionEnabled = useReducedMotionEnabled();
  const threadHome = useThreadHome();
  const {
    viewModel,
    setSearchQuery,
    reorderSections,
    refreshHome,
    homeLoadPending,
    loadMoreChats,
    loadMoreProject,
    toggleShowAllChats,
    toggleProjectThreadListExpanded,
    toggleWorkspaceExpanded,
    expandWorkspace,
  } = threadHome;
  const [chatsError, setChatsError] = useState<string | null>(null);
  const [projectErrors, setProjectErrors] = useState<Record<string, string>>({});
  const [isRefreshing, setIsRefreshing] = useState(false);
  const connectionStatus = usePairingStore((state) => state.connectionState.status);
  const connectionLastError = usePairingStore((state) => state.connectionState.lastError);
  const hasTrustedDesktop = usePairingStore((state) => state.trustedMacs.length > 0);
  const performanceContract = getMobileListPerformanceContract(platform, "home");

  const projectsFirst = viewModel.sectionOrder[0] === "projects";
  const showDisconnectedBanner = connectionStatus === "error" && hasTrustedDesktop;
  const disconnectedMessage = connectionLastError ?? "Tap to open Remote access and reconnect.";
  const announcedError =
    chatsError ??
    Object.values(projectErrors)[0] ??
    (showDisconnectedBanner ? disconnectedMessage : null);
  useAccessibilityAnnouncement(announcedError);

  const setProjectError = useCallback((workspaceId: string, error: string | null) => {
    setProjectErrors((current) => {
      const next = { ...current };
      if (error === null) {
        delete next[workspaceId];
      } else {
        next[workspaceId] = error;
      }
      return next;
    });
  }, []);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    setChatsError(null);
    setProjectErrors({});
    try {
      await runWithTimeout(refreshHome(), LOAD_TIMEOUT_MS);
    } catch (error) {
      setChatsError(describeLoadError(error));
    } finally {
      setIsRefreshing(false);
    }
  }, [refreshHome]);

  const handleCompose = useCallback(() => {
    useThreadStore.getState().seedThread();
    const draftId = useThreadStore.getState().selectedThreadId;
    if (draftId) {
      router.push(`/thread/${draftId}` as const);
    }
  }, [router]);

  const handleOpenThread = useCallback(
    (threadId: string) => {
      const group = viewModel.projects.find((entry) =>
        entry.visibleItems.some((thread) => thread.id === threadId),
      );
      if (group) {
        expandWorkspace(group.workspace.id);
      }
      router.push(`/thread/${threadId}` as const);
    },
    [expandWorkspace, router, viewModel.projects],
  );

  const handleLoadMoreChatsCurrent = useCallback(async () => {
    const hasLoadMore = viewModel.hiddenChatCount > 0 || viewModel.canLoadMoreChatsFromServer;
    if (viewModel.hiddenChatCount > 0 && viewModel.showAllChats) {
      setChatsError(null);
      toggleShowAllChats();
      return;
    }
    setChatsError(null);
    try {
      if (hasLoadMore) {
        await runWithTimeout(loadMoreChats(), LOAD_TIMEOUT_MS);
      } else {
        await runWithTimeout(refreshHome(), LOAD_TIMEOUT_MS);
      }
    } catch (error) {
      setChatsError(describeLoadError(error));
    }
  }, [
    loadMoreChats,
    refreshHome,
    toggleShowAllChats,
    viewModel.canLoadMoreChatsFromServer,
    viewModel.hiddenChatCount,
    viewModel.showAllChats,
  ]);
  const handleLoadMoreChats = useLatestCallback(handleLoadMoreChatsCurrent);

  const handleLoadMoreProjectCurrent = useCallback(
    async (workspaceId: string) => {
      const group = viewModel.projects.find((entry) => entry.workspace.id === workspaceId);
      if (!group) {
        return;
      }
      if (group.hiddenLoadedCount > 0 && group.showAllThreads) {
        setProjectError(workspaceId, null);
        toggleProjectThreadListExpanded(workspaceId);
        return;
      }
      setProjectError(workspaceId, null);
      try {
        await runWithTimeout(loadMoreProject(workspaceId), LOAD_TIMEOUT_MS);
      } catch (error) {
        setProjectError(workspaceId, describeLoadError(error));
      }
    },
    [loadMoreProject, setProjectError, toggleProjectThreadListExpanded, viewModel.projects],
  );
  const handleLoadMoreProject = useLatestCallback(handleLoadMoreProjectCurrent);

  const handleOpenThreadLatest = useLatestCallback(handleOpenThread);
  const handleToggleProject = useCallback(
    (workspaceId: string) => {
      runAccessibleLayoutAnimation(reducedMotionEnabled);
      toggleWorkspaceExpanded(workspaceId);
    },
    [reducedMotionEnabled, toggleWorkspaceExpanded],
  );

  const actions = useMemo<ThreadHomeRowActions>(
    () => ({
      onOpenThread: handleOpenThreadLatest,
      onToggleProject: handleToggleProject,
      onLoadMoreChats: () => {
        void handleLoadMoreChats();
      },
      onLoadMoreProject: (workspaceId) => {
        void handleLoadMoreProject(workspaceId);
      },
    }),
    [handleLoadMoreChats, handleLoadMoreProject, handleOpenThreadLatest, handleToggleProject],
  );

  const sections = useMemo(
    () =>
      buildThreadHomeListSections({
        viewModel,
        homeLoadPending,
        chatsError,
        projectErrors,
      }),
    [chatsError, homeLoadPending, projectErrors, viewModel],
  );

  const listHeader = showDisconnectedBanner ? (
    <DisconnectedBanner message={disconnectedMessage} onPress={() => router.push("/(pairing)")} />
  ) : null;

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
        }}
      />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Menu icon="ellipsis" accessibilityLabel="Open menu">
          {MENU_ACTIONS.map((action) => (
            <Stack.Toolbar.MenuAction
              key={action.title}
              icon={action.icon}
              onPress={() => router.push(action.href)}
            >
              {action.title}
            </Stack.Toolbar.MenuAction>
          ))}
          <Stack.Toolbar.MenuAction
            icon={projectsFirst ? "bubble.left.fill" : "folder.fill"}
            onPress={() => {
              runAccessibleLayoutAnimation(reducedMotionEnabled);
              reorderSections(0, 2);
            }}
          >
            {projectsFirst ? "Show Chats first" : "Show Projects first"}
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon="square.and.pencil"
          accessibilityLabel="New chat"
          onPress={handleCompose}
        />
      </Stack.Toolbar>
      <SectionList<ThreadHomeListRow, ThreadHomeListSection>
        accessibilityLabel="Chats and workspaces"
        style={{ flex: 1, backgroundColor: theme.backgroundMuted }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 110 }}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        sections={sections}
        keyExtractor={(item) => item.key}
        initialNumToRender={performanceContract.initialNumToRender}
        maxToRenderPerBatch={performanceContract.maxToRenderPerBatch}
        updateCellsBatchingPeriod={performanceContract.updateCellsBatchingPeriod}
        windowSize={performanceContract.windowSize}
        removeClippedSubviews={performanceContract.removeClippedSubviews}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        stickySectionHeadersEnabled={false}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor={theme.textSecondary}
          />
        }
        ListHeaderComponent={listHeader}
        ListEmptyComponent={
          <EmptyHomeState>
            {viewModel.searchQuery
              ? "No thread matches the current search."
              : "Threads will appear here when you start a conversation."}
          </EmptyHomeState>
        }
        renderSectionHeader={({ section }) => <SectionHeader section={section} />}
        renderItem={({ item }) => <MemoizedThreadHomeRow row={item} actions={actions} />}
      />
    </Fragment>
  );
}
