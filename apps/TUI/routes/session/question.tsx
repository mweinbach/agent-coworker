import { Show, For, createSignal } from "solid-js";
import { useTheme } from "../../context/theme";
import { useSyncActions } from "../../context/sync";
import type { AskRequest } from "../../context/sync";
import { keyNameFromEvent } from "../../util/keyboard";

export function QuestionPrompt(props: { ask: AskRequest }) {
  const theme = useTheme();
  const actions = useSyncActions();
  const [selected, setSelected] = createSignal(0);
  const [customInput, setCustomInput] = createSignal("");

  const hasOptions = () => props.ask.options && props.ask.options.length > 0;

  const handleSubmit = () => {
    if (hasOptions()) {
      const opts = props.ask.options!;
      const answer = opts[selected()] ?? customInput();
      actions.answerAsk(props.ask.requestId, answer);
    } else {
      const text = customInput().trim();
      if (text) {
        actions.answerAsk(props.ask.requestId, text);
      }
    }
  };

  const handleKeyDown = (e: any) => {
    const key = keyNameFromEvent(e);
    if (hasOptions()) {
      if (key === "up") {
        setSelected((s) => Math.max(0, s - 1));
        e.preventDefault?.();
      } else if (key === "down") {
        setSelected((s) => Math.min(props.ask.options!.length - 1, s + 1));
        e.preventDefault?.();
      } else if (key === "enter") {
        handleSubmit();
        e.preventDefault?.();
      } else if (key === "escape") {
        actions.answerAsk(props.ask.requestId, "");
        e.preventDefault?.();
      }
    } else {
      if (key === "escape") {
        actions.answerAsk(props.ask.requestId, "");
        e.preventDefault?.();
      }
    }
  };

  return (
    <box
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={theme.info}
      backgroundColor={theme.backgroundPanel}
      marginLeft={1}
      marginRight={1}
      marginBottom={1}
      padding={1}
      onKeyDown={handleKeyDown}
      focused
      focusable
    >
      <text fg={theme.info} marginBottom={1}>
        ? {props.ask.question}
      </text>

      <Show when={hasOptions()}>
        <For each={props.ask.options}>
          {(opt, i) => (
            <box
              flexDirection="row"
              gap={1}
              onMouseDown={() => {
                setSelected(i());
                handleSubmit();
              }}
            >
              <text fg={selected() === i() ? theme.accent : theme.textMuted}>
                {selected() === i() ? "▸" : " "}
              </text>
              <text fg={selected() === i() ? theme.text : theme.textMuted}>{opt}</text>
            </box>
          )}
        </For>
      </Show>

      <Show when={!hasOptions()}>
        <box flexDirection="row">
          <text fg={theme.accent}>{"❯ "}</text>
          <input
            value={customInput()}
            onChange={(v: any) => setCustomInput(typeof v === "string" ? v : v?.value ?? "")}
            onKeyDown={handleKeyDown}
            onSubmit={handleSubmit}
            placeholder="Type your answer..."
            placeholderColor={theme.textMuted}
            textColor={theme.text}
            flexGrow={1}
            focused
          />
        </box>
      </Show>
    </box>
  );
}
