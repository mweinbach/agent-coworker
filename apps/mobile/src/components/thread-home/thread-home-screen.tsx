import { Stack, useRouter } from "expo-router";
import { Fragment } from "react";
import { ActivityIndicator, LayoutAnimation, Platform, Pressable, StyleSheet, Text, UIManager, View } from "react-native";

import {
  GroupedRow,
  GroupedScreen,
  GroupedSection,
} from "@/components/pairing/grouped-list";
import { SFSymbol } from "@/components/ui/sf-symbol";
import {
  formatThreadRelativeAge,
  type HomeSectionKey,
  type ThreadHomeProjectGroup,
} from "@/features/cowork/threadHomeModel";
import type { MobileThreadSummary } from "@/features/cowork/threadStore";
import { useThreadHome } from "@/features/cowork/useThreadHome";
import { useAppTheme } from "@/theme/use-app-theme";

if (Platform.OS === "android") {
  UIManager.setLayoutAnimationEnabledExperimental?.(true);
}

const SETTINGS_ACTIONS = [
  { title: "Settings", icon: "slider.horizontal.3", href: "/(app)/settings" },
  { title: "Workspace", icon: "square.grid.2x2", href: "/(app)/(tabs)/workspace" },
  { title: "Skills", icon: "sparkles", href: "/(app)/(tabs)/skills" },
  { title: "Remote access", icon: "iphone.and.arrow.forward", href: "/(pairing)" },
] as const;

function animateListChange() {
  LayoutAnimation.configureNext({
    duration: 180,
    create: { type: "easeInEaseOut", property: "opacity" },
    update: { type: "easeInEaseOut" },
    delete: { type: "easeInEaseOut", property: "opacity" },
  });
}

function SectionToggle({
  title,
  open,
  onToggle,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
}) {
  const theme = useAppTheme();
  return (
    <Pressable
      onPress={() => {
        animateListChange();
        onToggle();
      }}
      style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1 }}
    >
      <SFSymbol
        name="chevron.right"
        size={12}
        color={theme.textTertiary}
        style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}
      />
      <Text
        style={{
          color: theme.textSecondary,
          fontSize: 13,
          fontWeight: "400",
          textTransform: "uppercase",
          letterSpacing: 0.2,
        }}
      >
        {title}
      </Text>
    </Pressable>
  );
}

function ChatRow({
  thread,
  isLast,
  onPress,
}: {
  thread: MobileThreadSummary;
  isLast: boolean;
  onPress: () => void;
}) {
  const theme = useAppTheme();
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
          minHeight: preview ? 58 : 44,
          justifyContent: "center",
          paddingHorizontal: 16,
          paddingVertical: preview ? 10 : 12,
          borderBottomWidth: isLast ? 0 : StyleSheet.hairlineWidth,
          borderBottomColor: theme.borderMuted,
          gap: 2,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <SFSymbol name="bubble.left.fill" size={18} color={theme.textSecondary} />
          <Text
            numberOfLines={1}
            selectable
            style={{
              color: theme.text,
              fontSize: 17,
              fontWeight: "400",
              fontFamily: theme.fontFamilySans,
              flex: 1,
            }}
          >
            {thread.title}
          </Text>
          <Text
            style={{
              color: theme.textTertiary,
              fontSize: 13,
              fontVariant: ["tabular-nums"],
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
              paddingLeft: 28,
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
  onPress,
  isLast = true,
}: {
  label: string;
  loading?: boolean;
  onPress: () => void;
  isLast?: boolean;
}) {
  const theme = useAppTheme();
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
          minHeight: 44,
          justifyContent: "center",
          alignItems: "center",
          paddingHorizontal: 16,
          paddingVertical: 12,
          borderBottomWidth: isLast ? 0 : StyleSheet.hairlineWidth,
          borderBottomColor: theme.borderMuted,
          flexDirection: "row",
          gap: 8,
        }}
      >
        {loading ? <ActivityIndicator size="small" color={theme.primary} /> : null}
        <Text style={{ color: theme.primary, fontSize: 15, fontWeight: "600" }}>{label}</Text>
      </View>
    </Pressable>
  );
}

