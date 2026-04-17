import * as mammothZipfile from "mammoth/lib/zipfile";

const OOXML_WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const OOXML_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const OOXML_PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const OOXML_DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const OOXML_WORD_DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";

const DEFAULT_DOCX_LAYOUT = {
  accentColor: "var(--accent)",
  titleColor: "var(--text-primary)",
  bodyColor: "var(--text-primary)",
  mutedColor: "var(--text-muted)",
  dividerColor: "var(--warning)",
  fontFamily: "Aptos",
} as const;

type MammothZipFile = Awaited<ReturnType<typeof mammothZipfile.openArrayBuffer>>;

export type DocxPreviewLayout = {
  accentColor: string;
  titleColor: string;
  bodyColor: string;
  mutedColor: string;
  dividerColor: string;
  fontFamily: string;
  headerImageSrc: string | null;
  headerImageWidthPx: number | null;
  footerText: string | null;
};

export async function loadDocxPreviewLayout(arrayBuffer: ArrayBuffer): Promise<DocxPreviewLayout> {
  const zip = await mammothZipfile.openArrayBuffer(arrayBuffer);
  const documentXml = await readZipText(zip, "word/document.xml");
  const stylesXml = await readZipText(zip, "word/styles.xml");
  const headerXml = await readZipText(zip, "word/header1.xml");
  const headerRelsXml = await readZipText(zip, "word/_rels/header1.xml.rels");
  const footerXml = await readZipText(zip, "word/footer1.xml");

  const layout: DocxPreviewLayout = {
    accentColor: DEFAULT_DOCX_LAYOUT.accentColor,
    titleColor: DEFAULT_DOCX_LAYOUT.titleColor,
    bodyColor: DEFAULT_DOCX_LAYOUT.bodyColor,
    mutedColor: DEFAULT_DOCX_LAYOUT.mutedColor,
    dividerColor: DEFAULT_DOCX_LAYOUT.dividerColor,
    fontFamily: DEFAULT_DOCX_LAYOUT.fontFamily,
    headerImageSrc: null,
    headerImageWidthPx: null,
    footerText: null,
  };

  if (stylesXml) {
    const stylesDoc = parseXml(stylesXml);
    layout.accentColor = readStyleColor(stylesDoc, "Heading1") ?? readStyleColor(stylesDoc, "Subtitle") ?? layout.accentColor;
    layout.fontFamily = readStyleFont(stylesDoc, "Heading1") ?? readStyleFont(stylesDoc, "Title") ?? layout.fontFamily;
  }

  if (documentXml) {
    const documentDoc = parseXml(documentXml);
    const bodyParagraphs = Array.from(documentDoc.getElementsByTagNameNS(OOXML_WORD_NS, "p"));

    layout.titleColor = readParagraphRunColor(bodyParagraphs[0]) ?? layout.titleColor;
    layout.bodyColor = layout.titleColor;
    layout.fontFamily = readParagraphRunFont(bodyParagraphs[0]) ?? layout.fontFamily;
    layout.mutedColor = readParagraphRunColor(bodyParagraphs[3]) ?? layout.mutedColor;
    layout.dividerColor = readParagraphBottomBorderColor(bodyParagraphs[4]) ?? layout.dividerColor;
  }

  if (footerXml) {
    const footerDoc = parseXml(footerXml);
    layout.footerText = collectNodeText(footerDoc.documentElement).trim() || null;
  }

  if (headerXml && headerRelsXml) {
    const headerDoc = parseXml(headerXml);
    const relsDoc = parseXml(headerRelsXml);
    const headerImage = await readHeaderImage(zip, headerDoc, relsDoc);
    if (headerImage) {
      layout.headerImageSrc = headerImage.src;
      layout.headerImageWidthPx = headerImage.widthPx;
    }
  }

  return layout;
}

export function decorateDocxPreviewHtml(rawHtml: string): string {
  const document = parseHtml(rawHtml);
  const root = document.body;
  const children = Array.from(root.children);

  const introParagraphs = children.slice(0, 4);
  if (introParagraphs.length === 4 && introParagraphs.every((node) => node.tagName === "P")) {
    introParagraphs[0]?.classList.add("docx-title");
    introParagraphs[1]?.classList.add("docx-subtitle");
    introParagraphs[2]?.classList.add("docx-byline");
    introParagraphs[3]?.classList.add("docx-note");

    if (!root.querySelector(".docx-divider")) {
      const divider = document.createElement("div");
      divider.className = "docx-divider";
      introParagraphs[3]?.insertAdjacentElement("afterend", divider);
    }
  }

  root.querySelectorAll("table").forEach((table) => table.classList.add("docx-table"));
  root.querySelectorAll("td, th").forEach((cell) => cell.classList.add("docx-cell"));
  root.querySelectorAll("td p, th p").forEach((paragraph) => paragraph.classList.add("docx-table-paragraph"));

  return root.innerHTML;
}

