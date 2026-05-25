import { Stack, useRouter } from "expo-router";
import { Fragment, type ReactNode, useCallback, useState } from "react";
import {
  ActivityIndicator,
  LayoutAnimation,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { SFSymbol } from "@/components/ui/sf-symbol";
import {
  formatThreadRelativeAge,
  type HomeSectionKey,
  type ThreadHomeProjectGroup,
} from "@/features/cowork/threadHomeModel";
import type { MobileThreadSummary } from "@/features/cowork/threadStore";
import { useThreadStore } from "@/features/cowork/threadStore";
import { useThreadHome } from "@/features/cowork/useThreadHome";
import { usePairingStore } from "@/features/pairing/pairingStore";
import { useAppTheme } from "@/theme/use-app-theme";

const LOAD_TIMEOUT_MS = 8_000;

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
    timeoutId = setTimeout(
      () => reject(new Error("Request timed out")),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

const SETTINGS_ACTIONS = [
  { title: "Settings", icon: "slider.horizontal.3", href: "/(app)/settings" },
  { title: "Workspace", icon: "square.grid.2x2", href: "/(app)/(tabs)/workspace" },
  { title: "Skills", icon: "sparkles", href: "/(app)/(tabs)/skills" },
  { title: "Remote access", icon: "iphone.and.arrow.forward", href: "/(pairing)" },
] as const;

function useThreadHomeTheme() {
  const theme = useAppTheme();
  return {
    ...theme,
    backgroundMuted: theme.isDark ? "#000000" : "#f2f2f7",
    surface: theme.isDark ? "#1c1c1e" : "#ffffff",
    surfaceMuted: theme.isDark ? "#2c2c2e" : "#f2f2f7",
    borderMuted: theme.isDark ? "rgba(84, 84, 88, 0.65)" : "rgba(60, 60, 67, 0.18)",
    sectionHeader: theme.isDark ? "rgba(235, 235, 245, 0.6)" : "rgba(60, 60, 67, 0.6)",
  };
}

function animateListChange() {
  LayoutAnimation.configureNext({
    duration: 200,
    create: { type: "easeInEaseOut", property: "opacity" },
    update: { type: "easeInEaseOut" },
    delete: { type: "easeInEaseOut", property: "opacity" },
  });
}

function ChatThreadRow({
  thread,
  isLast,
  onPress,
}: {
  thread: MobileThreadSummary;
  isLast: boolean;
  onPress: () => void;
}) {
  const theme = useThreadHomeTheme();
  const preview =
    thread.preview && thread.preview !== "No activity yet." ? thread.preview : undefined;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: pressed ? theme.surfaceMuted : theme.surface,
      })}
    >
      <View
        style={{
          minHeight: preview ? 64 : 52,
          paddingHorizontal: 16,
          paddingVertical: preview ? 10 : 12,
          borderBottomWidth: isLast ? 0 : StyleSheet.hairlineWidth,
          borderBottomColor: theme.borderMuted,
          justifyContent: "center",
          gap: 3,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 11 }}>
          <SFSymbol name="bubble.left.fill" size={18} color={theme.primary} />
          <Text
            numberOfLines={1}
            selectable
            style={{
              flex: 1,
              color: theme.text,
              fontSize: 17,
              fontWeight: "400",
              fontFamily: theme.fontFamilySans,
            }}
          >
            {thread.title}
          </Text>
          <Text
            style={{
              color: theme.textTertiary,
              fontSize: 13,
              fontVariant: ["tabular-nums"],
              fontFamily: theme.fontFamilySans,
            }}
          >
            {formatThreadRelativeAge(thread.updatedAt)}
          </Text>
        </View>
        {preview ? (
          <Text
            numberOfLines={1}
            selectable
            style={{
              color: theme.textSecondary,
              fontSize: 13,
              paddingLeft: 29,
              fontFamily: theme.fontFamilySans,
            }}
          >
            {preview}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function LoadMoreRow({
  label,
  loading,
  error,
  onPress,
  isLast,
}: {
  label: string;
  loading?: boolean;
  error?: string | null;
  onPress: () => void;
  isLast: boolean;
}) {
  const theme = useThreadHomeTheme();
  const showError = Boolean(error) && !loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={loading}
      style={({ pressed }) => ({
        backgroundColor: pressed ? theme.surfaceMuted : theme.surface,
      })}
    >
      <View
        style={{
          minHeight: 48,
          paddingHorizontal: 16,
          paddingVertical: showError ? 10 : 0,
          borderBottomWidth: isLast ? 0 : StyleSheet.hairlineWidth,
          borderBottomColor: theme.borderMuted,
          flexDirection: showError ? "column" : "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 4,
        }}
      >
        {showError ? (
          <>
            <Text
              numberOfLines={2}
              style={{
                color: theme.danger,
                fontSize: 13,
                textAlign: "center",
                fontFamily: theme.fontFamilySans,
              }}
            >
              {error}
            </Text>
            <Text
              style={{
                color: theme.primary,
                fontSize: 15,
                fontWeight: "600",
                fontFamily: theme.fontFamilySans,
              }}
            >
              Try again
            </Text>
          </>
        ) : (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            {loading ? <ActivityIndicator size="small" color={theme.primary} /> : null}
            <Text style={{ color: theme.primary, fontSize: 15, fontWeight: "600" }}>{label}</Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}

function EmptyRow({ label }: { label: string }) {
  const theme = useThreadHomeTheme();
  return (
    <View style={{ minHeight: 52, paddingHorizontal: 16, justifyContent: "center" }}>
      <Text selectable style={{ color: theme.textSecondary, fontSize: 15 }}>
        {label}
      </Text>
    </View>
  );
}

function ProjectRow({
  group,
  loading,
  isLast,
  hasLoadMore,
  loadError,
  onToggleProject,
  onOpenThread,
  onLoadMore,
}: {
  group: ThreadHomeProjectGroup;
  loading: boolean;
  isLast: boolean;
  hasLoadMore: boolean;
  loadError: string | null;
  onToggleProject: () => void;
  onOpenThread: (threadId: string) => void;
  onLoadMore: () => void;
}) {
  const theme = useThreadHomeTheme();
  const showSelfSeparator = !isLast || group.expanded;

  return (
    <View>
      <Pressable
        onPress={onToggleProject}
        style={({ pressed }) => ({
          backgroundColor: pressed ? theme.surfaceMuted : theme.surface,
        })}
      >
        <View
          style={{
            minHeight: 54,
            paddingHorizontal: 16,
            borderBottomWidth: showSelfSeparator ? StyleSheet.hairlineWidth : 0,
            borderBottomColor: theme.borderMuted,
            flexDirection: "row",
            alignItems: "center",
            gap: 11,
          }}
        >
          <SFSymbol
            name={group.expanded ? "folder.fill" : "folder"}
            size={18}
            color={theme.primary}
          />
          <Text
            numberOfLines={1}
            selectable
            style={{
              flex: 1,
              color: theme.text,
              fontSize: 17,
              fontWeight: "400",
              fontFamily: theme.fontFamilySans,
            }}
          >
            {group.workspace.name}
          </Text>
          <Text
            style={{
              color: theme.textTertiary,
              fontSize: 13,
              fontVariant: ["tabular-nums"],
              fontFamily: theme.fontFamilySans,
            }}
          >
            {group.serverTotal ?? group.items.length}
          </Text>
          <SFSymbol
            name="chevron.right"
            size={13}
            color={theme.textTertiary}
            style={{ transform: [{ rotate: group.expanded ? "90deg" : "0deg" }] }}
          />
        </View>
      </Pressable>
      {group.expanded ? (
        <>
          {group.visibleItems.length === 0 ? (
            <View
              style={{
                paddingLeft: 45,
                paddingRight: 16,
                paddingVertical: 12,
                borderBottomWidth:
                  hasLoadMore || !isLast ? StyleSheet.hairlineWidth : 0,
                borderBottomColor: theme.borderMuted,
              }}
            >
              <Text style={{ color: theme.textSecondary, fontSize: 14 }}>No threads yet</Text>
            </View>
          ) : null}
          {group.visibleItems.map((thread, index) => {
            const threadIsLast =
              index === group.visibleItems.length - 1 && !hasLoadMore && isLast;
            return (
              <Pressable
                key={thread.id}
                onPress={() => onOpenThread(thread.id)}
                style={({ pressed }) => ({
                  backgroundColor: pressed ? theme.surfaceMuted : theme.surface,
                })}
              >
                <View
                  style={{
                    minHeight: 46,
                    paddingLeft: 45,
                    paddingRight: 16,
                    borderBottomWidth: threadIsLast ? 0 : StyleSheet.hairlineWidth,
                    borderBottomColor: theme.borderMuted,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 10,
                  }}
                >
                  <Text
                    numberOfLines={1}
                    selectable
                    style={{
                      flex: 1,
                      color: theme.text,
                      fontSize: 15,
                      fontFamily: theme.fontFamilySans,
                    }}
                  >
                    {thread.title}
                  </Text>
                  <Text
                    style={{
                      color: theme.textTertiary,
                      fontSize: 12,
                      fontVariant: ["tabular-nums"],
                      fontFamily: theme.fontFamilySans,
                    }}
                  >
                    {formatThreadRelativeAge(thread.updatedAt)}
                  </Text>
                </View>
              </Pressable>
            );
          })}
          {hasLoadMore ? (
            <LoadMoreRow
              label={
                loading
                  ? "Loading..."
                  : group.hiddenLoadedCount > 0
                    ? group.showAllThreads
                      ? "Show less"
                      : `Show ${group.hiddenLoadedCount} more`
                    : "Load more"
              }
              loading={loading}
              error={loadError}
              isLast={isLast}
              onPress={onLoadMore}
            />
          ) : null}
        </>
      ) : null}
    </View>
  );
}

function GroupedListContainer({ children }: { children: ReactNode }) {
  const theme = useThreadHomeTheme();
  return (
    <View
      style={{
        overflow: "hidden",
        borderRadius: 12,
        borderCurve: "continuous",
        backgroundColor: theme.surface,
      }}
    >
      {children}
    </View>
  );
}

function SectionHeader({ title }: { title: string }) {
  const theme = useThreadHomeTheme();
  return (
    <Text
      style={{
        color: theme.sectionHeader,
        fontSize: 13,
        fontWeight: "400",
        textTransform: "uppercase",
        letterSpacing: 0.4,
        paddingHorizontal: 16,
        paddingBottom: 6,
        fontFamily: theme.fontFamilySans,
      }}
    >
      {title}
    </Text>
  );
}

function ChatsSection({
  threadHome,
  router,
  chatsError,
  onChatsError,
}: {
  threadHome: ReturnType<typeof useThreadHome>;
  router: ReturnType<typeof useRouter>;
  chatsError: string | null;
  onChatsError: (error: string | null) => void;
}) {
  const { viewModel, homeLoadPending, loadMoreChats, refreshHome, toggleShowAllChats } = threadHome;
  const hasLoadMore = viewModel.hiddenChatCount > 0 || viewModel.canLoadMoreChatsFromServer;
  const showFooter = hasLoadMore || Boolean(chatsError);

  const handleLoadMore = useCallback(async () => {
    if (viewModel.hiddenChatCount > 0 && viewModel.showAllChats) {
      onChatsError(null);
      toggleShowAllChats();
      return;
    }
    onChatsError(null);
    try {
      if (hasLoadMore) {
        await runWithTimeout(loadMoreChats(), LOAD_TIMEOUT_MS);
      } else {
        await runWithTimeout(refreshHome(), LOAD_TIMEOUT_MS);
      }
    } catch (error) {
      onChatsError(describeLoadError(error));
    }
  }, [
    hasLoadMore,
    loadMoreChats,
    onChatsError,
    refreshHome,
    toggleShowAllChats,
    viewModel.hiddenChatCount,
    viewModel.showAllChats,
  ]);

  return (
    <View>
      <SectionHeader title="Chats" />
      <GroupedListContainer>
        {viewModel.chats.length === 0 ? (
          <EmptyRow label="No chats yet" />
        ) : (
          <>
            {viewModel.visibleChats.map((thread, index) => (
              <ChatThreadRow
                key={thread.id}
                thread={thread}
                isLast={index === viewModel.visibleChats.length - 1 && !showFooter}
                onPress={() => router.push(`/(app)/thread/${thread.id}` as const)}
              />
            ))}
            {showFooter ? (
              <LoadMoreRow
                label={
                  homeLoadPending.chats
                    ? "Loading..."
                    : viewModel.hiddenChatCount > 0
                      ? viewModel.showAllChats
                        ? "Show less"
                        : `Show ${viewModel.hiddenChatCount} more`
                      : hasLoadMore
                        ? "Load more chats"
                        : "Refresh"
                }
                loading={homeLoadPending.chats}
                error={chatsError}
                isLast
                onPress={() => {
                  void handleLoadMore();
                }}
              />
            ) : null}
          </>
        )}
      </GroupedListContainer>
    </View>
  );
}

function ProjectsSection({
  threadHome,
  router,
  projectErrors,
  setProjectError,
}: {
  threadHome: ReturnType<typeof useThreadHome>;
  router: ReturnType<typeof useRouter>;
  projectErrors: Record<string, string>;
  setProjectError: (workspaceId: string, error: string | null) => void;
}) {
  const {
    viewModel,
    homeLoadPending,
    toggleWorkspaceExpanded,
    expandWorkspace,
    loadMoreProject,
    toggleProjectThreadListExpanded,
  } = threadHome;

  return (
    <View>
      <SectionHeader title="Projects" />
      <GroupedListContainer>
        {viewModel.projects.length === 0 ? (
          <EmptyRow label="No projects yet" />
        ) : (
          viewModel.projects.map((group, index) => {
            const loading = homeLoadPending.projects[group.workspace.id] === true;
            const hasLoadMore = group.hiddenLoadedCount > 0 || group.canLoadMoreFromServer;
            const groupIsLast = index === viewModel.projects.length - 1;
            const projectError = projectErrors[group.workspace.id] ?? null;
            return (
              <ProjectRow
                key={group.workspace.id}
                group={group}
                loading={loading}
                isLast={groupIsLast}
                hasLoadMore={hasLoadMore}
                loadError={projectError}
                onToggleProject={() => {
                  animateListChange();
                  toggleWorkspaceExpanded(group.workspace.id);
                }}
                onOpenThread={(threadId) => {
                  expandWorkspace(group.workspace.id);
                  router.push(`/(app)/thread/${threadId}` as const);
                }}
                onLoadMore={async () => {
                  if (group.hiddenLoadedCount > 0 && group.showAllThreads) {
                    setProjectError(group.workspace.id, null);
                    toggleProjectThreadListExpanded(group.workspace.id);
                    return;
                  }
                  setProjectError(group.workspace.id, null);
                  try {
                    await runWithTimeout(
                      loadMoreProject(group.workspace.id),
                      LOAD_TIMEOUT_MS,
                    );
                  } catch (error) {
                    setProjectError(group.workspace.id, describeLoadError(error));
                  }
                }}
              />
            );
          })
        )}
      </GroupedListContainer>
    </View>
  );
}

function DisconnectedBanner({
  message,
  onPress,
}: {
  message: string;
  onPress: () => void;
}) {
  const theme = useThreadHomeTheme();
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
      })}
    >
      <SFSymbol name="exclamationmark.triangle.fill" size={20} color={theme.danger} />
      <View style={{ flex: 1 }}>
        <Text
          style={{
            color: theme.text,
            fontSize: 15,
            fontWeight: "600",
            fontFamily: theme.fontFamilySans,
          }}
        >
          Cowork Desktop disconnected
        </Text>
        <Text
          style={{
            color: theme.textSecondary,
            fontSize: 13,
            lineHeight: 18,
            marginTop: 2,
            fontFamily: theme.fontFamilySans,
          }}
        >
          {message}
        </Text>
      </View>
      <Text
        style={{
          color: theme.primary,
          fontSize: 15,
          fontWeight: "600",
          fontFamily: theme.fontFamilySans,
        }}
      >
        Re-pair
      </Text>
    </Pressable>
  );
}