function ProjectSection({
  group,
  loading,
  onToggleProject,
  onOpenThread,
  onLoadMore,
}: {
  group: ThreadHomeProjectGroup;
  loading: boolean;
  onToggleProject: () => void;
  onOpenThread: (threadId: string) => void;
  onLoadMore: () => void;
}) {
  const theme = useAppTheme();
  return (
    <View style={{ gap: 8 }}>
      <Pressable
        onPress={() => {
          animateListChange();
          onToggleProject();
        }}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingHorizontal: 4,
          paddingVertical: 4,
          opacity: pressed ? 0.8 : 1,
        })}
      >
        <SFSymbol
          name="chevron.right"
          size={12}
          color={theme.textTertiary}
          style={{ transform: [{ rotate: group.expanded ? "90deg" : "0deg" }] }}
        />
        <SFSymbol
          name={group.expanded ? "folder.fill" : "folder"}
          size={17}
          color={theme.primary}
        />
        <Text
          numberOfLines={1}
          style={{
            color: theme.text,
            fontSize: 17,
            fontWeight: "400",
            fontFamily: theme.fontFamilySans,
            flex: 1,
          }}
        >
          {group.workspace.name}
        </Text>
        <Text style={{ color: theme.textTertiary, fontSize: 13, fontVariant: ["tabular-nums"] }}>
          {group.serverTotal ?? group.items.length}
        </Text>
      </Pressable>
      {group.expanded ? (
        <View
          style={{
            overflow: "hidden",
            borderRadius: 10,
            borderCurve: "continuous",
            backgroundColor: theme.surface,
          }}
        >
          {group.visibleItems.map((thread, index) => (
            <Pressable
              key={thread.id}
              onPress={() => onOpenThread(thread.id)}
              style={({ pressed }) => ({
                backgroundColor: pressed ? theme.surfaceMuted : theme.surface,
              })}
            >
              <View
                style={{
                  minHeight: 44,
                  justifyContent: "center",
                  paddingLeft: 28,
                  paddingRight: 16,
                  paddingVertical: 10,
                  borderBottomWidth:
                    index === group.visibleItems.length - 1 &&
                    group.hiddenLoadedCount === 0 &&
                    !group.canLoadMoreFromServer
                      ? 0
                      : StyleSheet.hairlineWidth,
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
                    color: theme.text,
                    fontSize: 15,
                    fontWeight: "400",
                    fontFamily: theme.fontFamilySans,
                    flex: 1,
                  }}
                >
                  {thread.title}
                </Text>
                <Text
                  style={{
                    color: theme.textTertiary,
                    fontSize: 12,
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {formatThreadRelativeAge(thread.updatedAt)}
                </Text>
              </View>
            </Pressable>
          ))}
          {group.hiddenLoadedCount > 0 || group.canLoadMoreFromServer ? (
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
              onPress={onLoadMore}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function renderSection(
  section: HomeSectionKey,
  props: ReturnType<typeof useThreadHome> & { router: ReturnType<typeof useRouter> },
) {
  const { viewModel, homeLoadPending, toggleSection, loadMoreChats, loadMoreProject, toggleWorkspaceExpanded, expandWorkspace, toggleShowAllChats, router } =
    props;

  if (section === "chats") {
    return (
      <GroupedSection
        key="chats"
        title=""
        action={
          <SectionToggle
            title="Chats"
            open={viewModel.sectionsOpen.chats}
            onToggle={() => toggleSection("chats")}
          />
        }
      >
        {viewModel.sectionsOpen.chats ? (
          viewModel.chats.length === 0 ? (
            <GroupedRow label="No chats yet" isLast />
          ) : (
            <>
              {viewModel.visibleChats.map((thread, index) => (
                <ChatRow
                  key={thread.id}
                  thread={thread}
                  isLast={
                    index === viewModel.visibleChats.length - 1 &&
                    viewModel.hiddenChatCount === 0 &&
                    !viewModel.canLoadMoreChatsFromServer
                  }
                  onPress={() => router.push(`/(app)/thread/${thread.id}` as const)}
                />
              ))}
              {viewModel.hiddenChatCount > 0 || viewModel.canLoadMoreChatsFromServer ? (
                <LoadMoreRow
                  label={
                    homeLoadPending.chats
                      ? "Loading..."
                      : viewModel.hiddenChatCount > 0
                        ? viewModel.showAllChats
                          ? "Show less"
                          : `Show ${viewModel.hiddenChatCount} more`
                        : "Load more chats"
                  }
                  loading={homeLoadPending.chats}
                  onPress={() => {
                    if (viewModel.hiddenChatCount > 0 && viewModel.showAllChats) {
                      toggleShowAllChats();
                      return;
                    }
                    void loadMoreChats();
                  }}
                />
              ) : null}
            </>
          )
        ) : null}
      </GroupedSection>
    );
  }

  return (
    <GroupedSection
      key="projects"
      title=""
      action={
        <SectionToggle
          title="Projects"
          open={viewModel.sectionsOpen.projects}
          onToggle={() => toggleSection("projects")}
        />
      }
    >
      {viewModel.sectionsOpen.projects ? (
        viewModel.projects.length === 0 ? (
          <GroupedRow label="No projects yet" isLast />
        ) : (
          <View style={{ gap: 14, padding: 12 }}>
            {viewModel.projects.map((group) => (
              <ProjectSection
                key={group.workspace.id}
                group={group}
                loading={homeLoadPending.projects[group.workspace.id] === true}
                onToggleProject={() => toggleWorkspaceExpanded(group.workspace.id)}
                onOpenThread={(threadId) => {
                  expandWorkspace(group.workspace.id);
                  router.push(`/(app)/thread/${threadId}` as const);
                }}
                onLoadMore={() => {
                  if (group.hiddenLoadedCount > 0 && group.showAllThreads) {
                    props.toggleProjectThreadListExpanded(group.workspace.id);
                    return;
                  }
                  void loadMoreProject(group.workspace.id);
                }}
              />
            ))}
          </View>
        )
      ) : null}
    </GroupedSection>
  );
}

export function ThreadHomeScreen() {
  const theme = useAppTheme();
  const router = useRouter();
  const threadHome = useThreadHome();
  const { viewModel, setSearchQuery } = threadHome;

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
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      <GroupedScreen contentStyle={{ paddingTop: 8 }}>
        {viewModel.isEmpty ? (
          <Text
            style={{
              color: theme.textSecondary,
              fontSize: 14,
              lineHeight: 21,
              padding: 32,
              textAlign: "center",
              fontFamily: theme.fontFamilySans,
            }}
          >
            {viewModel.searchQuery
              ? "No thread matches the current search."
              : "Threads will appear here when you start a conversation."}
          </Text>
        ) : (
          viewModel.sectionOrder.map((section) =>
            renderSection(section, { ...threadHome, router }),
          )
        )}
      </GroupedScreen>
    </Fragment>
  );
}
