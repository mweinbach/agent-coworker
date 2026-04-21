import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { defaultRemarkPlugins, Streamdown } from "streamdown";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { ExternalLinkIcon } from "lucide-react";
import { CodeFilePreview } from "./CodeFilePreview";

import { useAppStore } from "../app/store";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { getPreferredFileApp, openPath, readFileForPreview } from "../lib/desktopCommands";
import {
  DesktopMessageLink,
  defaultDesktopRehypePlugins,
  remarkRewriteDesktopFileLinks,
} from "../components/ai-elements/message";
import { cn } from "../lib/utils";
import { getExtensionLower, getFilePreviewKind, mimeForPreviewKind, type FilePreviewKind } from "../lib/filePreviewKind";
import { decorateDocxPreviewHtml, loadDocxPreviewLayout, type DocxPreviewLayout } from "../lib/docxPreview";

const XLSX_MAX_ROWS = 200;
const XLSX_MAX_COLS = 40;

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

// 2% threshold tolerates UTF-8 BOM / occasional stray control bytes in logs
// without misclassifying real binaries as text.
function looksMostlyText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true;
  let suspicious = 0;
  const sample = Math.min(bytes.length, 8000);
  for (let i = 0; i < sample; i++) {
    const b = bytes[i]!;
    if (b === 9 || b === 10 || b === 13) continue;
    if (b < 32 || b === 127) suspicious++;
  }
  return suspicious / sample < 0.02;
}

async function sanitizePreviewHtml(rawHtml: string): Promise<string> {
  const { default: DOMPurify } = await import("dompurify");
  return DOMPurify.sanitize(rawHtml, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form", "input"],
    FORBID_ATTR: ["style", "onerror", "onload", "onclick"],
  });
}

function basenamePath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function dirnamePath(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) return normalized.startsWith("/") ? "/" : ".";
  return normalized.slice(0, lastSlash);
}

function isAbsolutePath(p: string): boolean {
  return /^\//.test(p) || /^[A-Za-z]:[\\/]/.test(p);
}

function resolveRelativePath(base: string, relative: string): string {
  if (isAbsolutePath(relative)) return relative;
  const dir = dirnamePath(base);
  const parts = dir.split("/").filter(Boolean);
  for (const segment of relative.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== ".") parts.push(segment);
  }
  const joined = parts.join("/");
  return dir.startsWith("/") ? "/" + joined : joined;
}

const previewStreamdownPlugins = { cjk, code, math, mermaid };

