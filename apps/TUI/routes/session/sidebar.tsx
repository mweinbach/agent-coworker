import { For, Show, createMemo } from "solid-js";
import { useTheme } from "../../context/theme";
import { useSyncState } from "../../context/sync";
import { TodoItem } from "../../component/todo-item";

const SIDEBAR_WIDTH = 42;

function formatTokenCount(value: number | null): string {
  if (value === null) return "n/a";
  return value.toLocaleString();
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "n/a";
  if (value < 1024) return `${value} B`;
  const kb = value / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

export function SessionSidebar() {
  const theme = useTheme();
  const syncState = useSyncState();

  const activeTodos = createMemo(() =>
    syncState.todos.filter((t) => t.status !== "completed")
  );

  const completedTodos = createMemo(() =>
    syncState.todos.filter((t) => t.status === "completed")
  );
  const contextUsage = createMemo(() => syncState.contextUsage);
  const enabledSkillsCount = createMemo(() => syncState.skills.filter((skill) => skill.enabled).length);
  const backup = createMemo(() => syncState.backup);
  const latestCheckpoint = createMemo(() => {
    const checkpoints = backup()?.checkpoints ?? [];
    if (checkpoints.length === 0) return null;
    return checkpoints[checkpoints.length - 1] ?? null;
  });

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
          <Show
            when={contextUsage()}
            fallback={<text fg={theme.textMuted}>usage: n/a</text>}
          >
            {(usage) => (
              <text fg={theme.textMuted}>
                usage in/out/total: {formatTokenCount(usage().inputTokens)}/{formatTokenCount(usage().outputTokens)}/{formatTokenCount(usage().totalTokens)}
              </text>
            )}
          </Show>
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

      {/* MCP Section */}
      <box flexDirection="column" marginBottom={1}>
        <text fg={theme.text}>
          <strong>MCP</strong>
        </text>
        <box paddingLeft={1} flexDirection="column">
          <text fg={syncState.enableMcp ? theme.success : theme.warning}>
            {syncState.enableMcp ? "enabled" : "disabled"}
          </text>
          <text fg={theme.textMuted}>
            {syncState.tools.length} tools
          </text>
        </box>
      </box>

      {/* Skills Section */}
      <box flexDirection="column" marginBottom={1}>
        <text fg={theme.text}>
          <strong>Skills</strong>
        </text>
        <box paddingLeft={1} flexDirection="column">
          <text fg={theme.textMuted}>
            {enabledSkillsCount()}/{syncState.skills.length} enabled
          </text>
        </box>
      </box>

      {/* Backup Section */}
      <Show when={backup()}>
        {(backupState) => (
          <box flexDirection="column" marginBottom={1}>
            <text fg={theme.text}>
              <strong>Backup</strong>
            </text>
            <box paddingLeft={1} flexDirection="column">
              <text fg={theme.textMuted}>status: {backupState().status}</text>
              <text fg={theme.textMuted}>checkpoints: {backupState().checkpoints.length}</text>
              <Show when={latestCheckpoint()}>
                {(checkpoint) => (
                  <text fg={theme.textMuted}>
                    latest: {checkpoint().id} ({formatBytes(checkpoint().patchBytes)})
                  </text>
                )}
              </Show>
            </box>
          </box>
        )}
      </Show>

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
