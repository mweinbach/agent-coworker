import { useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";

import {
  formatLinkDisplayLabel,
  normalizeInlineLinkHref,
  parseInlineMarkdown,
} from "@/features/cowork/inlineMarkdown";
import { SourcesCarousel } from "@/components/thread/sources-carousel";
import { useAppTheme } from "@/theme/use-app-theme";

type MarkdownTextProps = {
  text: string;
  color?: string;
  variant?: "default" | "reasoning";
};

type CodeBlockData = { type: "code"; language: string; content: string };

type RichBlock =
  | { type: "paragraph"; content: string }
  | { type: "heading"; level: number; content: string }
  | { type: "bullet-list"; items: string[] }
  | { type: "numbered-list"; items: string[] }
  | { type: "sources"; items: Array<{ label: string; href: string }> }
  | CodeBlockData;

function parseCodeBlocks(text: string): Array<{ type: "text"; content: string } | CodeBlockData> {
  const blocks: Array<{ type: "text"; content: string } | CodeBlockData> = [];
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match = codeBlockRegex.exec(text);
  while (match !== null) {
    if (match.index > lastIndex) {
      blocks.push({ type: "text", content: text.slice(lastIndex, match.index) });
    }
    blocks.push({ type: "code", language: match[1] || "", content: match[2] });
    lastIndex = match.index + match[0].length;
    match = codeBlockRegex.exec(text);
  }

  if (lastIndex < text.length) {
    blocks.push({ type: "text", content: text.slice(lastIndex) });
  }

  return blocks;
}

function extractLinkFromLine(line: string): { label: string; href: string } | null {
  const markdownMatch = line.match(/^\s*[-*•]?\s*\[([^\]]+)\]\(([^)]+)\)\s*$/);
  if (markdownMatch) {
    const href = normalizeInlineLinkHref(markdownMatch[2]);
    if (href) {
      return { label: markdownMatch[1], href };
    }
  }

  const urlMatch = line.match(/^\s*[-*•]?\s*((?:https?:\/\/|www\.)[^\s]+)\s*$/i);
  if (urlMatch) {
    const href = normalizeInlineLinkHref(urlMatch[1]);
    if (href) {
      return { label: urlMatch[1], href };
    }
  }

  return null;
}

function parseTextSections(text: string): RichBlock[] {
  const sections = text.split(/\n{2,}/);
  const blocks: RichBlock[] = [];

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    const lines = trimmed.split("\n").map((line) => line.trimEnd());
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
    if (nonEmptyLines.length === 0) continue;

    const firstLine = nonEmptyLines[0]?.trim() ?? "";
    const sourcesStartIndex = nonEmptyLines.findIndex((line) => /^sources:?$/i.test(line.trim()));
    if (sourcesStartIndex >= 0) {
      if (sourcesStartIndex > 0) {
        blocks.push({ type: "paragraph", content: nonEmptyLines.slice(0, sourcesStartIndex).join("\n") });
      }
      const sourceItems = nonEmptyLines
        .slice(sourcesStartIndex + 1)
        .map((line) => extractLinkFromLine(line))
        .filter((item): item is { label: string; href: string } => item !== null);
      if (sourceItems.length > 0) {
        blocks.push({ type: "sources", items: sourceItems });
        continue;
      }
    }

    if (/^sources:?$/i.test(firstLine)) {
      const sourceItems = nonEmptyLines
        .slice(1)
        .map((line) => extractLinkFromLine(line))
        .filter((item): item is { label: string; href: string } => item !== null);
      if (sourceItems.length > 0) {
        blocks.push({ type: "sources", items: sourceItems });
        continue;
      }
    }

    const headingMatch = firstLine.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch && nonEmptyLines.length === 1) {
      blocks.push({
        type: "heading",
        level: headingMatch[1].length,
        content: headingMatch[2],
      });
      continue;
    }

    const isBulletList = nonEmptyLines.every((line) => /^[-*•]\s+/.test(line.trim()));
    if (isBulletList) {
      blocks.push({
        type: "bullet-list",
        items: nonEmptyLines.map((line) => line.trim().replace(/^[-*•]\s+/, "")),
      });
      continue;
    }

    const isNumberedList = nonEmptyLines.every((line) => /^\d+\.\s+/.test(line.trim()));
    if (isNumberedList) {
      blocks.push({
        type: "numbered-list",
        items: nonEmptyLines.map((line) => line.trim().replace(/^\d+\.\s+/, "")),
      });
      continue;
    }

    blocks.push({ type: "paragraph", content: trimmed });
  }

  return blocks;
}

function parseRichBlocks(text: string): RichBlock[] {
  const codeAwareBlocks = parseCodeBlocks(text);
  const richBlocks: RichBlock[] = [];

  for (const block of codeAwareBlocks) {
    if (block.type === "code") {
      richBlocks.push(block);
      continue;
    }
    richBlocks.push(...parseTextSections(block.content));
  }

  return richBlocks;
}

