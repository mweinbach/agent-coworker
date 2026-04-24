import fs from "node:fs/promises";
import { Document, Link, Page, renderToBuffer, StyleSheet, Text, View } from "@react-pdf/renderer";
import React from "react";

import type { ResearchRecord } from "../types";
import { buildResearchMarkdownDocument } from "./exportMarkdown";
import {
  type MarkdownNode,
  nodeChildren,
  nodeText,
  parseMarkdownAst,
  trimMarkdownText,
} from "./markdownAst";

const styles = StyleSheet.create({
  page: {
    paddingTop: 56,
    paddingBottom: 52,
    paddingHorizontal: 44,
    fontSize: 11,
    lineHeight: 1.5,
    color: "#111827",
    fontFamily: "Helvetica",
  },
  header: {
    position: "absolute",
    top: 24,
    left: 44,
    right: 44,
    borderBottomWidth: 1,
    borderBottomColor: "#E5E7EB",
    paddingBottom: 8,
  },
  headerTitle: {
    fontSize: 10,
    color: "#6B7280",
  },
  footer: {
    position: "absolute",
    bottom: 18,
    left: 44,
    right: 44,
    textAlign: "center",
    fontSize: 9,
    color: "#6B7280",
  },
  content: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  paragraph: {
    fontSize: 11,
    lineHeight: 1.55,
    marginBottom: 8,
  },
  h1: {
    fontSize: 24,
    fontFamily: "Helvetica-Bold",
    marginTop: 4,
    marginBottom: 12,
    lineHeight: 1.2,
  },
  h2: {
    fontSize: 17,
    fontFamily: "Helvetica-Bold",
    marginTop: 16,
    marginBottom: 8,
    lineHeight: 1.25,
  },
  h3: {
    fontSize: 14,
    fontFamily: "Helvetica-Bold",
    marginTop: 12,
    marginBottom: 6,
    lineHeight: 1.3,
  },
  h4: {
    fontSize: 12,
    fontFamily: "Helvetica-Bold",
    marginTop: 10,
    marginBottom: 6,
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    marginBottom: 8,
  },
  listItem: {
    display: "flex",
    flexDirection: "row",
    gap: 8,
  },
  listMarker: {
    width: 24,
    fontSize: 11,
  },
  listContent: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
  },
  blockquote: {
    borderLeftWidth: 3,
    borderLeftColor: "#CBD5E1",
    paddingLeft: 12,
    marginBottom: 10,
  },
  codeBlock: {
    backgroundColor: "#F3F4F6",
    borderWidth: 1,
    borderColor: "#E5E7EB",
    borderRadius: 4,
    padding: 10,
    marginBottom: 10,
  },
  codeText: {
    fontFamily: "Courier",
    fontSize: 10,
    lineHeight: 1.45,
  },
  rule: {
    borderBottomWidth: 1,
    borderBottomColor: "#D1D5DB",
    marginVertical: 8,
  },
  strong: {
    fontFamily: "Helvetica-Bold",
  },
  emphasis: {
    fontStyle: "italic",
  },
  inlineCode: {
    fontFamily: "Courier",
    fontSize: 10,
  },
  link: {
    color: "#1D4ED8",
    textDecoration: "underline",
  },
});

function headingStyle(depth: number) {
  switch (depth) {
    case 1:
      return styles.h1;
    case 2:
      return styles.h2;
    case 3:
      return styles.h3;
    default:
      return styles.h4;
  }
}

function renderInline(node: MarkdownNode, key: string): React.ReactNode {
  switch (node.type) {
    case "text":
      return node.value ?? "";
    case "strong":
      return (
        <Text key={key} style={styles.strong}>
          {nodeChildren(node).map((child, index) => renderInline(child, `${key}:${index}`))}
        </Text>
      );
    case "emphasis":
      return (
        <Text key={key} style={styles.emphasis}>
          {nodeChildren(node).map((child, index) => renderInline(child, `${key}:${index}`))}
        </Text>
      );
    case "inlineCode":
      return (
        <Text key={key} style={styles.inlineCode}>
          {node.value ?? ""}
        </Text>
      );
    case "link": {
      const content = nodeChildren(node);
      const label =
        content.length > 0
          ? content.map((child, index) => renderInline(child, `${key}:${index}`))
          : (node.url ?? "");
      return (
        <Link key={key} src={node.url ?? ""} style={styles.link}>
          {label}
        </Link>
      );
    }
    case "image":
      return `[Image: ${node.alt ?? node.url ?? "untitled"}]`;
    case "break":
      return "\n";
    default: {
      const children = nodeChildren(node);
      if (children.length > 0) {
        return (
          <Text key={key}>
            {children.map((child, index) => renderInline(child, `${key}:${index}`))}
          </Text>
        );
      }
      return node.value ?? "";
    }
  }
}

