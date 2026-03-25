import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { useAppTheme } from "@/theme/use-app-theme";

type MarkdownTextProps = {
  text: string;
  color?: string;
};

type Block =
  | { type: "text"; content: string }
  | { type: "code"; language: string; content: string };

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      blocks.push({ type: "text", content: text.slice(lastIndex, match.index) });
    }
    blocks.push({ type: "code", language: match[1] || "", content: match[2] });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    blocks.push({ type: "text", content: text.slice(lastIndex) });
  }

  return blocks;
}

function InlineText({ text, color }: { text: string; color: string }) {
  const theme = useAppTheme();

  // Split by inline code backticks
  const parts = text.split(/(`[^`]+`)/g);

  return (
    <Text selectable style={{ color, fontSize: 15, lineHeight: 22 }}>
      {parts.map((part, i) => {
        if (part.startsWith("`") && part.endsWith("`")) {
          return (
            <Text
              key={i}
              style={{
                fontFamily: "Menlo",
                fontSize: 13,
                backgroundColor: theme.surfaceMuted,
                color: theme.accent,
              }}
            >
              {part.slice(1, -1)}
            </Text>
          );
        }

        // Bold
        const boldParts = part.split(/(\*\*[^*]+\*\*)/g);
        return boldParts.map((bp, j) => {
          if (bp.startsWith("**") && bp.endsWith("**")) {
            return (
              <Text key={`${i}-${j}`} style={{ fontWeight: "700" }}>
                {bp.slice(2, -2)}
              </Text>
            );
          }
          return <Text key={`${i}-${j}`}>{bp}</Text>;
        });
      })}
    </Text>
  );
}

function CodeBlock({ language, content }: { language: string; content: string }) {
  const theme = useAppTheme();
  const [expanded, setExpanded] = useState(false);
  const lines = content.split("\n");
  const isLong = lines.length > 12;
  const displayContent = isLong && !expanded ? lines.slice(0, 10).join("\n") + "\n..." : content;

  return (
    <View
      style={{
        borderRadius: 14,
        borderCurve: "continuous",
        overflow: "hidden",
        backgroundColor: theme.surfaceMuted,
        borderWidth: 1,
        borderColor: theme.borderMuted,
      }}
    >
      {language ? (
        <View
          style={{
            paddingHorizontal: 12,
            paddingVertical: 6,
            borderBottomWidth: 1,
            borderBottomColor: theme.borderMuted,
          }}
        >
          <Text style={{ color: theme.textTertiary, fontSize: 11, fontWeight: "600", textTransform: "uppercase" }}>
            {language}
          </Text>
        </View>
      ) : null}
      <Text
        selectable
        style={{
          fontFamily: "Menlo",
          fontSize: 12,
          lineHeight: 18,
          color: theme.text,
          padding: 12,
        }}
      >
        {displayContent}
      </Text>
      {isLong ? (
        <Pressable
          onPress={() => setExpanded(!expanded)}
          style={{
            paddingHorizontal: 12,
            paddingVertical: 8,
            borderTopWidth: 1,
            borderTopColor: theme.borderMuted,
          }}
        >
          <Text style={{ color: theme.primary, fontSize: 12, fontWeight: "600" }}>
            {expanded ? "Collapse" : `Show all ${lines.length} lines`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function MarkdownText({ text, color }: MarkdownTextProps) {
  const theme = useAppTheme();
  const blocks = parseBlocks(text);
  const textColor = color ?? theme.text;

  if (blocks.length === 1 && blocks[0].type === "text") {
    return <InlineText text={blocks[0].content} color={textColor} />;
  }

  return (
    <View style={{ gap: 8 }}>
      {blocks.map((block, i) => {
        if (block.type === "code") {
          return <CodeBlock key={i} language={block.language} content={block.content} />;
        }
        return <InlineText key={i} text={block.content} color={textColor} />;
      })}
    </View>
  );
}
