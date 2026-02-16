import { type JSX } from "solid-js";
import { useTheme } from "../context/theme";

/**
 * A bordered container component with theme-aware styling.
 */
export function BorderBox(props: {
  children: JSX.Element;
  active?: boolean;
  color?: string;
}) {
  const theme = useTheme();
  const borderColor = () => props.color ?? (props.active ? theme.borderActive : theme.border);

  return (
    <box
      border
      borderStyle="rounded"
      borderColor={borderColor()}
      backgroundColor={theme.backgroundPanel}
      padding={1}
      flexDirection="column"
    >
      {props.children}
    </box>
  );
}
