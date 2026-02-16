import { useTheme } from "../context/theme";
import { Dialog } from "./dialog";

type DialogAlertProps = {
  title: string;
  message: string;
  onDismiss: () => void;
};

export function DialogAlert(props: DialogAlertProps) {
  const theme = useTheme();

  return (
    <Dialog onDismiss={props.onDismiss} width="50%">
      <box flexDirection="column" onKeyDown={(e: any) => {
        if ((e.key ?? e.name) === "escape" || (e.key ?? e.name) === "return") {
          props.onDismiss();
          e.preventDefault?.();
        }
      }} focused focusable>
        <text fg={theme.error} marginBottom={1}>
          <strong>{props.title}</strong>
        </text>
        <text fg={theme.text}>{props.message}</text>
        <text fg={theme.textMuted} marginTop={1}>
          Press Escape or Enter to close
        </text>
      </box>
    </Dialog>
  );
}
