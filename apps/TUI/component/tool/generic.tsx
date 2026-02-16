import { Show, createSignal } from "solid-js";
import { useTheme } from "../../context/theme";
import { Spinner } from "../spinner";
import type { ToolPartProps } from "../message/tool-part";

function jsonPreview(value: unknown, maxChars = 200): string {
  if (value === undefined || value === null) return "";
  let raw: string;
  if (typeof value === "string") raw = value;
  else {
    try {
      raw = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      raw = String(value);
    }
  }
  if (raw.length > maxChars) {
    return raw.slice(0, maxChars) + `… (${raw.length - maxChars} more)`;
  }
  return raw;
}

export function GenericTool(props: ToolPartProps) {
  const theme = useTheme();
  const [expanded, setExpanded] = createSignal(false);

  const header = () => {
    if (props.sub) return `[${props.sub}] ${props.name}`;
    return props.name;
  };

  return (
    <box
      flexDirection="column"
      marginBottom={1}
      onMouseDown={() => setExpanded((e) => !e)}
    >
      <box flexDirection="row" gap={1}>
        <Show
          when={props.status === "done"}
          fallback={<Spinner color={theme.warning} />}
        >
          <text fg={theme.success}>✓</text>
        </Show>
        <text fg={theme.textMuted}>{header()}</text>
        <Show when={props.args && !expanded()}>
          <text fg={theme.textMuted}>{jsonPreview(props.args, 80)}</text>
        </Show>
      </box>

      <Show when={expanded()}>
        <Show when={props.args}>
          <box paddingLeft={3}>
            <text fg={theme.textMuted}>args: {jsonPreview(props.args, 500)}</text>
          </box>
        </Show>
        <Show when={props.result}>
          <box paddingLeft={3}>
            <text fg={theme.textMuted}>result: {jsonPreview(props.result, 500)}</text>
          </box>
        </Show>
      </Show>
    </box>
  );
}
