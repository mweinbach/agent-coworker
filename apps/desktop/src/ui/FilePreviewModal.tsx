import { useCallback, useEffect, useMemo, useState } from "react";
import mammoth from "mammoth";
import { Streamdown } from "streamdown";
import * as XLSX from "xlsx";
import { ExternalLinkIcon, FolderOpenIcon } from "lucide-react";

import { useAppStore } from "../app/store";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { openPath, readFileForPreview, revealPath } from "../lib/desktopCommands";
import { getExtensionLower, getFilePreviewKind, mimeForPreviewKind, type FilePreviewKind } from "../lib/filePreviewKind";

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  if (buf instanceof SharedArrayBuffer) {
    const copy = new ArrayBuffer(u8.byteLength);
    new Uint8Array(copy).set(u8);
    return copy;
  }
  return buf;
}

const XLSX_MAX_ROWS = 200;
const XLSX_MAX_COLS = 40;

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

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

function basenamePath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function FilePreviewModal() {
  const filePreview = useAppStore((s) => s.filePreview);
  const closeFilePreview = useAppStore((s) => s.closeFilePreview);

  const path = filePreview?.path ?? null;
  const ext = path ? getExtensionLower(path) : "";
  const kind = path ? getFilePreviewKind(path) : "unknown";

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [docxHtml, setDocxHtml] = useState<string | null>(null);
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
      setXlsxHtml(null);
      revokeBlob();
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setTruncated(false);
    setTextContent(null);
    setDocxHtml(null);
    setXlsxHtml(null);
    revokeBlob();

    void (async () => {
      try {
        const result = await readFileForPreview({ path });
        if (cancelled) return;
        setTruncated(result.truncated);
        const bytes = base64ToUint8Array(result.base64);
        const previewKind = getFilePreviewKind(path);

        if (previewKind === "pdf" || previewKind === "image") {
          const mime = mimeForPreviewKind(previewKind, ext);
          const blob = new Blob([new Uint8Array(bytes)], { type: mime });
          const url = URL.createObjectURL(blob);
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
          const htmlResult = await mammoth.convertToHtml({ arrayBuffer: toArrayBuffer(bytes) });
          if (cancelled) return;
          setDocxHtml(htmlResult.value);
          setLoading(false);
          return;
        }

        if (previewKind === "xlsx") {
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
              setXlsxHtml(note + html);
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
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [path, ext, revokeBlob]);

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

  const reveal = () => {
    if (path) void revealPath({ path }).catch(() => {});
  };

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

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[90vh] max-w-5xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 space-y-2 border-b border-border/60 px-5 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <DialogTitle className="truncate text-lg">{titleName}</DialogTitle>
                <Badge variant="secondary">{kindLabel}</Badge>
              </div>
              <DialogDescription className="font-mono text-xs text-muted-foreground break-all">
                {path}
              </DialogDescription>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={reveal}>
                <FolderOpenIcon className="mr-1 size-3.5" />
                Reveal
              </Button>
              <Button type="button" variant="default" size="sm" onClick={openExternal}>
                <ExternalLinkIcon className="mr-1 size-3.5" />
                Open externally
              </Button>
            </div>
          </div>
          {truncated ? (
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              Preview truncated (file larger than the in-app limit). Open externally for the full file.
            </div>
          ) : null}
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="py-16 text-center text-sm text-muted-foreground">Loading preview…</div>
          ) : error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">{error}</div>
          ) : kind === "pdf" && blobUrl ? (
            <embed src={blobUrl} type="application/pdf" className="h-[min(72vh,720px)] w-full rounded-md border border-border/80" title={titleName} />
          ) : kind === "image" && blobUrl ? (
            <div className="flex justify-center">
              <img src={blobUrl} alt={titleName} className="max-h-[min(72vh,720px)] max-w-full object-contain" />
            </div>
          ) : (kind === "markdown" || kind === "text") && textContent !== null ? (
            kind === "markdown" ? (
              <Streamdown className="max-w-none leading-7 [&>*:first-child]:mt-0 [&_a]:underline [&_code]:rounded-sm [&_code]:bg-muted/45 [&_code]:px-1.5 [&_code]:py-0.5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border/80 [&_pre]:bg-muted/35 [&_pre]:p-3">
                {textContent}
              </Streamdown>
            ) : (
              <pre className="whitespace-pre-wrap break-words rounded-md border border-border/80 bg-muted/25 p-3 font-mono text-xs leading-relaxed">{textContent}</pre>
            )
          ) : kind === "docx" && docxHtml ? (
            <iframe
              title="Word preview"
              sandbox="allow-same-origin"
              className="h-[min(72vh,720px)] w-full rounded-md border border-border/80 bg-background"
              srcDoc={`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:system-ui,sans-serif;padding:12px;line-height:1.5;color:var(--text-primary);background:var(--background);}</style></head><body>${docxHtml}</body></html>`}
            />
          ) : kind === "xlsx" && xlsxHtml ? (
            <div
              className="preview-xlsx overflow-x-auto text-sm [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1"
              dangerouslySetInnerHTML={{ __html: xlsxHtml }}
            />
          ) : showUnknownAsText ? (
            <pre className="whitespace-pre-wrap break-words rounded-md border border-border/80 bg-muted/25 p-3 font-mono text-xs leading-relaxed">{textContent}</pre>
          ) : showFallback || showUnknownFallback ? (
            <div className="space-y-4 py-8 text-center">
              <p className="text-sm text-muted-foreground">
                {kind === "unsupported"
                  ? "No in-app preview for this format."
                  : "Could not detect a text preview for this file."}
              </p>
              <Button type="button" onClick={openExternal}>
                Open externally
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
