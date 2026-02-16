import { For, Show, type JSX } from "solid-js";
import type { ThemeColors } from "../context/theme";

type MarkdownProps = {
  markdown: string;
  theme: ThemeColors;
  maxChars?: number;
};

type InlinePart =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "bold"; text: string }
  | { type: "italic"; text: string }
  | { type: "link"; text: string; url: string };

function parseInline(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Inline code: `...`
    const codeMatch = remaining.match(/^`([^`]+)`/);
    if (codeMatch) {
      parts.push({ type: "code", text: codeMatch[1]! });
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // Bold: **...**
    const boldMatch = remaining.match(/^\*\*(.+?)\*\*/);
    if (boldMatch) {
      parts.push({ type: "bold", text: boldMatch[1]! });
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // Italic: *...*
    const italicMatch = remaining.match(/^\*(.+?)\*/);
    if (italicMatch) {
      parts.push({ type: "italic", text: italicMatch[1]! });
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    // Link: [text](url)
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      parts.push({ type: "link", text: linkMatch[1]!, url: linkMatch[2]! });
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    // Find next special char
    const nextSpecial = remaining.search(/[`*\[]/);
    if (nextSpecial === -1) {
      parts.push({ type: "text", text: remaining });
      break;
    }
    if (nextSpecial === 0) {
      // Special char that didn't match a pattern — consume it as text
      parts.push({ type: "text", text: remaining[0]! });
      remaining = remaining.slice(1);
    } else {
      parts.push({ type: "text", text: remaining.slice(0, nextSpecial) });
      remaining = remaining.slice(nextSpecial);
    }
  }

  return parts;
}

function InlineRenderer(props: { parts: InlinePart[]; theme: ThemeColors }) {
  return (
    <For each={props.parts}>
      {(part) => {
        switch (part.type) {
          case "code":
            return (
              <text fg={props.theme.markdownCode} bg={props.theme.backgroundElement}>
                {` ${part.text} `}
              </text>
            );
          case "bold":
            return <text fg={props.theme.markdownText}><strong>{part.text}</strong></text>;
          case "italic":
            return <text fg={props.theme.markdownEmphasis}><em>{part.text}</em></text>;
          case "link":
            return <text fg={props.theme.markdownLink}>{part.text}</text>;
          default:
            return <text fg={props.theme.markdownText}>{part.text}</text>;
        }
      }}
    </For>
  );
}

export function Markdown(props: MarkdownProps) {
  const lines = () => {
    let text = props.markdown;
    if (props.maxChars && text.length > props.maxChars) {
      text = text.slice(0, props.maxChars) + `\n… (${text.length - props.maxChars} more chars)`;
    }
    return text.split("\n");
  };

  let inCodeBlock = false;
  let codeBlockLang = "";

  return (
    <box flexDirection="column">
      <For each={lines()}>
        {(line) => {
          // Code block start/end
          if (line.startsWith("```")) {
            if (inCodeBlock) {
              inCodeBlock = false;
              return null;
            }
            inCodeBlock = true;
            codeBlockLang = line.slice(3).trim();
            return (
              <Show when={codeBlockLang}>
                <text fg={props.theme.textMuted}>{`─── ${codeBlockLang} ───`}</text>
              </Show>
            );
          }

          // Inside code block
          if (inCodeBlock) {
            return (
              <text fg={props.theme.syntaxVariable} bg={props.theme.backgroundElement}>
                {`  ${line}`}
              </text>
            );
          }

          // Empty line
          if (line.trim() === "") {
            return <text>{""}</text>;
          }

          // Heading: # ...
          const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
          if (headingMatch) {
            const level = headingMatch[1]!.length;
            const text = headingMatch[2]!;
            return (
              <text fg={props.theme.markdownHeading}>
                <strong>{`${"#".repeat(level)} ${text}`}</strong>
              </text>
            );
          }

          // Blockquote: > ...
          if (line.startsWith("> ")) {
            return (
              <box flexDirection="row">
                <text fg={props.theme.markdownBlockquote}>│ </text>
                <text fg={props.theme.markdownBlockquote}>{line.slice(2)}</text>
              </box>
            );
          }

          // Bullet list: - or * ...
          const bulletMatch = line.match(/^(\s*)[*-]\s+(.+)$/);
          if (bulletMatch) {
            const indent = bulletMatch[1]!;
            const content = bulletMatch[2]!;
            const inlineParts = parseInline(content);
            return (
              <box flexDirection="row">
                <text fg={props.theme.textMuted}>{`${indent}• `}</text>
                <InlineRenderer parts={inlineParts} theme={props.theme} />
              </box>
            );
          }

          // Numbered list: 1. ...
          const numberMatch = line.match(/^(\s*)(\d+)\.\s+(.+)$/);
          if (numberMatch) {
            const indent = numberMatch[1]!;
            const num = numberMatch[2]!;
            const content = numberMatch[3]!;
            const inlineParts = parseInline(content);
            return (
              <box flexDirection="row">
                <text fg={props.theme.textMuted}>{`${indent}${num}. `}</text>
                <InlineRenderer parts={inlineParts} theme={props.theme} />
              </box>
            );
          }

          // Regular text with inline formatting
          const inlineParts = parseInline(line);
          return (
            <box flexDirection="row" flexWrap="wrap">
              <InlineRenderer parts={inlineParts} theme={props.theme} />
            </box>
          );
        }}
      </For>
    </box>
  );
}
