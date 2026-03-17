import { type JSX } from "solid-js";
import { SyntaxStyle } from "@opentui/core";
import { normalizeDisplayCitationMarkers } from "../../../src/shared/displayCitationMarkers";
import type { ThemeColors } from "../context/theme";

type MarkdownProps = {
  markdown: string;
  theme: ThemeColors;
  maxChars?: number;
  normalizeDisplayCitations?: boolean;
  citationUrlsByIndex?: ReadonlyMap<number, string>;
  citationAnnotations?: unknown;
};

export function Markdown(props: MarkdownProps) {
  const content = () => {
    let text = props.normalizeDisplayCitations
      ? normalizeDisplayCitationMarkers(props.markdown, {
        citationUrlsByIndex: props.citationUrlsByIndex,
        citationMode: "markdown",
        annotations: props.citationAnnotations,
        fallbackToSourcesFooter: true,
      })
      : props.markdown;
    if (props.maxChars && text.length > props.maxChars) {
      text = text.slice(0, props.maxChars) + `\n… (${text.length - props.maxChars} more chars)`;
    }
    return text;
  };

  const syntaxStyle = SyntaxStyle.fromTheme([
    { scope: ["keyword", "tag"], style: { foreground: props.theme.syntaxKeyword } },
    { scope: ["function", "constructor"], style: { foreground: props.theme.syntaxFunction } },
    { scope: ["variable", "property", "attribute", "embedded"], style: { foreground: props.theme.syntaxVariable } },
    { scope: ["string", "escape"], style: { foreground: props.theme.syntaxString } },
    { scope: ["number"], style: { foreground: props.theme.syntaxNumber } },
    { scope: ["type", "constant"], style: { foreground: props.theme.syntaxType } },
    { scope: ["operator"], style: { foreground: props.theme.syntaxOperator } },
    { scope: ["punctuation"], style: { foreground: props.theme.syntaxPunctuation } },
    { scope: ["comment"], style: { foreground: props.theme.syntaxComment } },
  ]);

  // We rely on the native @opentui/core <markdown> renderable.
  // We enable streaming to allow partial tokens to render smoothly without jitter.
  return <markdown content={content()} syntaxStyle={syntaxStyle} streaming={true} />;
}
