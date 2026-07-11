import { memo, useMemo, useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import {
  areMarkdownRevisionPropsEqual,
  type MarkdownRevisionProps,
} from "@/components/thread/markdown-memo";
import { parseRichBlocks, type RichBlock } from "@/components/thread/markdownParser";
import { SourcesCarousel } from "@/components/thread/sources-carousel";
import {
  formatLinkDisplayLabel,
  normalizeInlineLinkHref,
  parseInlineMarkdown,
} from "@/features/cowork/inlineMarkdown";
import { useAppTheme } from "@/theme/use-app-theme";

export type { RichBlock } from "@/components/thread/markdownParser";
export { parseRichBlocks } from "@/components/thread/markdownParser";

export type MarkdownTextProps = MarkdownRevisionProps;

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
  const runs = useMemo(() => parseInlineMarkdown(text), [text]);

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
        <View
          key={`${ordered ? "ol" : "ul"}:${index}:${item.slice(0, 24)}`}
          style={{ flexDirection: "row", gap: 10 }}
        >
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

function HorizontalRuleBlock() {
  const theme = useAppTheme();
  return (
    <View
      style={{
        height: 1,
        marginVertical: 4,
        backgroundColor: theme.borderMuted,
      }}
    />
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
    case "horizontal-rule":
      return <HorizontalRuleBlock />;
    case "paragraph":
      return <InlineText text={block.content} color={color} variant={variant} />;
  }
}

function MarkdownTextComponent({ text, color, variant = "default" }: MarkdownTextProps) {
  const theme = useAppTheme();
  const blocks = useMemo(() => parseRichBlocks(text), [text]);
  const textColor = color ?? theme.text;

  if (blocks.length === 1 && blocks[0].type === "paragraph") {
    return <InlineText text={blocks[0].content} color={textColor} variant={variant} />;
  }

  return (
    <View style={{ gap: 14 }}>
      {blocks.map((block, index) => (
        <RichBlockView
          key={`${index}:${block.type}`}
          block={block}
          color={textColor}
          variant={variant}
        />
      ))}
    </View>
  );
}

export const MarkdownText = memo(MarkdownTextComponent, areMarkdownRevisionPropsEqual);
