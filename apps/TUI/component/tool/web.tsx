import { Show } from "solid-js";
import { useTheme } from "../../context/theme";
import { Spinner } from "../spinner";
import type { ToolPartProps } from "../message/tool-part";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function WebTool(props: ToolPartProps) {
  const theme = useTheme();

  const isNativeSearch = () => props.name === "nativeWebSearch";
  const isSearch = () => props.name === "webSearch" || isNativeSearch();
  const nativeAction = () => {
    if (!isRecord(props.result) || !isRecord(props.result.action)) return null;
    return props.result.action;
  };
  const label = () => {
    if (isNativeSearch()) return "web";
    return isSearch() ? "search" : "fetch";
  };
  const query = () => {
    if (isNativeSearch()) {
      const action = nativeAction();
      if (!action) return props.status === "done" ? "Completed" : "Searching the web";
      if (action.type === "search") return String(action.query ?? action.q ?? "Search completed");
      if (action.type === "open_page") return String(action.url ?? "Opened page");
      if (action.type === "find_in_page") {
        const pattern = action.pattern ?? action.query ?? "";
        const url = action.url ?? "";
        if (pattern && url) return `'${String(pattern)}' in ${String(url)}`;
        if (pattern) return String(pattern);
      }
      return "Searching the web";
    }
    if (props.name === "webSearch") return props.args?.query ?? "";
    return props.args?.url ?? "";
  };

  return (
    <box flexDirection="row" gap={1} marginBottom={0}>
      <Show
        when={props.status === "done"}
        fallback={<Spinner color={theme.warning} />}
      >
        <text fg={theme.success}>✓</text>
      </Show>
      <text fg={theme.textMuted}>{label()}</text>
      <text fg={theme.text}>{query()}</text>
    </box>
  );
}
