import { useTheme } from "../../context/theme";
import { Markdown } from "../markdown";

export function TextPart(props: { text: string }) {
  const theme = useTheme();
  return <Markdown markdown={props.text} theme={theme} maxChars={20_000} />;
}
