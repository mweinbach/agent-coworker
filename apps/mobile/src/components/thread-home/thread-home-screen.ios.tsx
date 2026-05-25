import {
  Button,
  Host,
  HStack,
  List,
  Section,
  Spacer,
  Text,
  VStack,
} from "@expo/ui/swift-ui";
import {
  buttonStyle,
  controlSize,
  font,
  foregroundStyle,
  frame,
  labelStyle,
  listRowSeparator,
  listStyle,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { Stack, useRouter } from "expo-router";
import { Fragment } from "react";

import {
  formatThreadRelativeAge,
  type HomeSectionKey,
  type ThreadHomeProjectGroup,
} from "@/features/cowork/threadHomeModel";
import type { MobileThreadSummary } from "@/features/cowork/threadStore";
import { useThreadHome } from "@/features/cowork/useThreadHome";
import { useAppTheme } from "@/theme/use-app-theme";

const SETTINGS_ACTIONS = [
  { title: "Settings", icon: "slider.horizontal.3", href: "/(app)/settings" },
  { title: "Workspace", icon: "square.grid.2x2", href: "/(app)/(tabs)/workspace" },
  { title: "Skills", icon: "sparkles", href: "/(app)/(tabs)/skills" },
  { title: "Remote access", icon: "iphone.and.arrow.forward", href: "/(pairing)" },
] as const;

function SectionHeaderControls({
  title,
  open,
  onToggle,
  onReorder,
  mutedColor,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  onReorder: () => void;
  mutedColor: string;
}) {
  return (
    <HStack spacing={8}>
      <Button
        label={title}
        systemImage={open ? "chevron.down" : "chevron.right"}
        onPress={onToggle}
        modifiers={[buttonStyle("plain"), tint(mutedColor), controlSize("small")]}
      />
      <Spacer />
      <Button
        label="Reorder"
        systemImage="arrow.up.arrow.down"
        onPress={onReorder}
        modifiers={[buttonStyle("plain"), tint(mutedColor), controlSize("small")]}
      />
    </HStack>
  );
}

function ChatThreadRow({
  thread,
  onPress,
}: {
  thread: MobileThreadSummary;
  onPress: () => void;
}) {
  const preview =
    thread.preview && thread.preview !== "No activity yet." ? thread.preview : null;
  return (
    <Button onPress={onPress} modifiers={[buttonStyle("plain")]}>
      <HStack alignment="center" spacing={12}>
        <Button
          label=""
          systemImage="bubble.left.fill"
          modifiers={[buttonStyle("plain"), controlSize("small")]}
        />
        <VStack alignment="leading" spacing={2}>
          <Text modifiers={[font({ size: 17, weight: "regular" })]}>{thread.title}</Text>
          {preview ? (
            <Text modifiers={[font({ size: 13 }), foregroundStyle("secondary")]}>{preview}</Text>
          ) : null}
        </VStack>
        <Spacer />
        <Text modifiers={[font({ size: 13 }), foregroundStyle("secondary")]}>
          {formatThreadRelativeAge(thread.updatedAt)}
        </Text>
      </HStack>
    </Button>
  );
}

function ProjectGroupSection({
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
  const countLabel = String(group.serverTotal ?? group.items.length);
  return (
    <Section>
      <Button
        label={group.workspace.name}
        systemImage={group.expanded ? "folder.fill" : "folder"}
        onPress={onToggleProject}
        modifiers={[buttonStyle("plain"), labelStyle("titleAndIcon")]}
      />
      <Text modifiers={[foregroundStyle("secondary")]}>{countLabel}</Text>
      {group.expanded
        ? group.visibleItems.map((thread) => (
            <Button
              key={thread.id}
              label={thread.title}
              onPress={() => onOpenThread(thread.id)}
              modifiers={[buttonStyle("plain")]}
            />
          ))
        : null}
      {group.expanded && (group.hiddenLoadedCount > 0 || group.canLoadMoreFromServer) ? (
        <Button
          label={
            loading
              ? "Loading..."
              : group.hiddenLoadedCount > 0
                ? group.showAllThreads
                  ? "Show less"
                  : `Show ${group.hiddenLoadedCount} more`
                : "Load more"
          }
          onPress={onLoadMore}
          modifiers={[buttonStyle("plain"), tint("#6f8042")]}
        />
      ) : null}
    </Section>
  );
}

function renderIosSection(
  section: HomeSectionKey,
  props: ReturnType<typeof useThreadHome> & { router: ReturnType<typeof useRouter> },
  mutedColor: string,
) {
  const {
    viewModel,
    homeLoadPending,
    toggleSection,
    toggleSectionOrder,
    loadMoreChats,
    loadMoreProject,
    toggleWorkspaceExpanded,
    expandWorkspace,
    toggleShowAllChats,
    toggleProjectThreadListExpanded,
    router,
  } = props;

  if (section === "chats") {
    return (
      <Section key="chats">
        <SectionHeaderControls
          title="Chats"
          open={viewModel.sectionsOpen.chats}
          onToggle={() => toggleSection("chats")}
          onReorder={toggleSectionOrder}
          mutedColor={mutedColor}
        />
        {viewModel.sectionsOpen.chats ? (
          viewModel.chats.length === 0 ? (
            <Text modifiers={[foregroundStyle("secondary")]}>No chats yet</Text>
          ) : (
            <>
              {viewModel.visibleChats.map((thread) => (
                <ChatThreadRow
                  key={thread.id}
                  thread={thread}
                  onPress={() => router.push(`/(app)/thread/${thread.id}` as const)}
                />
              ))}
              {viewModel.hiddenChatCount > 0 || viewModel.canLoadMoreChatsFromServer ? (
                <Button
                  label={
                    homeLoadPending.chats
                      ? "Loading..."
                      : viewModel.hiddenChatCount > 0
                        ? viewModel.showAllChats
                          ? "Show less"
                          : `Show ${viewModel.hiddenChatCount} more`
                        : "Load more chats"
                  }
                  onPress={() => {
                    if (viewModel.hiddenChatCount > 0 && viewModel.showAllChats) {
                      toggleShowAllChats();
                      return;
                    }
                    void loadMoreChats();
                  }}
                  modifiers={[buttonStyle("plain"), tint("#6f8042")]}
                />
              ) : null}
            </>
          )
        ) : null}
      </Section>
    );
  }

  return (
    <Section key="projects">
      <SectionHeaderControls
        title="Projects"
        open={viewModel.sectionsOpen.projects}
        onToggle={() => toggleSection("projects")}
        onReorder={toggleSectionOrder}
        mutedColor={mutedColor}
      />
      {viewModel.sectionsOpen.projects ? (
        viewModel.projects.length === 0 ? (
          <Text modifiers={[foregroundStyle("secondary")]}>No projects yet</Text>
        ) : (
          viewModel.projects.map((group) => (
            <ProjectGroupSection
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
                  toggleProjectThreadListExpanded(group.workspace.id);
                  return;
                }
                void loadMoreProject(group.workspace.id);
              }}
            />
          ))
        )
      ) : null}
    </Section>
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
      <Host
        useViewportSizeMeasurement
        colorScheme={theme.isDark ? "dark" : "light"}
        style={{ flex: 1 }}
      >
        <List
          modifiers={[
            listStyle("insetGrouped"),
            tint(theme.primary),
            listRowSeparator("automatic"),
          ]}
        >
          {viewModel.isEmpty ? (
            <Section>
              <Text modifiers={[foregroundStyle("secondary")]}>
                {viewModel.searchQuery
                  ? "No thread matches the current search."
                  : "Threads will appear here when you start a conversation."}
              </Text>
            </Section>
          ) : (
            viewModel.sectionOrder.map((section) =>
              renderIosSection(section, { ...threadHome, router }, theme.textSecondary),
            )
          )}
        </List>
      </Host>
    </Fragment>
  );
}
