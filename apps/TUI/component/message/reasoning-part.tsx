import { Show, createSignal } from "solid-js";
import { useTheme } from "../../context/theme";
import { useKV } from "../../context/kv";

export function ReasoningPart(props: { kind: "reasoning" | "summary"; text: string }) {
  const theme = useTheme();
  const kv = useKV();
  const [showThinking] = kv.signal("thinking_visibility", true);
  const [expanded, setExpanded] = createSignal(false);

  const label = () => (props.kind === "summary" ? "Summary" : "Thinking");
  const preview = () => {
    const lines = props.text.split("\n");
    if (lines.length <= 3) return props.text;
    return lines.slice(0, 3).join("\n") + "...";
  };

  return (
    <Show when={showThinking()}>
      <box
        flexDirection="column"
        marginBottom={1}
        onMouseDown={() => setExpanded((e) => !e)}
      >
        <text fg={theme.textMuted}>
          <em>
            {expanded() ? "▾" : "▸"} {label()}
          </em>
        </text>
        <Show when={expanded()}>
          <box paddingLeft={2}>
            <text fg={theme.textMuted}>{props.text}</text>
          </box>
        </Show>
        <Show when={!expanded()}>
          <box paddingLeft={2}>
            <text fg={theme.textMuted}>{preview()}</text>
          </box>
        </Show>
      </box>
    </Show>
  );
}
