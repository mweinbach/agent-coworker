import { For, Show, createMemo } from "solid-js";
import { useTheme } from "../../context/theme";
import { useSyncState } from "../../context/sync";
import { TodoItem } from "../../component/todo-item";

const SIDEBAR_WIDTH = 42;

export function SessionSidebar() {
  const theme = useTheme();
  const syncState = useSyncState();

  const activeTodos = createMemo(() =>
    syncState.todos.filter((t) => t.status !== "completed")
  );

  const completedTodos = createMemo(() =>
    syncState.todos.filter((t) => t.status === "completed")
  );

  return (
    <box
      width={SIDEBAR_WIDTH}
      flexShrink={0}
      flexDirection="column"
      border={["left"]}
      borderColor={theme.borderSubtle}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
    >
      {/* Context Section */}
      <box flexDirection="column" marginBottom={1}>
        <text fg={theme.text}>
          <strong>Context</strong>
        </text>
        <box paddingLeft={1} flexDirection="column">
          <text fg={theme.textMuted}>
            {syncState.provider}/{syncState.model}
          </text>
        </box>
      </box>

      {/* Status Section */}
      <box flexDirection="column" marginBottom={1}>
        <text fg={theme.text}>
          <strong>Status</strong>
        </text>
        <box paddingLeft={1} flexDirection="column">
          <box flexDirection="row" gap={1}>
            <text fg={syncState.status === "connected" ? theme.success : theme.error}>●</text>
            <text fg={theme.textMuted}>{syncState.status}</text>
          </box>
          <Show when={syncState.busy}>
            <text fg={theme.warning}>▸ working...</text>
          </Show>
        </box>
      </box>

      {/* Todos Section */}
      <Show when={syncState.todos.length > 0}>
        <box flexDirection="column" marginBottom={1}>
          <text fg={theme.text}>
            <strong>Todos</strong>
          </text>
          <box paddingLeft={1} flexDirection="column">
            <For each={activeTodos()}>
              {(todo) => <TodoItem todo={todo} />}
            </For>
            <Show when={completedTodos().length > 0}>
              <text fg={theme.textMuted}>
                {completedTodos().length} completed
              </text>
            </Show>
          </box>
        </box>
      </Show>

      {/* Feed Stats */}
      <box flexDirection="column" marginBottom={1}>
        <text fg={theme.text}>
          <strong>Activity</strong>
        </text>
        <box paddingLeft={1}>
          <text fg={theme.textMuted}>
            {syncState.feed.length} items in feed
          </text>
        </box>
      </box>

      {/* Spacer */}
      <box flexGrow={1} />

      {/* Help hint */}
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>
          Ctrl+K command palette
        </text>
      </box>
    </box>
  );
}