function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, "application/xml");
}

function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

async function readZipText(zip: MammothZipFile, path: string): Promise<string | null> {
  if (!zip.exists(path)) return null;
  const contents = await zip.read(path, "utf-8");
  return typeof contents === "string" ? contents : null;
}

async function readHeaderImage(
  zip: MammothZipFile,
  headerDoc: Document,
  relsDoc: Document,
): Promise<{ src: string; widthPx: number | null } | null> {
  const blip = headerDoc.getElementsByTagNameNS(OOXML_DRAWING_NS, "blip")[0];
  if (!blip) return null;

  const relId = blip.getAttributeNS(OOXML_REL_NS, "embed") ?? blip.getAttribute("r:embed");
  if (!relId) return null;

  const relationship = Array.from(relsDoc.getElementsByTagName("Relationship"))
    .find((node) => node.getAttribute("Id") === relId);
  const target = relationship?.getAttribute("Target");
  if (!target) return null;

  const resolvedTarget = resolveZipPath("word/header1.xml", target);
  if (!zip.exists(resolvedTarget)) return null;

  const base64 = await zip.read(resolvedTarget, "base64");
  if (typeof base64 !== "string") return null;

  const extent = headerDoc.getElementsByTagNameNS(OOXML_WORD_DRAWING_NS, "extent")[0];
  const cx = extent?.getAttribute("cx");

  return {
    src: `data:${mimeTypeForPath(resolvedTarget)};base64,${base64}`,
    widthPx: cx ? emuToPixels(Number(cx)) : null,
  };
}

function resolveZipPath(basePath: string, relativeTarget: string): string {
  const baseParts = basePath.split("/").slice(0, -1);
  for (const segment of relativeTarget.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      baseParts.pop();
      continue;
    }
    baseParts.push(segment);
  }
  return baseParts.join("/");
}

function mimeTypeForPath(path: string): string {
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".gif")) return "image/gif";
  if (path.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function emuToPixels(emu: number): number | null {
  if (!Number.isFinite(emu) || emu <= 0) return null;
  return Math.round((emu / 914400) * 96);
}

function readStyleColor(stylesDoc: Document, styleId: string): string | null {
  const style = findStyle(stylesDoc, styleId);
  if (!style) return null;
  const color = style.getElementsByTagNameNS(OOXML_WORD_NS, "color")[0];
  return normalizeColor(color?.getAttributeNS(OOXML_WORD_NS, "val") ?? color?.getAttribute("w:val"));
}

function readStyleFont(stylesDoc: Document, styleId: string): string | null {
  const style = findStyle(stylesDoc, styleId);
  if (!style) return null;
  const fonts = style.getElementsByTagNameNS(OOXML_WORD_NS, "rFonts")[0];
  return fonts?.getAttributeNS(OOXML_WORD_NS, "ascii") ?? fonts?.getAttribute("w:ascii") ?? null;
}

function findStyle(stylesDoc: Document, styleId: string): Element | null {
  return Array.from(stylesDoc.getElementsByTagNameNS(OOXML_WORD_NS, "style"))
    .find((node) =>
      node.getAttributeNS(OOXML_WORD_NS, "styleId") === styleId || node.getAttribute("w:styleId") === styleId,
    ) ?? null;
}

function readParagraphRunColor(paragraph: Element | undefined): string | null {
  if (!paragraph) return null;
  const color = paragraph.getElementsByTagNameNS(OOXML_WORD_NS, "color")[0];
  return normalizeColor(color?.getAttributeNS(OOXML_WORD_NS, "val") ?? color?.getAttribute("w:val"));
}

function readParagraphRunFont(paragraph: Element | undefined): string | null {
  if (!paragraph) return null;
  const fonts = paragraph.getElementsByTagNameNS(OOXML_WORD_NS, "rFonts")[0];
  return fonts?.getAttributeNS(OOXML_WORD_NS, "ascii") ?? fonts?.getAttribute("w:ascii") ?? null;
}

function readParagraphBottomBorderColor(paragraph: Element | undefined): string | null {
  if (!paragraph) return null;
  const border = paragraph.getElementsByTagNameNS(OOXML_WORD_NS, "bottom")[0];
  return normalizeColor(border?.getAttributeNS(OOXML_WORD_NS, "color") ?? border?.getAttribute("w:color"));
}

function normalizeColor(value: string | null | undefined): string | null {
  if (!value || value === "auto") return null;
  const normalized = value.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return null;
  return `#${normalized.toUpperCase()}`;
}

function collectNodeText(root: Element | null): string {
  if (!root) return "";
  return Array.from(root.getElementsByTagNameNS(OOXML_WORD_NS, "t"))
    .map((node) => node.textContent ?? "")
    .join("");
}
