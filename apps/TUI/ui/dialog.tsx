import { type JSX } from "solid-js";
import { useTheme } from "../context/theme";

export function Dialog(props: {
  children: JSX.Element;
  onDismiss: () => void;
  width?: number | "auto" | `${number}%`;
}) {
  const theme = useTheme();

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width="100%"
      height="100%"
      zIndex={100}
      justifyContent="center"
      alignItems="center"
      onKeyDown={(e: any) => {
        if ((e.key ?? e.name) === "escape") {
          props.onDismiss();
          e.preventDefault?.();
        }
      }}
    >
      {/* Backdrop */}
      <box
        position="absolute"
        left={0}
        top={0}
        width="100%"
        height="100%"
        backgroundColor={theme.background}
        onMouseDown={props.onDismiss}
      />

      {/* Content */}
      <box
        border
        borderStyle="rounded"
        borderColor={theme.border}
        backgroundColor={theme.backgroundPanel}
        flexDirection="column"
        padding={1}
        width={props.width ?? "60%"}
        maxHeight="80%"
        zIndex={101}
      >
        {props.children}
      </box>
    </box>
  );
}