function renderParagraphText(node: MarkdownNode, key: string, style = styles.paragraph) {
  const children = nodeChildren(node);
  const content =
    children.length > 0
      ? children.map((child, index) => renderInline(child, `${key}:${index}`))
      : trimMarkdownText(nodeText(node));

  return (
    <Text key={key} style={style}>
      {content}
    </Text>
  );
}

function renderListItem(
  node: MarkdownNode,
  key: string,
  ordered: boolean,
  index: number,
  listLevel: number,
  start: number,
): React.ReactNode {
  const children = nodeChildren(node);
  const marker = ordered ? `${start + index}.` : "\u2022";
  return (
    <View
      key={key}
      style={[styles.listItem, ...(listLevel > 0 ? [{ marginLeft: listLevel * 14 }] : [])]}
    >
      <Text style={styles.listMarker}>{marker}</Text>
      <View style={styles.listContent}>
        {children.length > 0 ? (
          children.map((child, childIndex) =>
            renderBlock(child, `${key}:${childIndex}`, listLevel + 1),
          )
        ) : (
          <Text style={styles.paragraph}>{trimMarkdownText(nodeText(node))}</Text>
        )}
      </View>
    </View>
  );
}

function renderBlock(node: MarkdownNode, key: string, listLevel = 0): React.ReactNode {
  switch (node.type) {
    case "heading":
      return (
        <Text key={key} style={headingStyle(node.depth ?? 4)} wrap={false}>
          {trimMarkdownText(nodeText(node))}
        </Text>
      );
    case "paragraph":
      return renderParagraphText(node, key);
    case "list": {
      const items = nodeChildren(node);
      const start = typeof node.start === "number" ? node.start : 1;
      return (
        <View key={key} style={styles.list}>
          {items.map((item, index) =>
            renderListItem(item, `${key}:${index}`, node.ordered === true, index, listLevel, start),
          )}
        </View>
      );
    }
    case "blockquote":
      return (
        <View key={key} style={styles.blockquote}>
          {nodeChildren(node).map((child, index) =>
            renderBlock(child, `${key}:${index}`, listLevel),
          )}
        </View>
      );
    case "code":
      return (
        <View key={key} style={styles.codeBlock} wrap={false}>
          <Text style={styles.codeText}>{node.value ?? ""}</Text>
        </View>
      );
    case "thematicBreak":
      return <View key={key} style={styles.rule} />;
    default: {
      const text = trimMarkdownText(nodeText(node));
      if (text) {
        return (
          <Text key={key} style={styles.paragraph}>
            {text}
          </Text>
        );
      }
      return (
        <React.Fragment key={key}>
          {nodeChildren(node).map((child, index) =>
            renderBlock(child, `${key}:${index}`, listLevel),
          )}
        </React.Fragment>
      );
    }
  }
}

function ResearchPdfDocument({ research }: { research: ResearchRecord }) {
  const markdown = buildResearchMarkdownDocument(research);
  const blocks = parseMarkdownAst(markdown);

  return (
    <Document title={research.title}>
      <Page size="A4" style={styles.page} wrap>
        <View style={styles.header} fixed>
          <Text style={styles.headerTitle}>{research.title}</Text>
        </View>
        <Text
          style={styles.footer}
          fixed
          render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
        />
        <View style={styles.content}>
          {blocks.map((block, index) => renderBlock(block, `block:${index}`))}
        </View>
      </Page>
    </Document>
  );
}

export async function exportPdf(opts: {
  outputPath: string;
  research: ResearchRecord;
}): Promise<{ path: string; sizeBytes: number }> {
  const buffer = await renderToBuffer(<ResearchPdfDocument research={opts.research} />);
  await fs.writeFile(opts.outputPath, buffer);
  const stats = await fs.stat(opts.outputPath);
  return {
    path: opts.outputPath,
    sizeBytes: stats.size,
  };
}
