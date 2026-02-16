import type { TodoItem as TodoItemType } from "../../../src/types";
import { useTheme } from "../context/theme";

export function TodoItem(props: { todo: TodoItemType }) {
  const theme = useTheme();

  const icon = () => {
    switch (props.todo.status) {
      case "completed":
        return "✓";
      case "in_progress":
        return "▸";
      case "pending":
      default:
        return "○";
    }
  };

  const color = () => {
    switch (props.todo.status) {
      case "completed":
        return theme.success;
      case "in_progress":
        return theme.accent;
      case "pending":
      default:
        return theme.textMuted;
    }
  };

  const label = () => {
    if (props.todo.status === "in_progress") return props.todo.activeForm;
    return props.todo.content;
  };

  return (
    <box flexDirection="row" gap={1}>
      <text fg={color()}>{icon()}</text>
      <text fg={props.todo.status === "completed" ? theme.textMuted : theme.text}>
        {label()}
      </text>
    </box>
  );
}
