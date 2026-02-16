import { Show, For } from "solid-js";
import { useTheme } from "../../context/theme";
import { Spinner } from "../spinner";
import { useKV } from "../../context/kv";
import type { ToolPartProps } from "../message/tool-part";

export function EditTool(props: ToolPartProps) {
  const theme = useTheme();
  const kv = useKV();
  const [showDetails] = kv.signal("tool_details_visibility", false);

  const filePath = () => props.args?.file_path ?? props.args?.path ?? "";
  const oldStr = () => props.args?.old_string ?? "";
  const newStr = () => props.args?.new_string ?? "";

  const diffLines = () => {
    if (!showDetails()) return [];
    const lines: { type: "add" | "remove" | "context"; text: string }[] = [];
    for (const line of oldStr().split("\n")) {
      lines.push({ type: "remove", text: line });
    }
    for (const line of newStr().split("\n")) {
      lines.push({ type: "add", text: line });
    }
    return lines;
  };

  return (
    <box flexDirection="column" marginBottom={1}>
      <box flexDirection="row" gap={1}>
        <Show
          when={props.status === "done"}
          fallback={<Spinner color={theme.warning} />}
        >
          <text fg={theme.success}>✓</text>
        </Show>
        <text fg={theme.textMuted}>edit</text>
        <text fg={theme.text}>{filePath()}</text>
      </box>

      <Show when={showDetails() && props.status === "done" && (oldStr() || newStr())}>
        <box paddingLeft={3} flexDirection="column">
          <For each={diffLines()}>
            {(line) => (
              <text
                fg={line.type === "add" ? theme.diffAdded : line.type === "remove" ? theme.diffRemoved : theme.diffContext}
                bg={line.type === "add" ? theme.diffAddedBg : line.type === "remove" ? theme.diffRemovedBg : undefined}
              >
                {line.type === "add" ? "+ " : line.type === "remove" ? "- " : "  "}
                {line.text}
              </text>
            )}
          </For>
        </box>
      </Show>
    </box>
  );
}
