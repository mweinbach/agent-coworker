import { Show, createSignal } from "solid-js";
import { useTheme } from "../../context/theme";
import { Spinner } from "../spinner";
import type { ToolPartProps } from "../message/tool-part";

const MAX_OUTPUT_LINES = 10;

export function BashTool(props: ToolPartProps) {
  const theme = useTheme();
  const [expanded, setExpanded] = createSignal(false);

  const command = () => props.args?.command ?? "";
  const stdout = () => {
    const r = props.result;
    if (!r) return "";
    if (typeof r === "string") return r;
    return r.stdout ?? r.output ?? "";
  };
  const exitCode = () => {
    const r = props.result;
    if (!r || typeof r !== "object") return null;
    return r.exitCode ?? null;
  };

  const outputLines = () => stdout().split("\n");
  const truncated = () => outputLines().length > MAX_OUTPUT_LINES && !expanded();
  const visibleOutput = () => {
    const lines = outputLines();
    if (truncated()) return lines.slice(0, MAX_OUTPUT_LINES).join("\n");
    return stdout();
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
          <text fg={exitCode() === 0 || exitCode() === null ? theme.success : theme.error}>
            {exitCode() === 0 || exitCode() === null ? "✓" : "✗"}
          </text>
        </Show>
        <text fg={theme.textMuted}>bash</text>
        <text fg={theme.text}>$ {command()}</text>
        <Show when={props.status === "done" && exitCode() !== null && exitCode() !== 0}>
          <text fg={theme.error}>(exit {exitCode()})</text>
        </Show>
      </box>

      <Show when={props.status === "done" && stdout()}>
        <box paddingLeft={3}>
          <text fg={theme.textMuted}>{visibleOutput()}</text>
        </box>
        <Show when={truncated()}>
          <box paddingLeft={3}>
            <text fg={theme.accent}>
              ▸ {outputLines().length - MAX_OUTPUT_LINES} more lines (click to expand)
            </text>
          </box>
        </Show>
      </Show>
    </box>
  );
}
