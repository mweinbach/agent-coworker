import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import TurndownService from "turndown";
import { z } from "zod";

import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";
import { fetchExaContents, resolveExaApiKey } from "./exa";
import { resolveMaybeRelative, truncateText } from "../utils/paths";
import { assertWritePathAllowed } from "../utils/permissions";
import { resolveSafeWebUrl } from "../utils/webSafety";

const MAX_REDIRECTS = 5;
const DEFAULT_MAX_WEBFETCH_DOWNLOAD_BYTES = 50 * 1024 * 1024;
let responseTimeoutMs = 5_000;
let maxDownloadBytes = DEFAULT_MAX_WEBFETCH_DOWNLOAD_BYTES;
let htmlToMarkdownOverrideForTests:
  | ((html: string, finalUrl: string, ctx: ToolContext) => Promise<string>)
  | null = null;
const SUPPORTED_IMAGE_MIME_TYPES = new Map<string, string>([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/jpg", ".jpg"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
]);
const DOWNLOADABLE_DOCUMENT_EXTENSIONS = new Set([
  ".csv",
  ".doc",
  ".docm",
  ".docx",
  ".epub",
  ".markdown",
  ".md",
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
  ["application/vnd.oasis.opendocument.presentation", ".odp"],
  ["application/vnd.oasis.opendocument.spreadsheet", ".ods"],
  ["application/vnd.oasis.opendocument.text", ".odt"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
  ["text/csv", ".csv"],
  ["text/markdown", ".md"],
  ["text/rtf", ".rtf"],
  ["text/tab-separated-values", ".tsv"],
  ["text/x-markdown", ".md"],
]);
const HTML_EXTENSIONS = new Set([".htm", ".html", ".xhtml"]);
let readabilityDepsPromise: Promise<{
  Readability: typeof import("@mozilla/readability").Readability;
  JSDOM: typeof import("jsdom").JSDOM;
}> | null = null;

type ClassifiedResponse =
  | { kind: "inline" }
  | { kind: "download"; category: "document" | "image"; fileName: string };

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

function isHtmlMimeType(contentType: string | null): boolean {
  const normalized = normalizeMimeType(contentType);
  return normalized === "text/html" || normalized === "application/xhtml+xml";
}

function normalizeSupportedImageMimeType(contentType: string | null): string | null {
  const normalized = normalizeMimeType(contentType);
  if (!normalized) return null;
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(normalized)) return null;
  return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

function supportedImageMimeTypeFromFileName(fileName: string | null): string | null {
  const extension = extensionFromName(fileName);
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
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

  const basicMatch = contentDisposition.match(/filename\s*=\s*("(?:[^\"]*)"|[^;]+)/i);
  if (!basicMatch?.[1]) return null;
  const unquoted = basicMatch[1].trim().replace(/^"(.*)"$/, "$1");
  return unquoted.trim() ? unquoted : null;
}

function extensionFromName(fileName: string | null): string | null {
  if (!fileName) return null;
  const ext = path.extname(fileName).toLowerCase();
  return ext || null;
}

function imageExtensionFromMimeType(contentType: string | null): string | null {
  const normalized = normalizeSupportedImageMimeType(contentType);
  if (!normalized) return null;
  return SUPPORTED_IMAGE_MIME_TYPES.get(normalized) ?? null;
}

function documentExtensionFromMimeType(contentType: string | null): string | null {
  const normalized = normalizeMimeType(contentType);
  if (!normalized) return null;
  return DOWNLOADABLE_DOCUMENT_MIME_TYPES.get(normalized) ?? null;
}

function fileExtensionFromMimeType(contentType: string | null): string | null {
  return imageExtensionFromMimeType(contentType) ?? documentExtensionFromMimeType(contentType);
}

function isStructuredInlineMimeType(contentType: string | null): boolean {
  const normalized = normalizeMimeType(contentType);
  if (!normalized) return false;
  return isHtmlMimeType(contentType)
    || normalized.includes("json")
    || normalized.includes("xml")
    || normalized.includes("javascript");
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

function normalizeDownloadFileNameExtension(fileName: string, mimeExtension: string | null): string {
  if (!mimeExtension) return fileName;

  const currentExtension = extensionFromName(fileName);
  if (!currentExtension) return `${fileName}${mimeExtension}`;
  if (currentExtension === mimeExtension) return fileName;

  return `${path.basename(fileName, currentExtension)}${mimeExtension}`;
}

function chooseDownloadFileName(opts: {
  contentType: string | null;
  resolvedUrl: string;
  contentDisposition: string | null;
  preferredFileName?: string | null;
}): string {
  const contentDispositionName = extractContentDispositionFilename(opts.contentDisposition);
  const urlBaseName = baseNameFromUrl(opts.resolvedUrl);
  const mimeExtension = fileExtensionFromMimeType(opts.contentType);

  let fileName = sanitizeDownloadFileName(
    opts.preferredFileName ?? contentDispositionName ?? urlBaseName ?? "download"
  );
  fileName = normalizeDownloadFileNameExtension(fileName, mimeExtension);

  return fileName;
}

function downloadCandidatePath(downloadDir: string, fileName: string, suffix: number): string {
  const ext = path.extname(fileName);
  const baseName = path.basename(fileName, ext) || "download";
  const candidateName = suffix === 1 ? `${baseName}${ext}` : `${baseName}-${suffix}${ext}`;
  return path.join(downloadDir, candidateName);
}

async function finalizeDownloadedFile(tempPath: string, downloadDir: string, fileName: string): Promise<string> {
  // Claim the final path exclusively at finalize time so a late writer cannot
  // be overwritten by an atomic rename onto an existing destination.
  for (let suffix = 1; ; suffix += 1) {
    const candidatePath = downloadCandidatePath(downloadDir, fileName, suffix);
    try {
      await fs.copyFile(tempPath, candidatePath, fsConstants.COPYFILE_EXCL);
      await removeTemporaryDownloadFile(tempPath);
      return candidatePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
}

function formatByteLimit(limitBytes: number): string {
  if (limitBytes >= 1024 * 1024 && limitBytes % (1024 * 1024) === 0) {
    return `${limitBytes / (1024 * 1024)} MiB`;
  }
  if (limitBytes >= 1024 && limitBytes % 1024 === 0) {
    return `${limitBytes / 1024} KiB`;
  }
  return `${limitBytes} bytes`;
}

class DownloadSizeLimitError extends Error {
  readonly limitBytes: number;

  constructor(limitBytes: number) {
    super(`webFetch download exceeded ${formatByteLimit(limitBytes)} limit`);
    this.name = "DownloadSizeLimitError";
    this.limitBytes = limitBytes;
  }
}

function parseContentLength(response: Response): number | null {
  const raw = response.headers.get("content-length");
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function temporaryDownloadPath(downloadDir: string, fileName: string): string {
  const ext = path.extname(fileName);
  const baseName = path.basename(fileName, ext) || "download";
  const tempName = [
    `.${baseName}`,
    process.pid,
    Date.now(),
    Math.random().toString(16).slice(2),
  ].join(".") + `${ext}.part`;
  return path.join(downloadDir, tempName);
}

async function removeTemporaryDownloadFile(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true }).catch(() => {});
}

async function downloadResponseToFile(opts: {
  response: Response;
  downloadDir: string;
  fileName: string;
  tempPath: string;
  maxBytes: number;
}): Promise<{ bytesWritten: number; finalPath: string }> {
  const declaredLength = parseContentLength(opts.response);
  if (declaredLength !== null && declaredLength > opts.maxBytes) {
    await opts.response.body?.cancel().catch(() => {});
    throw new DownloadSizeLimitError(opts.maxBytes);
  }

  try {
    if (!opts.response.body) {
      if (declaredLength === null) {
        throw new Error(
          "webFetch cannot safely download a direct-download response without a readable body or content-length header"
        );
      }

      const bytes = Buffer.from(await opts.response.arrayBuffer());
      if (bytes.length > opts.maxBytes) {
        throw new DownloadSizeLimitError(opts.maxBytes);
      }
      await fs.writeFile(opts.tempPath, bytes);
      const finalPath = await finalizeDownloadedFile(opts.tempPath, opts.downloadDir, opts.fileName);
      return { bytesWritten: bytes.length, finalPath };
    }

    const fileHandle = await fs.open(opts.tempPath, "w");
    const reader = opts.response.body.getReader();
    let bytesWritten = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;

        bytesWritten += value.byteLength;
        if (bytesWritten > opts.maxBytes) {
          throw new DownloadSizeLimitError(opts.maxBytes);
        }

        await fileHandle.write(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // no-op
      }
      await fileHandle.close().catch(() => {});
    }

    const finalPath = await finalizeDownloadedFile(opts.tempPath, opts.downloadDir, opts.fileName);
    return { bytesWritten, finalPath };
  } catch (error) {
    await removeTemporaryDownloadFile(opts.tempPath);
    throw error;
  }
}

function classifyResponseContent(
  contentType: string | null,
  resolvedUrl: string,
  contentDisposition: string | null
): ClassifiedResponse {
  const normalized = normalizeMimeType(contentType);
  const contentDispositionName = extractContentDispositionFilename(contentDisposition);
  const urlBaseName = baseNameFromUrl(resolvedUrl);
  const supportedImageMimeType = normalizeSupportedImageMimeType(contentType);
  if (supportedImageMimeType) {
    return {
      kind: "download",
      category: "image",
      fileName: chooseDownloadFileName({ contentType: supportedImageMimeType, resolvedUrl, contentDisposition }),
    };
  }

  const inferredImageMimeType =
    supportedImageMimeTypeFromFileName(contentDispositionName) ?? supportedImageMimeTypeFromFileName(urlBaseName);
  if ((!normalized || normalized === "application/octet-stream") && inferredImageMimeType) {
    return {
      kind: "download",
      category: "image",
      fileName: chooseDownloadFileName({ contentType: inferredImageMimeType, resolvedUrl, contentDisposition }),
    };
  }

  const downloadableByMime = documentExtensionFromMimeType(contentType);
  const downloadableByName =
    (isDownloadableDocumentFilename(contentDispositionName) ? contentDispositionName : null)
    ?? (isDownloadableDocumentFilename(urlBaseName) ? urlBaseName : null);

  if (downloadableByName && !isStructuredInlineMimeType(contentType)) {
    return {
      kind: "download",
      category: "document",
      fileName: chooseDownloadFileName({
        contentType: null,
        resolvedUrl,
        contentDisposition,
        preferredFileName: downloadableByName,
      }),
    };
  }

  if (downloadableByMime) {
    return {
      kind: "download",
      category: "document",
      fileName: chooseDownloadFileName({ contentType, resolvedUrl, contentDisposition }),
    };
  }

  if (!normalized) return { kind: "inline" };
  if (isHtmlMimeType(contentType)) return { kind: "inline" };
  if (normalized.startsWith("text/")) return { kind: "inline" };
  if (normalized.includes("json")) return { kind: "inline" };
  if (normalized.includes("xml")) return { kind: "inline" };
  if (normalized.includes("javascript")) return { kind: "inline" };
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

async function fetchWithInitialResponseTimeout(
  input: string | URL,
  init: RequestInit,
  abortSignal?: AbortSignal
): Promise<Response> {
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

  try {
    return await globalThis.fetch(input, {
      ...init,
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
}

async function fetchWithSafeRedirects(
  url: string,
  abortSignal?: AbortSignal
): Promise<{ response: Response; finalUrl: string }> {
  let current = await resolveSafeWebUrl(url);

  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    const { pinnedUrl, hostHeader } = buildPinnedUrl(current);
    const response = await fetchWithInitialResponseTimeout(
      pinnedUrl,
      {
        redirect: "manual",
        headers: {
          "User-Agent": "agent-coworker/0.1",
          Host: hostHeader,
        },
      },
      abortSignal
    );

    if (!isRedirectStatus(response.status)) {
      return {
        response,
        finalUrl: current.url.toString(),
      };
    }

    const location = response.headers.get("location");
    if (!location) {
      throw new Error(`Redirect missing location header: ${current.url.toString()}`);
    }

    const next = new URL(location, current.url).toString();
    current = await resolveSafeWebUrl(next);
  }

  throw new Error(`Too many redirects while fetching URL: ${url}`);
}

function createTurndownService(): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
  service.remove(["script", "style", "noscript", "template", "canvas"]);
  return service;
}

function stripHtmlNoise(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "")
    .replace(/<template\b[\s\S]*?<\/template>/gi, "")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, "");
}

function extractLikelyContentFragment(html: string): string {
  return (
    html.match(/<main\b[\s\S]*?<\/main>/i)?.[0]
    ?? html.match(/<article\b[\s\S]*?<\/article>/i)?.[0]
    ?? html.match(/<body\b[\s\S]*?<\/body>/i)?.[0]
    ?? html
  );
}

function fallbackHtmlToMarkdown(html: string): string {
  const turndown = createTurndownService();
  const cleanedHtml = stripHtmlNoise(extractLikelyContentFragment(html));
  return turndown.turndown(cleanedHtml).trim();
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
  if (isDesktopBundleRuntime()) {
    return fallbackHtmlToMarkdown(html);
  }

  try {
    const { Readability, JSDOM } = await loadReadabilityDeps();
    const dom = new JSDOM(html, { url: finalUrl });
    const article = new Readability(dom.window.document).parse();
    if (article?.content) {
      const articleMarkdown = fallbackHtmlToMarkdown(article.content);
      if (articleMarkdown) {
        if (article.title && !articleMarkdown.includes(article.title)) {
          return `# ${article.title}\n\n${articleMarkdown}`.trim();
        }
        return articleMarkdown;
      }
    }
  } catch (error) {
    ctx.log(`tool! webFetch readability fallback ${JSON.stringify({ reason: String(error) })}`);
  }

  return fallbackHtmlToMarkdown(html);
}

function looksLikeHtmlDocument(text: string): boolean {
  const trimmed = text.trimStart();
  return /^<(?:!doctype\s+html|html\b|head\b|body\b|article\b|main\b|section\b|div\b|p\b)/i.test(trimmed);
}

function shouldTreatAsHtml(contentType: string | null, resolvedUrl: string, body: string): boolean {
  if (isHtmlMimeType(contentType)) return true;
  if (HTML_EXTENSIONS.has(extensionFromName(baseNameFromUrl(resolvedUrl)) ?? "")) return true;
  return looksLikeHtmlDocument(body);
}

async function maybeFetchExaEnrichment(ctx: ToolContext, finalUrl: string): Promise<{
  text: string;
  links: string[];
  imageLinks: string[];
} | null> {
  const exaApiKey = await resolveExaApiKey(ctx);
  if (!exaApiKey) return null;

  try {
    return await fetchExaContents({
      apiKey: exaApiKey,
      url: finalUrl,
      abortSignal: ctx.abortSignal,
    });
  } catch (error) {
    ctx.log(`tool! webFetch exa enrichment skipped ${JSON.stringify({ reason: String(error) })}`);
    return null;
  }
}

function formatFetchedText(
  baseText: string,
  exaContent: { text: string; links: string[]; imageLinks: string[] } | null
): string {
  const sections: string[] = [];
  const trimmedBase = baseText.trim();
  if (trimmedBase) {
    sections.push(trimmedBase);
  } else if (exaContent?.text.trim()) {
    sections.push(exaContent.text.trim());
  }

  if (exaContent?.links.length) {
    sections.push(`Links:\n${exaContent.links.map((link) => `- ${link}`).join("\n")}`);
  }
  if (exaContent?.imageLinks.length) {
    sections.push(`Image Links:\n${exaContent.imageLinks.map((link) => `- ${link}`).join("\n")}`);
  }

  return sections.join("\n\n").trim();
}

export const __internal = {
  finalizeDownloadedFile,
  getMaxDownloadBytes: () => maxDownloadBytes,
  getResponseTimeoutMs: () => responseTimeoutMs,
  isDesktopBundleRuntime,
  setHtmlToMarkdownForTests(
    renderer: (html: string, finalUrl: string, ctx: ToolContext) => Promise<string>
  ) {
    htmlToMarkdownOverrideForTests = renderer;
  },
  resetHtmlToMarkdownForTests() {
    htmlToMarkdownOverrideForTests = null;
  },
  setMaxDownloadBytes: (bytes: number) => {
    maxDownloadBytes = bytes;
  },
  setResponseTimeoutMs: (ms: number) => {
    responseTimeoutMs = ms;
  },
};

export function createWebFetchTool(ctx: ToolContext) {
  return defineTool({
    description:
      "Fetch a URL and return clean markdown for HTML pages, preserve direct text responses, or save supported image and document downloads into the workspace Downloads folder.",
    inputSchema: z.object({
      url: z.string().url().describe("URL to fetch"),
      maxLength: z.number().int().min(1000).max(200000).optional().default(50000),
    }),
    execute: async ({ url, maxLength }: { url: string; maxLength: number }) => {
      ctx.log(`tool> webFetch ${JSON.stringify({ url, maxLength })}`);

      const { response, finalUrl } = await fetchWithSafeRedirects(url, ctx.abortSignal);
      if (!response.ok) {
        throw new Error(`webFetch failed: ${response.status} ${response.statusText}`);
      }

      const contentKind = classifyResponseContent(
        response.headers.get("content-type"),
        finalUrl,
        response.headers.get("content-disposition")
      );

      if (contentKind.kind === "download") {
        const downloadDir = resolveMaybeRelative("Downloads", ctx.config.workingDirectory);
        const targetPath = path.join(downloadDir, contentKind.fileName);
        const allowedTargetPath = await assertWritePathAllowed(targetPath, ctx.config, "write");
        const allowedDownloadDir = path.dirname(allowedTargetPath);
        const allowedTempPath = await assertWritePathAllowed(
          temporaryDownloadPath(allowedDownloadDir, path.basename(allowedTargetPath)),
          ctx.config,
          "write"
        );
        await fs.mkdir(allowedDownloadDir, { recursive: true });
        const { bytesWritten, finalPath } = await downloadResponseToFile({
          response,
          downloadDir: allowedDownloadDir,
          fileName: path.basename(allowedTargetPath),
          tempPath: allowedTempPath,
          maxBytes: maxDownloadBytes,
        });

        const out = `File downloaded ${finalPath}`;
        ctx.log(
          `tool< webFetch ${JSON.stringify({
            download: true,
            category: contentKind.category,
            path: finalPath,
            bytes: bytesWritten,
          })}`
        );
        return out;
      }

      const bodyText = await response.text();
      const isHtml = shouldTreatAsHtml(response.headers.get("content-type"), finalUrl, bodyText);
      const baseText = isHtml
        ? await (htmlToMarkdownOverrideForTests ?? htmlToMarkdown)(bodyText, finalUrl, ctx)
        : bodyText;
      const exaContent = isHtml ? await maybeFetchExaEnrichment(ctx, finalUrl) : null;
      const out = truncateText(formatFetchedText(baseText, exaContent), maxLength);

      ctx.log(
        `tool< webFetch ${JSON.stringify({
          chars: out.length,
          finalUrl,
          kind: isHtml ? "html" : "text",
          exa: Boolean(exaContent),
          links: exaContent?.links.length ?? 0,
          imageLinks: exaContent?.imageLinks.length ?? 0,
        })}`
      );
      return out;
    },
  });
}
