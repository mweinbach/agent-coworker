import { z } from "zod";

const questionInputSchema = z.string();
const optionsInputSchema = z.array(z.string());

function decodeJsonStringLiteral(value: string): string | null {
  try {
    const parsed = JSON.parse(`"${value}"`);
    const normalized = z.string().safeParse(parsed);
    return normalized.success ? normalized.data : null;
  } catch {
    return null;
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function looksLikeRawPayload(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  return (
    /^raw stream part:/i.test(trimmed) ||
    trimmed.startsWith("{") ||
    trimmed.includes("\"type\":") ||
    trimmed.includes("response.") ||
    trimmed.includes("obfuscation")
  );
}

function looksUnreadableOption(value: string): boolean {
  const compact = normalizeWhitespace(value);
  if (!compact) return true;
  if (looksLikeRawPayload(compact)) return true;
  if (compact.length > 220) return true;
  if (compact.length > 90 && !/\s/.test(compact)) return true;
  if (
    compact.length > 40 &&
    !/\s/.test(compact) &&
    (/[()[\]{}]/.test(compact) || /[a-z][A-Z]/.test(compact) || compact.includes(","))
  ) {
    return true;
  }
  const punctuationCount = (compact.match(/[{}[\]:"`]/g) ?? []).length;
  if (compact.length > 24 && punctuationCount >= 4) return true;
  return false;
}

function truncateOption(option: string, maxChars = 140): string {
  const compact = normalizeWhitespace(option);
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 1)}...`;
}

export function normalizeAskQuestion(question: unknown, maxChars = 480): string {
  const parsedQuestion = questionInputSchema.safeParse(question);
  let normalized = (parsedQuestion.success ? parsedQuestion.data : "").trim();

  normalized = normalized.replace(/\braw stream part:\s*\{[\s\S]*$/i, "").trim();
  const embedded = normalized.match(/"question"\s*:\s*"((?:\\.|[^"\\])+)"/i);
  if (embedded?.[1]) {
    const decoded = decodeJsonStringLiteral(embedded[1]);
    if (decoded) normalized = decoded;
  }
  normalized = normalized.replace(/^question:\s*/i, "").trim();

  const compact = normalizeWhitespace(normalized);
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 1)}...`;
}

export function normalizeAskOptions(options?: unknown): string[] {
  const parsedOptions = optionsInputSchema.safeParse(options);
  if (!parsedOptions.success) return [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const option of parsedOptions.data) {
    if (looksUnreadableOption(option)) continue;
    const normalized = truncateOption(option);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out.slice(0, 6);
}

export function shouldRenderAskOptions(options: string[]): boolean {
  return options.length >= 2;
}