function InlineText({
  text,
  color,
  variant = "default",
}: {
  text: string;
  color: string;
  variant?: "default" | "reasoning";
}) {
  const theme = useAppTheme();
  const fontSize = variant === "reasoning" ? 13 : 16;
  const lineHeight = variant === "reasoning" ? 20 : 26;
  const runs = parseInlineMarkdown(text);

  async function openLink(href: string) {
    const normalized = normalizeInlineLinkHref(href);
    if (!normalized) return;
    try {
      const supported = await Linking.canOpenURL(normalized);
      if (supported) {
        await Linking.openURL(normalized);
      }
    } catch {
      // Best-effort only — ignore unsupported or blocked URLs.
    }
  }

  return (
    <Text selectable style={{ color, fontSize, lineHeight, letterSpacing: -0.2 }}>
      {runs.map((run, index) => {
        const runKey = `${run.type}:${index}:${"content" in run ? run.content : run.label}`;
        if (run.type === "code") {
          return (
            <Text
              key={runKey}
              style={{
                fontFamily: theme.fontFamilyMono,
                fontSize: fontSize - 1,
                backgroundColor: theme.surfaceMuted,
                color: theme.accent,
              }}
            >
              {run.content}
            </Text>
          );
        }
        if (run.type === "bold") {
          return (
            <Text key={runKey} style={{ fontWeight: "700" }}>
              {run.content}
            </Text>
          );
        }
        if (run.type === "italic") {
          return (
            <Text key={runKey} style={{ fontStyle: "italic" }}>
              {run.content}
            </Text>
          );
        }
        if (run.type === "link") {
          return (
            <Text
              key={runKey}
              onPress={() => void openLink(run.href)}
              style={{
                color: theme.primary,
                fontWeight: "600",
              }}
            >
              {formatLinkDisplayLabel(run.label, run.href)}
            </Text>
          );
        }
        return <Text key={runKey}>{run.content}</Text>;
      })}
    </Text>
  );
}

function CodeBlock({ language, content }: { language: string; content: string }) {
  const theme = useAppTheme();
  const [expanded, setExpanded] = useState(false);
  const lines = content.split("\n");
  const isLong = lines.length > 12;
  const displayContent = isLong && !expanded ? `${lines.slice(0, 10).join("\n")}\n...` : content;

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
          <Text
            style={{
              color: theme.textTertiary,
              fontSize: 11,
              fontWeight: "600",
              textTransform: "uppercase",
            }}
          >
            {language}
          </Text>
        </View>
      ) : null}
      <Text
        selectable
        style={{
          fontFamily: theme.fontFamilyMono,
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

function ListBlock({
  items,
  ordered,
  color,
  variant,
}: {
  items: string[];
  ordered: boolean;
  color: string;
  variant: "default" | "reasoning";
}) {
  const theme = useAppTheme();

  return (
    <View style={{ gap: 8 }}>
      {items.map((item, index) => (
        <View key={`${ordered ? "ol" : "ul"}:${index}:${item.slice(0, 24)}`} style={{ flexDirection: "row", gap: 10 }}>
          <Text
            selectable
            style={{
              color: theme.primary,
              fontSize: variant === "reasoning" ? 13 : 16,
              lineHeight: variant === "reasoning" ? 20 : 26,
              fontWeight: "600",
              minWidth: ordered ? 22 : 14,
            }}
          >
            {ordered ? `${index + 1}.` : "•"}
          </Text>
          <View style={{ flex: 1, minWidth: 0 }}>
            <InlineText text={item} color={color} variant={variant} />
          </View>
        </View>
      ))}
    </View>
  );
}

function HeadingBlock({
  level,
  content,
  color,
}: {
  level: number;
  content: string;
  color: string;
}) {
  const fontSize = level <= 2 ? 20 : level === 3 ? 17 : 15;

  return (
    <Text
      selectable
      style={{
        color,
        fontSize,
        lineHeight: fontSize + 6,
        fontWeight: "700",
        letterSpacing: -0.3,
      }}
    >
      {content}
    </Text>
  );
}

function RichBlockView({
  block,
  color,
  variant,
}: {
  block: RichBlock;
  color: string;
  variant: "default" | "reasoning";
}) {
  switch (block.type) {
    case "code":
      return <CodeBlock language={block.language} content={block.content} />;
    case "heading":
      return <HeadingBlock level={block.level} content={block.content} color={color} />;
    case "bullet-list":
      return <ListBlock items={block.items} ordered={false} color={color} variant={variant} />;
    case "numbered-list":
      return <ListBlock items={block.items} ordered color={color} variant={variant} />;
    case "sources":
      return <SourcesCarousel items={block.items} />;
    case "paragraph":
      return <InlineText text={block.content} color={color} variant={variant} />;
  }
}

export function MarkdownText({ text, color, variant = "default" }: MarkdownTextProps) {
  const theme = useAppTheme();
  const blocks = parseRichBlocks(text);
  const textColor = color ?? theme.text;

  if (blocks.length === 1 && blocks[0].type === "paragraph") {
    return <InlineText text={blocks[0].content} color={textColor} variant={variant} />;
  }

  return (
    <View style={{ gap: 14 }}>
      {blocks.map((block) => {
        const blockKey =
          block.type === "code"
            ? `code:${block.language}:${block.content.slice(0, 32)}`
            : block.type === "sources"
              ? `sources:${block.items.map((item) => item.href).join("|")}`
              : block.type === "bullet-list" || block.type === "numbered-list"
                ? `${block.type}:${block.items.join("|").slice(0, 48)}`
                : `${block.type}:${"content" in block ? block.content.slice(0, 48) : ""}`;
        return (
          <RichBlockView key={blockKey} block={block} color={textColor} variant={variant} />
        );
      })}
    </View>
  );
}
