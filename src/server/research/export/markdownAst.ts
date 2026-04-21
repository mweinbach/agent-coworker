import { unified } from "unified";
import remarkParse from "remark-parse";

export type MarkdownNode = {
  type: string;
  depth?: number;
  ordered?: boolean;
  start?: number | null;
  value?: string;
  url?: string;
  alt?: string | null;
  lang?: string | null;
  children?: MarkdownNode[];
};

function isMarkdownNode(value: unknown): value is MarkdownNode {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

export function parseMarkdownAst(markdown: string): MarkdownNode[] {
  const tree = unified().use(remarkParse).parse(markdown) as { children?: unknown };
  const children = Array.isArray(tree.children) ? tree.children : [];
  return children.flatMap((child) => (isMarkdownNode(child) ? [child] : []));
}

export function nodeChildren(node: MarkdownNode | null | undefined): MarkdownNode[] {
  return Array.isArray(node?.children)
    ? node.children.flatMap((child) => (isMarkdownNode(child) ? [child] : []))
    : [];
}

export function nodeText(node: MarkdownNode | null | undefined): string {
  if (!node) {
    return "";
  }
  if (typeof node.value === "string") {
    return node.value;
  }
  switch (node.type) {
    case "image":
      return typeof node.alt === "string" ? node.alt : "";
    case "break":
      return "\n";
    default:
      return nodeChildren(node).map((child) => nodeText(child)).join("");
  }
}

export function trimMarkdownText(value: string): string {
  return value.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

