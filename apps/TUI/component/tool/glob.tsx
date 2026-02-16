import { Show } from "solid-js";
import { useTheme } from "../../context/theme";
import { Spinner } from "../spinner";
import type { ToolPartProps } from "../message/tool-part";

export function GlobTool(props: ToolPartProps) {
  const theme = useTheme();

  const pattern = () => props.args?.pattern ?? "";
  const matchCount = () => {
    const r = props.result;
    if (!r) return null;
    if (typeof r === "string") {
      return r.split("\n").filter(Boolean).length;
    }
    if (Array.isArray(r)) return r.length;
    if (typeof r === "object" && r.files) return Array.isArray(r.files) ? r.files.length : null;
    return null;
  };

  return (
    <box flexDirection="row" gap={1} marginBottom={0}>
      <Show
        when={props.status === "done"}
        fallback={<Spinner color={theme.warning} />}
      >
        <text fg={theme.success}>✓</text>
      </Show>
      <text fg={theme.textMuted}>glob</text>
      <text fg={theme.text}>{pattern()}</text>
      <Show when={matchCount() !== null}>
        <text fg={theme.textMuted}>{matchCount()} matches</text>
      </Show>
    </box>
  );
}
