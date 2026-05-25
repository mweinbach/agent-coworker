import {
  Button,
  DisclosureGroup,
  Host,
  HStack,
  Image,
  List,
  Spacer,
  Text,
  VStack,
} from "@expo/ui/swift-ui";
import {
  buttonStyle,
  environment,
  font,
  foregroundStyle,
  listRowInsets,
  listRowSeparator,
  listStyle,
  tag,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { Stack, useRouter } from "expo-router";
import { Fragment, useCallback } from "react";

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

function ChatThreadRow({
  thread,
  onPress,
  iconColor,
}: {
  thread: MobileThreadSummary;
  onPress: () => void;
  iconColor: string;
}) {
  const preview =
    thread.preview && thread.preview !== "No activity yet." ? thread.preview : null;

  return (
    <Button onPress={onPress} modifiers={[buttonStyle("plain")]}>
      <HStack alignment="center" spacing={12}>
        <Image systemName="bubble.left.fill" size={18} color={iconColor} />
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

function ProjectHeaderRow({
  group,
  onToggle,
  iconColor,
}: {
  group: ThreadHomeProjectGroup;
  onToggle: () => void;
  iconColor: string;
}) {
  const countLabel = String(group.serverTotal ?? group.items.length);

  return (
    <Button onPress={onToggle} modifiers={[buttonStyle("plain")]}>
      <HStack alignment="center" spacing={12}>
        <Image
          systemName={group.expanded ? "folder.fill" : "folder"}
          size={18}
          color={iconColor}
        />
        <Text modifiers={[font({ size: 17, weight: "regular" })]}>{group.workspace.name}</Text>
        <Spacer />
        <Text modifiers={[font({ size: 15 }), foregroundStyle("secondary")]}>{countLabel}</Text>
      </HStack>
    </Button>
  );
}

function ProjectThreadRow({
  thread,
  onPress,
}: {
  thread: MobileThreadSummary;
  onPress: () => void;
}) {
  return (
    <Button
      onPress={onPress}
      modifiers={[buttonStyle("plain"), listRowInsets({ leading: 36 })]}
    >
      <HStack alignment="center" spacing={12}>
        <Text modifiers={[font({ size: 16, weight: "regular" })]}>{thread.title}</Text>
        <Spacer />
        <Text modifiers={[font({ size: 13 }), foregroundStyle("secondary")]}>
          {formatThreadRelativeAge(thread.updatedAt)}
        </Text>
      </HStack>
    </Button>
  );
}

function LoadMoreButton({
  label,
  onPress,
  accentColor,
}: {
  label: string;
  onPress: () => void;
  accentColor: string;
}) {
  return (
    <Button
      label={label}
      onPress={onPress}
      modifiers={[buttonStyle("plain"), tint(accentColor), listRowInsets({ leading: 16 })]}
    />
  );
}

function ChatsSectionContent({
  threadHome,
  router,
  accentColor,
  iconColor,
}: {
  threadHome: ReturnType<typeof useThreadHome>;
  router: ReturnType<typeof useRouter>;
  accentColor: string;
  iconColor: string;
}) {
  const { viewModel, homeLoadPending, loadMoreChats, toggleShowAllChats } = threadHome;

  if (viewModel.chats.length === 0) {
    return <Text modifiers={[foregroundStyle("secondary")]}>No chats yet</Text>;
  }

  return (
    <>
      {viewModel.visibleChats.map((thread) => (
        <ChatThreadRow
          key={thread.id}
          thread={thread}
          iconColor={iconColor}
          onPress={() => router.push(`/(app)/thread/${thread.id}` as const)}
        />
      ))}
      {viewModel.hiddenChatCount > 0 || viewModel.canLoadMoreChatsFromServer ? (
        <LoadMoreButton
          label={
            homeLoadPending.chats
              ? "Loading..."
              : viewModel.hiddenChatCount > 0
                ? viewModel.showAllChats
                  ? "Show less"
                  : `Show ${viewModel.hiddenChatCount} more`
                : "Load more chats"
          }
          accentColor={accentColor}
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
  );
}

function ProjectsSectionContent({
  threadHome,
  router,
  accentColor,
  iconColor,
}: {
  threadHome: ReturnType<typeof useThreadHome>;
  router: ReturnType<typeof useRouter>;
  accentColor: string;
  iconColor: string;
}) {
  const {
    viewModel,
    homeLoadPending,
    toggleWorkspaceExpanded,
    expandWorkspace,
    loadMoreProject,
    toggleProjectThreadListExpanded,
  } = threadHome;

  if (viewModel.projects.length === 0) {
    return <Text modifiers={[foregroundStyle("secondary")]}>No projects yet</Text>;
  }

  return (
    <>
      {viewModel.projects.flatMap((group) => {
        const loading = homeLoadPending.projects[group.workspace.id] === true;
        const rows = [
          <ProjectHeaderRow
            key={`${group.workspace.id}-header`}
            group={group}
            iconColor={iconColor}
            onToggle={() => toggleWorkspaceExpanded(group.workspace.id)}
          />,
        ];

        if (group.expanded) {
          rows.push(
            ...group.visibleItems.map((thread) => (
              <ProjectThreadRow
                key={thread.id}
                thread={thread}
                onPress={() => {
                  expandWorkspace(group.workspace.id);
                  router.push(`/(app)/thread/${thread.id}` as const);
                }}
              />
            )),
          );

          if (group.hiddenLoadedCount > 0 || group.canLoadMoreFromServer) {
            rows.push(
              <LoadMoreButton
                key={`${group.workspace.id}-load-more`}
                label={
                  loading
                    ? "Loading..."
                    : group.hiddenLoadedCount > 0
                      ? group.showAllThreads
                        ? "Show less"
                        : `Show ${group.hiddenLoadedCount} more`
                      : "Load more"
                }
                accentColor={accentColor}
                onPress={() => {
                  if (group.hiddenLoadedCount > 0 && group.showAllThreads) {
                    toggleProjectThreadListExpanded(group.workspace.id);
                    return;
                  }
                  void loadMoreProject(group.workspace.id);
                }}
              />,
            );
          }
        }

        return rows;
      })}
    </>
  );
}

function HomeSectionBlock({
  section,
  threadHome,
  router,
  accentColor,
  iconColor,
}: {
  section: HomeSectionKey;
  threadHome: ReturnType<typeof useThreadHome>;
  router: ReturnType<typeof useRouter>;
  accentColor: string;
  iconColor: string;
}) {
  const { viewModel, setSectionOpen } = threadHome;
  const title = section === "chats" ? "Chats" : "Projects";
  const isOpen = viewModel.sectionsOpen[section];

  return (
    <DisclosureGroup
      label={title}
      isExpanded={isOpen}
      onIsExpandedChange={(open) => setSectionOpen(section, open)}
      modifiers={[tag(section)]}
    >
      {section === "chats" ? (
        <ChatsSectionContent
          threadHome={threadHome}
          router={router}
          accentColor={accentColor}
          iconColor={iconColor}
        />
      ) : (
        <ProjectsSectionContent
          threadHome={threadHome}
          router={router}
          accentColor={accentColor}
          iconColor={iconColor}
        />
      )}
    </DisclosureGroup>
  );
}

export function ThreadHomeScreen() {
  const theme = useAppTheme();
  const router = useRouter();
  const threadHome = useThreadHome();
  const { viewModel, setSearchQuery, reorderSections } = threadHome;

  const handleSectionMove = useCallback(
    (sourceIndices: number[], destination: number) => {
      reorderSections(sourceIndices[0] ?? 0, destination);
    },
    [reorderSections],
  );

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
            environment("editMode", "active"),
          ]}
        >
          {viewModel.isEmpty ? (
            <Text modifiers={[foregroundStyle("secondary"), listRowInsets({ leading: 16 })]}>
              {viewModel.searchQuery
                ? "No thread matches the current search."
                : "Threads will appear here when you start a conversation."}
            </Text>
          ) : (
            <List.ForEach onMove={handleSectionMove}>
              {viewModel.sectionOrder.map((section) => (
                <HomeSectionBlock
                  key={section}
                  section={section}
                  threadHome={threadHome}
                  router={router}
                  accentColor={theme.primary}
                  iconColor={theme.textSecondary}
                />
              ))}
            </List.ForEach>
          )}
        </List>
      </Host>
    </Fragment>
  );
}
