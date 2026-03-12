import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import TurndownService from "turndown";

import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";
import { resolveMaybeRelative, truncateText } from "../utils/paths";
import { assertWritePathAllowed } from "../utils/permissions";
import { resolveSafeWebUrl } from "../utils/webSafety";

const MAX_REDIRECTS = 5;
let responseTimeoutMs = 5_000;
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);
const DOWNLOADABLE_DOCUMENT_EXTENSIONS = new Set([
  ".csv",
  ".doc",
  ".docm",
  ".docx",
  ".epub",
  ".md",
  ".markdown",
  ".odp",
  ".ods",
  ".odt",
  ".pdf",
  ".ppt",
  ".pptm",
  ".pptx",
  ".rtf",
  ".tsv",
  ".xls",
  ".xlsm",
  ".xlsx",
]);
const DOWNLOADABLE_DOCUMENT_MIME_TYPES = new Map<string, string>([
  ["application/epub+zip", ".epub"],
  ["application/msword", ".doc"],
  ["application/pdf", ".pdf"],
  ["application/rtf", ".rtf"],
  ["application/vnd.ms-excel", ".xls"],
  ["application/vnd.ms-excel.sheet.macroenabled.12", ".xlsm"],
  ["application/vnd.ms-powerpoint", ".ppt"],
  ["application/vnd.ms-powerpoint.presentation.macroenabled.12", ".pptm"],
  ["application/vnd.ms-word.document.macroenabled.12", ".docm"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
  ["application/vnd.oasis.opendocument.presentation", ".odp"],
  ["application/vnd.oasis.opendocument.spreadsheet", ".ods"],
  ["application/vnd.oasis.opendocument.text", ".odt"],
  ["text/csv", ".csv"],
  ["text/markdown", ".md"],
  ["text/rtf", ".rtf"],
  ["text/tab-separated-values", ".tsv"],
  ["text/x-markdown", ".md"],
]);
let readabilityDepsPromise: Promise<{
  Readability: typeof import("@mozilla/readability").Readability;
  JSDOM: typeof import("jsdom").JSDOM;
}> | null = null;

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isDesktopBundleRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COWORK_DESKTOP_BUNDLE === "1";
}

function normalizeMimeType(contentType: string | null): string | null {
  if (!contentType) return null;
  const [rawMimeType] = contentType.split(";", 1);
  const normalized = rawMimeType?.trim().toLowerCase();
  return normalized || null;
}

function supportedImageMimeTypeFromUrl(url: string): string | null {
  const pathname = safeUrlPathname(url)?.toLowerCase() ?? "";
  if (pathname.endsWith(".png")) return "image/png";
  if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return "image/jpeg";
  if (pathname.endsWith(".webp")) return "image/webp";
  if (pathname.endsWith(".gif")) return "image/gif";
  return null;
}

