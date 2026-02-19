import { For, createSignal } from "solid-js";
import { useTheme } from "../context/theme";
import { Dialog } from "./dialog";
import { keyNameFromEvent } from "../util/keyboard";

type DialogConfirmProps = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

export function DialogConfirm(props: DialogConfirmProps) {
  const theme = useTheme();
  const [selected, setSelected] = createSignal(0);

  const options = [
    props.confirmLabel ?? "Confirm",
    props.cancelLabel ?? "Cancel",
  ];

  const handleKeyDown = (e: any) => {
    const key = keyNameFromEvent(e);
    if (key === "up" || key === "left") {
      setSelected(0);
      e.preventDefault?.();
    } else if (key === "down" || key === "right") {
      setSelected(1);
      e.preventDefault?.();
    } else if (key === "enter") {
      if (selected() === 0) props.onConfirm();
      else props.onCancel();
      e.preventDefault?.();
    } else if (key === "escape") {
      props.onCancel();
      e.preventDefault?.();
    }
  };

  return (
    <Dialog onDismiss={props.onCancel} width={50}>
      <box flexDirection="column" onKeyDown={handleKeyDown} focused focusable>
        <text fg={theme.text} marginBottom={1}>
          <strong>{props.title}</strong>
        </text>
        <text fg={theme.textMuted} marginBottom={1}>
          {props.message}
        </text>
        <box flexDirection="row" gap={2}>
          <For each={options}>
            {(opt, i) => (
              <box
                border
                borderStyle="single"
                borderColor={selected() === i() ? theme.accent : theme.borderSubtle}
                paddingLeft={1}
                paddingRight={1}
                onMouseDown={() => {
                  if (i() === 0) props.onConfirm();
                  else props.onCancel();
                }}
              >
                <text fg={selected() === i() ? theme.text : theme.textMuted}>{opt}</text>
              </box>
            )}
          </For>
        </box>
      </box>
    </Dialog>
  );
}