type HastNode = {
  type?: string;
  tagName?: string;
  url?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

function createRemarkResolveRelativeLinks(previewFilePath: string) {
  return () => (tree: HastNode) => {
    visitLinks(tree, (node) => {
      const href = node.url ?? (node.properties?.href as string | undefined);
      if (!href) return;

      if (/^https?:|^mailto:|^tel:|^#|^cowork-file:|^cowork-external:/.test(href)) return;

      let localPath: string | null = null;

      if (href.startsWith("file:")) {
        try {
          const parsed = new URL(href);
          const pathname = decodeURIComponent(parsed.pathname);
          if (/^\/[a-zA-Z]:/.test(pathname)) localPath = pathname.slice(1).replace(/\//g, "\\");
          else localPath = pathname;
        } catch { /* not a valid URL, skip */ }
      } else if (!isAbsolutePath(href)) {
        const decodedHref = decodeURIComponent(href.split("#")[0]?.split("?")[0] ?? href);
        localPath = resolveRelativePath(previewFilePath, decodedHref);
      }

      if (localPath) {
        const encoded = `cowork-file://open?path=${encodeURIComponent(localPath)}`;
        if (node.url !== undefined) node.url = encoded;
        if (node.properties?.href !== undefined) node.properties.href = encoded;
      }
    });
  };
}

function visitLinks(node: HastNode, fn: (n: HastNode) => void): void {
  if (node.type === "link" || (node.type === "element" && node.tagName === "a")) {
    fn(node);
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) visitLinks(child, fn);
  }
}

export function FilePreviewModal() {
  const filePreview = useAppStore((s) => s.filePreview);
  const closeFilePreview = useAppStore((s) => s.closeFilePreview);

  const path = filePreview?.path ?? null;
  const kind = path ? getFilePreviewKind(path) : "unknown";

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [docxHtml, setDocxHtml] = useState<string | null>(null);
  const [docxLayout, setDocxLayout] = useState<DocxPreviewLayout | null>(null);
  const [preferredFileApp, setPreferredFileApp] = useState<string | null>(null);
  const [xlsxHtml, setXlsxHtml] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  const revokeBlob = useCallback(() => {
    setBlobUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, []);

  useEffect(() => {
    if (!path) {
      setLoading(false);
      setError(null);
      setTruncated(false);
      setTextContent(null);
      setDocxHtml(null);
      setDocxLayout(null);
      setPreferredFileApp(null);
      setXlsxHtml(null);
      revokeBlob();
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setTruncated(false);
    setTextContent(null);
    setDocxHtml(null);
    setDocxLayout(null);
    setPreferredFileApp(null);
    setXlsxHtml(null);
    revokeBlob();

    void (async () => {
      try {
        const [result, preferredApp] = await Promise.all([
          readFileForPreview({ path }),
          getPreferredFileApp({ path }).catch(() => null),
        ]);
        if (controller.signal.aborted) return;
        setTruncated(result.truncated);
        setPreferredFileApp(preferredApp);
        const bytes = result.bytes;
        const previewKind = getFilePreviewKind(path);

        if (previewKind === "pdf" || previewKind === "image") {
          const mime = mimeForPreviewKind(previewKind, getExtensionLower(path));
          const blob = new Blob([bytes as BlobPart], { type: mime });
          const url = URL.createObjectURL(blob);
          if (controller.signal.aborted) {
            URL.revokeObjectURL(url);
            return;
          }
          setBlobUrl(url);
          setLoading(false);
          return;
        }

        if (previewKind === "markdown" || previewKind === "text") {
          setTextContent(decodeUtf8(bytes));
          setLoading(false);
          return;
        }

        if (previewKind === "docx") {
          const { default: mammoth } = await import("mammoth");
          if (controller.signal.aborted) return;
          const arrayBuffer = bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer;
          const [htmlResult, layout] = await Promise.all([
            mammoth.convertToHtml(
              { arrayBuffer },
              { styleMap: ["p[style-id='Subtitle'] => p.docx-subtitle:fresh"] },
            ),
            loadDocxPreviewLayout(arrayBuffer),
          ]);
          if (controller.signal.aborted) return;
          const sanitized = await sanitizePreviewHtml(htmlResult.value);
          if (controller.signal.aborted) return;
          setDocxHtml(decorateDocxPreviewHtml(sanitized));
          setDocxLayout(layout);
          setLoading(false);
          return;
        }

        if (previewKind === "xlsx") {
          const XLSX = await import("xlsx");
          if (controller.signal.aborted) return;
          const wb = XLSX.read(bytes, { type: "array" });
          const firstName = wb.SheetNames[0];
          if (!firstName) {
            setXlsxHtml("<p class=\"text-muted-foreground\">Empty workbook.</p>");
          } else {
            const sheet = wb.Sheets[firstName];
            if (!sheet) {
              setXlsxHtml("<p class=\"text-muted-foreground\">Could not read sheet.</p>");
            } else {
              const range = XLSX.utils.decode_range(sheet["!ref"] ?? "A1");
              const cappedRange = {
                s: range.s,
                e: {
                  r: Math.min(range.e.r, range.s.r + XLSX_MAX_ROWS - 1),
                  c: Math.min(range.e.c, range.s.c + XLSX_MAX_COLS - 1),
                },
              };
              const cappedRef = XLSX.utils.encode_range(cappedRange);
              const cappedSheet = { ...sheet, "!ref": cappedRef };
              const html = XLSX.utils.sheet_to_html(cappedSheet, { id: "preview-sheet" });
              const note =
                range.e.r - range.s.r + 1 > XLSX_MAX_ROWS || range.e.c - range.s.c + 1 > XLSX_MAX_COLS
                  ? `<p class="text-xs text-muted-foreground mb-2">Showing up to ${XLSX_MAX_ROWS} rows and ${XLSX_MAX_COLS} columns.</p>`
                  : "";
              const sanitized = await sanitizePreviewHtml(note + html);
              if (controller.signal.aborted) return;
              setXlsxHtml(sanitized);
            }
          }
          setLoading(false);
          return;
        }

        if (previewKind === "unsupported") {
          setLoading(false);
          return;
        }

        if (looksMostlyText(bytes)) {
          setTextContent(decodeUtf8(bytes));
        }
        setLoading(false);
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    })();

    return () => {
      controller.abort();
    };
  }, [path, revokeBlob]);

  useEffect(() => {
    return () => {
      revokeBlob();
    };
  }, [revokeBlob]);

  const titleName = path ? basenamePath(path) : "";

  const kindLabel = useMemo(() => {
    const labels: Record<FilePreviewKind, string> = {
      markdown: "Markdown",
      text: "Text",
      pdf: "PDF",
      image: "Image",
      docx: "Word",
      xlsx: "Excel",
      unsupported: "Unsupported",
      unknown: "File",
    };
    return labels[kind];
  }, [kind]);

  const handleOpenChange = (open: boolean) => {
    if (!open) closeFilePreview();
  };

  const openExternal = () => {
    if (path) void openPath({ path }).catch(() => {});
  };

  const mdRemarkPlugins = useMemo(() => {
    if (!path) return [defaultRemarkPlugins.gfm, remarkRewriteDesktopFileLinks];
    return [
      defaultRemarkPlugins.gfm,
      createRemarkResolveRelativeLinks(path),
      remarkRewriteDesktopFileLinks,
    ];
  }, [path]);

  const isOpen = path !== null;

  const showFallback =
    !loading &&
    !error &&
    kind === "unsupported" &&
    !textContent &&
    !docxHtml &&
    !xlsxHtml &&
    !blobUrl;

  const showUnknownAsText =
    !loading && !error && kind === "unknown" && textContent !== null && !blobUrl;

  const showUnknownFallback =
    !loading && !error && kind === "unknown" && textContent === null && !blobUrl;

  const openButtonLabel = preferredFileApp ? `Open in ${preferredFileApp}` : "Open";

  const docxPreviewStyle = useMemo(() => {
    if (!docxHtml) return undefined;
    return {
      fontFamily: `'${docxLayout?.fontFamily ?? "Aptos"}', 'Aptos Display', 'Calibri', 'Carlito', 'Segoe UI', system-ui, sans-serif`,
      ["--docx-accent" as string]: docxLayout?.accentColor ?? "var(--accent)",
      ["--docx-title" as string]: docxLayout?.titleColor ?? "var(--text-primary)",
      ["--docx-body" as string]: docxLayout?.bodyColor ?? "var(--text-primary)",
      ["--docx-muted" as string]: docxLayout?.mutedColor ?? "var(--text-muted)",
      ["--docx-divider" as string]: docxLayout?.dividerColor ?? "var(--warning)",
    } satisfies CSSProperties;
  }, [docxHtml, docxLayout]);

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className={cn("app-surface-opaque flex flex-col gap-0 overflow-hidden p-0", kind === "pdf" ? "h-[96vh] max-w-6xl" : "max-h-[90vh] max-w-5xl")}>
        <DialogHeader className="shrink-0 space-y-3 border-b border-border/60 px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <DialogTitle className="truncate text-lg">{titleName}</DialogTitle>
                <Badge variant="secondary">{kindLabel}</Badge>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={openExternal}>
                <ExternalLinkIcon className="mr-1 size-3.5" />
                {openButtonLabel}
              </Button>
            </div>
          </div>
          {truncated ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <span>
                Preview truncated — only the first portion of this file is shown. Open the file in its default app for the full contents.
              </span>
              <Button type="button" size="sm" variant="outline" onClick={openExternal}>
                <ExternalLinkIcon className="mr-1 size-3.5" />
                Open full file
              </Button>
            </div>
          ) : null}
        </DialogHeader>

        <div
          data-file-preview-content="true"
          className={cn(
            "min-h-0 flex-1",
            kind === "pdf" ? "overflow-hidden p-0" : "overflow-y-auto px-5 py-4",
            kind === "docx" && docxHtml && "bg-white px-6 py-6",
          )}
        >
          {loading ? (
            <div className="py-16 text-center text-sm text-muted-foreground">Loading preview…</div>
          ) : error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">{error}</div>
          ) : kind === "pdf" && blobUrl ? (
            <embed src={blobUrl} type="application/pdf" className="h-full w-full" title={titleName} />
          ) : kind === "image" && blobUrl ? (
            <img src={blobUrl} alt={titleName} className="mx-auto block max-h-[min(72vh,720px)] max-w-full object-contain" />
          ) : (kind === "markdown" || kind === "text") && textContent !== null ? (
            kind === "markdown" ? (
              <div data-file-preview-markdown-shell="true" className="mx-auto w-full max-w-[78ch]">
                <Streamdown
                  className="leading-7 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_a]:underline [&_code]:rounded-sm [&_code]:bg-muted/45 [&_code]:px-1.5 [&_code]:py-0.5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border/80 [&_pre]:bg-muted/35 [&_pre]:p-3"
                  components={{ a: DesktopMessageLink }}
                  plugins={previewStreamdownPlugins}
                  remarkPlugins={mdRemarkPlugins}
                  rehypePlugins={defaultDesktopRehypePlugins}
                >
                  {textContent}
                </Streamdown>
              </div>
            ) : (
              <CodeFilePreview content={textContent} filePath={path ?? ""} />
            )
          ) : kind === "docx" && docxHtml ? (
            <div
              className={cn(
                "docx-preview mx-auto min-h-[11in] w-[8.5in] max-w-full rounded-sm border border-border/60 bg-white px-[1in] py-[1in] text-black shadow-sm",
                "[&_.docx-title]:mb-3 [&_.docx-title]:text-[22pt] [&_.docx-title]:font-bold [&_.docx-title]:leading-[1.2] [&_.docx-title]:tracking-[-0.01em] [&_.docx-title]:text-[var(--docx-title)]",
                "[&_.docx-subtitle]:mb-3 [&_.docx-subtitle]:text-[11pt] [&_.docx-subtitle]:italic [&_.docx-subtitle]:leading-[1.35] [&_.docx-subtitle]:text-[var(--docx-accent)]",
                "[&_.docx-byline]:mb-2 [&_.docx-byline]:text-[10pt] [&_.docx-byline]:font-semibold [&_.docx-byline]:leading-[1.3] [&_.docx-byline]:text-[var(--docx-title)]",
                "[&_.docx-note]:mb-5 [&_.docx-note]:text-[9pt] [&_.docx-note]:italic [&_.docx-note]:leading-[1.45] [&_.docx-note]:text-[var(--docx-muted)]",
                "[&_.docx-divider]:mb-8 [&_.docx-divider]:h-px [&_.docx-divider]:w-full [&_.docx-divider]:bg-[var(--docx-divider)]",
                "[&_h1]:mb-2 [&_h1]:mt-8 [&_h1]:text-[14pt] [&_h1]:font-bold [&_h1]:leading-[1.25] [&_h1]:text-[var(--docx-accent)]",
                "[&_h2]:mb-1 [&_h2]:mt-5 [&_h2]:text-[16pt] [&_h2]:font-semibold [&_h2]:leading-snug",
                "[&_h3]:mb-1 [&_h3]:mt-4 [&_h3]:text-[13pt] [&_h3]:font-semibold [&_h3]:leading-snug",
                "[&_h4]:mb-1 [&_h4]:mt-3 [&_h4]:text-[11pt] [&_h4]:font-semibold",
                "[&_p]:my-[6pt] [&_p]:text-[11pt] [&_p]:leading-[1.45] [&_p]:text-[var(--docx-body)]",
                "[&_ul]:my-[6pt] [&_ul]:list-disc [&_ul]:pl-8 [&_ol]:my-[6pt] [&_ol]:list-decimal [&_ol]:pl-8",
                "[&_li]:my-[2pt] [&_li]:text-[11pt] [&_li]:leading-[1.45]",
                "[&_.docx-table]:my-6 [&_.docx-table]:w-full [&_.docx-table]:border-collapse",
                "[&_.docx-cell]:border [&_.docx-cell]:border-border/70 [&_.docx-cell]:px-2.5 [&_.docx-cell]:py-2 [&_.docx-cell]:align-top",
                "[&_.docx-table-paragraph]:my-0 [&_.docx-table-paragraph]:text-[10pt] [&_.docx-table-paragraph]:leading-[1.35]",
                "[&_tr:first-child_.docx-cell]:bg-muted/20 [&_tr:first-child_.docx-table-paragraph]:font-semibold",
                "[&_a]:text-primary [&_a]:underline [&_img]:max-w-full [&_blockquote]:border-l-[3px] [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:italic",
                "[&_strong]:font-semibold [&_em]:italic",
              )}
              style={docxPreviewStyle}
            >
              {docxLayout?.headerImageSrc ? (
                <div className="mb-6">
                  <img
                    src={docxLayout.headerImageSrc}
                    alt="Document header"
                    className="block h-auto max-w-full"
                    style={docxLayout.headerImageWidthPx ? { width: `${docxLayout.headerImageWidthPx}px` } : undefined}
                  />
                </div>
              ) : null}
              <div dangerouslySetInnerHTML={{ __html: docxHtml }} />
              {docxLayout?.footerText ? (
                <div
                  data-file-preview-docx-footer="true"
                  className="mt-10 text-[8pt] leading-[1.3] text-[var(--docx-muted)]"
                >
                  {docxLayout.footerText}
                </div>
              ) : null}
            </div>
          ) : kind === "xlsx" && xlsxHtml ? (
            <div
              className="preview-xlsx overflow-x-auto text-sm [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1"
              dangerouslySetInnerHTML={{ __html: xlsxHtml }}
            />
          ) : showUnknownAsText ? (
            <CodeFilePreview content={textContent} filePath={path ?? ""} />
          ) : showFallback || showUnknownFallback ? (
            <div className="space-y-4 py-8 text-center">
              <p className="text-sm text-muted-foreground">
                {kind === "unsupported"
                  ? "No in-app preview for this format."
                  : "Could not detect a text preview for this file."}
              </p>
              <Button type="button" onClick={openExternal}>
                {openButtonLabel}
              </Button>
            </div>
          ) : null}
        </div>

        <DialogFooter className="shrink-0 border-t border-border/60 px-5 py-3">
          <Button type="button" variant="secondary" onClick={() => closeFilePreview()}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
