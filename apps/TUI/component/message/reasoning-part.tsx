import { Show, createSignal } from "solid-js";
import { useTheme } from "../../context/theme";
import { useKV } from "../../context/kv";
import { keyNameFromEvent } from "../../util/keyboard";

export function reasoningPreviewText(text: string, maxLines = 3): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join("\n")}...`;
}

export function shouldToggleReasoningExpanded(key: string): boolean {
  return key === "enter" || key === "space" || key === " ";
}

export function ReasoningPart(props: { kind: "reasoning" | "summary"; text: string }) {
  const theme = useTheme();
  const kv = useKV();
  const [showThinking] = kv.signal("thinking_visibility", true);
  const [expanded, setExpanded] = createSignal(false);

  const label = () => (props.kind === "summary" ? "Summary" : "Thinking");
  const preview = () => reasoningPreviewText(props.text, 3);
  const toggle = () => setExpanded((isExpanded) => !isExpanded);
  const handleKeyDown = (e: any) => {
    const key = keyNameFromEvent(e);
    if (!shouldToggleReasoningExpanded(key)) return;
    toggle();
    e.preventDefault?.();
  };

  return (
    <Show when={showThinking()}>
      <box
        flexDirection="column"
        marginBottom={1}
        onMouseDown={toggle}
        onKeyDown={handleKeyDown}
        focusable
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
