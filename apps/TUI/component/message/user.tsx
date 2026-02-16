import { useTheme } from "../../context/theme";
import { Markdown } from "../markdown";

export function UserMessage(props: { text: string }) {
  const theme = useTheme();

  return (
    <box
      flexDirection="column"
      gap={0}
      marginBottom={1}
      border={["left"]}
      borderColor={theme.primary}
      paddingLeft={1}
    >
      <text fg={theme.primary}>
        <strong>you</strong>
      </text>
      <Markdown markdown={props.text} theme={theme} maxChars={20_000} />
    </box>
  );
}