function EmptyHomeState({ children }: { children: ReactNode }) {
  const theme = useThreadHomeTheme();
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
          fontFamily: theme.fontFamilySans,
        }}
      >
        {children}
      </Text>
    </View>
  );
}

export function ThreadHomeScreen() {
  const theme = useThreadHomeTheme();
  const router = useRouter();
  const threadHome = useThreadHome();
  const { viewModel, setSearchQuery, reorderSections, refreshHome } = threadHome;
  const [chatsError, setChatsError] = useState<string | null>(null);
  const [projectErrors, setProjectErrors] = useState<Record<string, string>>({});
  const [isRefreshing, setIsRefreshing] = useState(false);
  const connectionStatus = usePairingStore((state) => state.connectionState.status);
  const connectionLastError = usePairingStore((state) => state.connectionState.lastError);
  const hasTrustedDesktop = usePairingStore((state) => state.trustedMacs.length > 0);

  const projectsFirst = viewModel.sectionOrder[0] === "projects";
  const showDisconnectedBanner = connectionStatus === "error" && hasTrustedDesktop;
  const disconnectedMessage =
    connectionLastError ??
    "Tap to open Remote access and reconnect.";

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
      router.push(`/(app)/thread/${draftId}` as const);
    }
  }, [router]);

  const handleToggleSectionOrder = useCallback(() => {
    animateListChange();
    reorderSections(0, 2);
  }, [reorderSections]);

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

  const renderSection = (section: HomeSectionKey) => {
    if (section === "chats") {
      return (
        <ChatsSection
          key="chats"
          threadHome={threadHome}
          router={router}
          chatsError={chatsError}
          onChatsError={setChatsError}
        />
      );
    }
    return (
      <ProjectsSection
        key="projects"
        threadHome={threadHome}
        router={router}
        projectErrors={projectErrors}
        setProjectError={setProjectError}
      />
    );
  };

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
          {SETTINGS_ACTIONS.map((action) => (
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
            onPress={handleToggleSectionOrder}
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
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.backgroundMuted }}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 8,
          paddingBottom: 110,
          gap: 26,
        }}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor={theme.textSecondary}
          />
        }
      >
        {showDisconnectedBanner ? (
          <DisconnectedBanner
            message={disconnectedMessage}
            onPress={() => router.push("/(pairing)")}
          />
        ) : null}
        {viewModel.isEmpty ? (
          <EmptyHomeState>
            {viewModel.searchQuery
              ? "No thread matches the current search."
              : "Threads will appear here when you start a conversation."}
          </EmptyHomeState>
        ) : (
          viewModel.sectionOrder.map((section) => renderSection(section))
        )}
      </ScrollView>
    </Fragment>
  );
}
