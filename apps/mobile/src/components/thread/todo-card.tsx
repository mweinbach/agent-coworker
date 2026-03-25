import { Text, View } from "react-native";

import { useAppTheme } from "@/theme/use-app-theme";

type TodoItem = {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
};

type TodoCardProps = {
  todos: TodoItem[];
};

function statusIcon(status: TodoItem["status"]): string {
  switch (status) {
    case "completed":
      return "\u2713"; // checkmark
    case "in_progress":
      return "\u25CB"; // circle
    case "pending":
      return "\u2022"; // bullet
  }
}

function statusColor(status: TodoItem["status"], theme: ReturnType<typeof useAppTheme>): string {
  switch (status) {
    case "completed":
      return theme.success;
    case "in_progress":
      return theme.warning;
    case "pending":
      return theme.textTertiary;
  }
}

export function TodoCard({ todos }: TodoCardProps) {
  const theme = useAppTheme();

  return (
    <View
      style={{
        gap: 8,
        borderRadius: 22,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: theme.border,
        backgroundColor: theme.surface,
        paddingHorizontal: 16,
        paddingVertical: 14,
      }}
    >
      <Text
        style={{
          color: theme.success,
          fontSize: 11,
          fontWeight: "700",
          letterSpacing: 0.6,
          textTransform: "uppercase",
        }}
      >
        Todos
      </Text>
      {todos.map((todo, i) => (
        <View key={i} style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
          <Text
            style={{
              color: statusColor(todo.status, theme),
              fontSize: 14,
              fontWeight: "700",
              width: 18,
              textAlign: "center",
            }}
          >
            {statusIcon(todo.status)}
          </Text>
          <Text
            selectable
            style={{
              flex: 1,
              color: todo.status === "completed" ? theme.textSecondary : theme.text,
              fontSize: 14,
              lineHeight: 21,
              textDecorationLine: todo.status === "completed" ? "line-through" : "none",
            }}
          >
            {todo.content}
          </Text>
        </View>
      ))}
    </View>
  );
}
