import { createSignal } from "solid-js";
import { useTheme } from "../context/theme";
import { Dialog } from "./dialog";

type DialogPromptProps = {
  title: string;
  placeholder?: string;
  onSubmit: (value: string) => void;
  onDismiss: () => void;
};

export function DialogPrompt(props: DialogPromptProps) {
  const theme = useTheme();
  const [value, setValue] = createSignal("");

  const handleKeyDown = (e: any) => {
    const key = e.key ?? e.name ?? "";
    if (key === "return") {
      const text = value().trim();
      if (text) props.onSubmit(text);
      e.preventDefault?.();
    } else if (key === "escape") {
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
