import { useTheme } from "../../context/theme";
import { Markdown } from "../markdown";

export function AssistantMessage(props: { text: string; citationUrlsByIndex?: ReadonlyMap<number, string> }) {
  const theme = useTheme();

  return (
    <box flexDirection="column" gap={0} marginBottom={1}>
      <Markdown
        markdown={props.text}
        theme={theme}
        maxChars={20_000}
        normalizeDisplayCitations
        citationUrlsByIndex={props.citationUrlsByIndex}
      />
    </box>
  );
}
