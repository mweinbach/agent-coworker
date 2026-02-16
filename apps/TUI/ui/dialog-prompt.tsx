import { createSignal } from "solid-js";
import { useTheme } from "../context/theme";
import { Dialog } from "./dialog";
import { keyNameFromEvent } from "../util/keyboard";

type DialogPromptProps = {
  title: string;
  placeholder?: string;
  onSubmit: (value: string) => void;
  onDismiss: () => void;
};

export function resolveDialogPromptSubmitValue(value: string): string | null {
  const text = value.trim();
  return text ? text : null;
}

export function shouldDismissDialogPromptForKey(key: string): boolean {
  return key === "escape";
}

export function DialogPrompt(props: DialogPromptProps) {
  const theme = useTheme();
  const [value, setValue] = createSignal("");

  const submitValue = (raw: string) => {
    const text = resolveDialogPromptSubmitValue(raw);
    if (text) props.onSubmit(text);
  };

  const handleKeyDown = (e: any) => {
    const key = keyNameFromEvent(e);
    if (key === "enter") {
      // Fallback for terminals that do not route Enter to input onSubmit reliably.
      submitValue(value());
      e.preventDefault?.();
      return;
    }
    if (shouldDismissDialogPromptForKey(key)) {
      props.onDismiss();
      e.preventDefault?.();
    }
  };

  return (
    <Dialog onDismiss={props.onDismiss} width="50%">
      <box flexDirection="column">
        <text fg={theme.text} marginBottom={1}>
          <strong>{props.title}</strong>
        </text>
        <box
          border
          borderStyle="single"
          borderColor={theme.borderActive}
          paddingLeft={1}
        >
          <input
            value={value()}
            onChange={(v: any) => setValue(typeof v === "string" ? v : v?.value ?? "")}
            onKeyDown={handleKeyDown}
            onSubmit={(submittedValue: string) => {
              submitValue(typeof submittedValue === "string" ? submittedValue : value());
            }}
            placeholder={props.placeholder ?? "Enter value..."}
            placeholderColor={theme.textMuted}
            textColor={theme.text}
            focused
            flexGrow={1}
          />
        </box>
      </box>
    </Dialog>
  );
}