function safeUrlPathname(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function baseNameFromUrl(url: string): string | null {
  const pathname = safeUrlPathname(url);
  if (!pathname) return null;
  const baseName = path.posix.basename(pathname);
  if (!baseName || baseName === "/" || baseName === ".") return null;
  return safeDecodeURIComponent(baseName);
}

function extractContentDispositionFilename(contentDisposition: string | null): string | null {
  if (!contentDisposition) return null;

  const extendedMatch = contentDisposition.match(/filename\*\s*=\s*([^;]+)/i);
  if (extendedMatch?.[1]) {
    const raw = extendedMatch[1].trim();
    const unquoted = raw.replace(/^"(.*)"$/, "$1");
    const charsetSep = unquoted.indexOf("''");
    const encodedName = charsetSep >= 0 ? unquoted.slice(charsetSep + 2) : unquoted;
    const decoded = safeDecodeURIComponent(encodedName);
    if (decoded.trim()) return decoded;
  }

  const basicMatch = contentDisposition.match(/filename\s*=\s*("(?:[^"]*)"|[^;]+)/i);
  if (!basicMatch?.[1]) return null;
  const unquoted = basicMatch[1].trim().replace(/^"(.*)"$/, "$1");
  return unquoted.trim() ? unquoted : null;
}

function extensionFromName(fileName: string | null): string | null {
  if (!fileName) return null;
  const ext = path.extname(fileName).toLowerCase();
  return ext || null;
}

function documentExtensionFromMimeType(contentType: string | null): string | null {
  const normalized = normalizeMimeType(contentType);
  if (!normalized) return null;
  return DOWNLOADABLE_DOCUMENT_MIME_TYPES.get(normalized) ?? null;
}

function isDownloadableDocumentFilename(fileName: string | null): boolean {
  const ext = extensionFromName(fileName);
  return ext ? DOWNLOADABLE_DOCUMENT_EXTENSIONS.has(ext) : false;
}

function sanitizeDownloadFileName(fileName: string): string {
  const baseName = path.basename(fileName);
  const sanitized = baseName
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");

  return sanitized && sanitized !== "." && sanitized !== ".." ? sanitized : "download";
}

function chooseDownloadFileName(opts: {
  contentType: string | null;
  resolvedUrl: string;
  contentDisposition: string | null;
}): string {
  const contentDispositionName = extractContentDispositionFilename(opts.contentDisposition);
  const urlBaseName = baseNameFromUrl(opts.resolvedUrl);
  const mimeExtension = documentExtensionFromMimeType(opts.contentType);

  let fileName = sanitizeDownloadFileName(contentDispositionName ?? urlBaseName ?? "download");
  if (!extensionFromName(fileName) && mimeExtension) {
    fileName += mimeExtension;
  }

  return fileName;
}

async function ensureUniqueDownloadPath(downloadDir: string, fileName: string): Promise<string> {
  const ext = path.extname(fileName);
  const baseName = path.basename(fileName, ext) || "download";

  for (let suffix = 1; ; suffix += 1) {
    const candidateName = suffix === 1 ? `${baseName}${ext}` : `${baseName}-${suffix}${ext}`;
    const candidatePath = path.join(downloadDir, candidateName);
    try {
      await fs.access(candidatePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return candidatePath;
      throw error;
    }
  }
}

function classifyResponseContent(
  contentType: string | null,
  resolvedUrl: string,
  contentDisposition: string | null
): { kind: "text" } | { kind: "image"; mimeType: string } | { kind: "download"; fileName: string } {
  const normalized = normalizeMimeType(contentType);
  if (normalized && SUPPORTED_IMAGE_MIME_TYPES.has(normalized)) {
    return {
      kind: "image",
      mimeType: normalized === "image/jpg" ? "image/jpeg" : normalized,
    };
  }

  const inferredImageMimeType = supportedImageMimeTypeFromUrl(resolvedUrl);
  if ((!normalized || normalized === "application/octet-stream") && inferredImageMimeType) {
    return { kind: "image", mimeType: inferredImageMimeType };
  }

  const contentDispositionName = extractContentDispositionFilename(contentDisposition);
  const urlBaseName = baseNameFromUrl(resolvedUrl);
  const downloadableByMime = documentExtensionFromMimeType(contentType);
  const downloadableByName =
    isDownloadableDocumentFilename(contentDispositionName) || isDownloadableDocumentFilename(urlBaseName);

  if (downloadableByMime || ((!normalized || normalized === "application/octet-stream" || normalized === "text/plain") && downloadableByName)) {
    return {
      kind: "download",
      fileName: chooseDownloadFileName({ contentType, resolvedUrl, contentDisposition }),
    };
  }

  if (!normalized) return { kind: "text" };
  if (normalized.startsWith("text/")) return { kind: "text" };
  if (normalized.includes("json")) return { kind: "text" };
  if (normalized.includes("xml")) return { kind: "text" };
  if (normalized.includes("javascript")) return { kind: "text" };
  throw new Error(`Blocked non-text content type: ${contentType}`);
}

function buildPinnedUrl(resolved: { url: URL; addresses: { address: string; family: number }[] }): {
  pinnedUrl: URL;
  hostHeader: string;
} {
  const addr = resolved.addresses[0];
  if (!addr) throw new Error(`Blocked unresolved host: ${resolved.url.hostname}`);

  const pinnedUrl = new URL(resolved.url.toString());
  const hostHeader = pinnedUrl.host;
  pinnedUrl.hostname = addr.family === 6 ? `[${addr.address}]` : addr.address;
  return { pinnedUrl, hostHeader };
}

async function fetchWithSafeRedirects(url: string, abortSignal?: AbortSignal): Promise<Response> {
  let current = await resolveSafeWebUrl(url);

  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    const { pinnedUrl, hostHeader } = buildPinnedUrl(current);
    const timeoutController = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, responseTimeoutMs);
    const onAbort = () => {
      timeoutController.abort();
    };

    if (abortSignal) {
      if (abortSignal.aborted) {
        onAbort();
      } else {
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }
    }

    let res: Response;
    try {
      res = await fetch(pinnedUrl, {
        redirect: "manual",
        headers: {
          "User-Agent": "agent-coworker/0.1",
          Host: hostHeader,
        },
        signal: timeoutController.signal,
      });
    } catch (error) {
      if (timedOut) {
        throw new Error(`webFetch timed out waiting for an initial response after ${responseTimeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      abortSignal?.removeEventListener("abort", onAbort);
    }

    if (!isRedirectStatus(res.status)) return res;

    const location = res.headers.get("location");
    if (!location) {
      throw new Error(`Redirect missing location header: ${current.url.toString()}`);
    }

    const next = new URL(location, current.url).toString();
    current = await resolveSafeWebUrl(next);
  }

  throw new Error(`Too many redirects while fetching URL: ${url}`);
}

async function loadReadabilityDeps(): Promise<{
  Readability: typeof import("@mozilla/readability").Readability;
  JSDOM: typeof import("jsdom").JSDOM;
}> {
  if (!readabilityDepsPromise) {
    readabilityDepsPromise = Promise.all([import("@mozilla/readability"), import("jsdom")]).then(
      ([readabilityMod, jsdomMod]) => ({
        Readability: readabilityMod.Readability,
        JSDOM: jsdomMod.JSDOM,
      })
    );
  }

  return readabilityDepsPromise;
}

async function htmlToMarkdown(html: string, finalUrl: string, ctx: ToolContext): Promise<string> {
  const turndown = new TurndownService();

  // Bun-compiled desktop sidecars cannot reliably load jsdom's stylesheet asset at
  // startup, so skip the readability pass there and degrade to direct HTML->Markdown.
  if (isDesktopBundleRuntime()) {
    return turndown.turndown(html);
  }

  try {
    const { Readability, JSDOM } = await loadReadabilityDeps();
    const dom = new JSDOM(html, { url: finalUrl });
    const article = new Readability(dom.window.document).parse();
    return article?.content ? turndown.turndown(article.content) : turndown.turndown(html);
  } catch (error) {
    ctx.log(`tool! webFetch readability fallback ${JSON.stringify({ reason: String(error) })}`);
    return turndown.turndown(html);
  }
}

export const __internal = {
  getResponseTimeoutMs: () => responseTimeoutMs,
  isDesktopBundleRuntime,
  setResponseTimeoutMs: (ms: number) => {
    responseTimeoutMs = ms;
  },
};

export function createWebFetchTool(ctx: ToolContext) {
  return defineTool({
    description:
      "Fetch a URL and return clean markdown for web pages, visual content for supported direct image URLs, or save supported document downloads into the workspace Downloads folder and return the local path.",
    inputSchema: z.object({
      url: z.string().url().describe("URL to fetch"),
      maxLength: z.number().int().min(1000).max(200000).optional().default(50000),
    }),
    execute: async ({ url, maxLength }: { url: string; maxLength: number }) => {
      ctx.log(`tool> webFetch ${JSON.stringify({ url, maxLength })}`);

      const res = await fetchWithSafeRedirects(url, ctx.abortSignal);
      if (!res.ok) {
        throw new Error(`webFetch failed: ${res.status} ${res.statusText}`);
      }
      const finalUrl = (await resolveSafeWebUrl(res.url || url)).url.toString();
      const contentKind = classifyResponseContent(
        res.headers.get("content-type"),
        finalUrl,
        res.headers.get("content-disposition")
      );
      if (contentKind.kind === "image") {
        const bytes = Buffer.from(await res.arrayBuffer());
        const result = {
          type: "content",
          content: [
            { type: "text", text: `Image URL: ${finalUrl}` },
            { type: "image", data: bytes.toString("base64"), mimeType: contentKind.mimeType },
          ],
        };
        ctx.log(
          `tool< webFetch ${JSON.stringify({
            image: true,
            mimeType: contentKind.mimeType,
            bytes: bytes.length,
          })}`
        );
        return result;
      }

      if (contentKind.kind === "download") {
        const downloadDir = resolveMaybeRelative("Downloads", ctx.config.workingDirectory);
        const targetPath = await ensureUniqueDownloadPath(downloadDir, contentKind.fileName);
        const allowedTargetPath = await assertWritePathAllowed(targetPath, ctx.config, "write");
        await fs.mkdir(path.dirname(allowedTargetPath), { recursive: true });
        const bytes = Buffer.from(await res.arrayBuffer());
        await fs.writeFile(allowedTargetPath, bytes);

        const out = `File downloaded ${allowedTargetPath}`;
        ctx.log(
          `tool< webFetch ${JSON.stringify({
            download: true,
            path: allowedTargetPath,
            bytes: bytes.length,
          })}`
        );
        return out;
      }

      const html = await res.text();
      const md = await htmlToMarkdown(html, finalUrl, ctx);

      const out = truncateText(md, maxLength);
      ctx.log(`tool< webFetch ${JSON.stringify({ chars: out.length })}`);
      return out;
    },
  });
}
