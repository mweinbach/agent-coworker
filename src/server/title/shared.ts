import type { AgentConfig } from "../../types";

export const TITLE_MODELS_BY_PROVIDER: Partial<Record<AgentConfig["provider"], readonly string[]>> =
  {
    antigravity: ["gemini-3.1-flash-lite"],
    anthropic: ["claude-haiku-4-5"],
    baseten: ["moonshotai/Kimi-K2.5"],
    "codex-cli": ["gpt-5.4-mini", "gpt-5.3-codex-spark"],
    google: ["gemini-3-flash-preview"],
    nvidia: ["nvidia/nemotron-3-super-120b-a12b"],
    openai: ["gpt-5-mini"],
    together: ["moonshotai/Kimi-K2.5"],
    fireworks: ["accounts/fireworks/models/glm-5"],
    firepass: ["accounts/fireworks/routers/kimi-k2p6-turbo"],
    "opencode-go": ["glm-5"],
    "opencode-zen": ["glm-5"],
  };

export const TITLE_MAX_TOKENS = 150;
export const TITLE_MAX_CHARS = 50;

export const DEFAULT_SESSION_TITLE = "New session";

export type SessionTitleSource = "default" | "model" | "heuristic" | "manual";

export type SessionTitleResult = {
  title: string;
  source: SessionTitleSource;
  model: string | null;
};

export const TITLE_SELECTION_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "by",
  "for",
  "from",
  "how",
  "in",
  "it",
  "make",
  "of",
  "on",
  "or",
  "the",
  "to",
  "use",
  "using",
  "with",
]);

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function stripWrappingQuotes(value: string): string {
  const wrappedPairs: Array<[start: string, end: string]> = [
    ['"', '"'],
    ["'", "'"],
    ["`", "`"],
    ["“", "”"],
    ["‘", "’"],
    ['\\"', '\\"'],
    ["\\'", "\\'"],
    ["\\`", "\\`"],
  ];

  let current = value.trim();
  let changed = true;

  while (changed) {
    changed = false;
    for (const [start, end] of wrappedPairs) {
      if (current.length <= start.length + end.length) continue;
      if (!current.startsWith(start) || !current.endsWith(end)) continue;
      current = current.slice(start.length, current.length - end.length).trim();
      changed = true;
      break;
    }
  }

  return current;
}

export function limitTokenCount(value: string, maxTokens: number): string {
  const tokens = value.split(/\s+/).filter(Boolean);
  if (tokens.length <= maxTokens) return value;
  return tokens.slice(0, maxTokens).join(" ");
}

export function truncateToCharLimit(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const truncated = value.slice(0, maxChars).replace(/\s+\S*$/, "");
  return `${(truncated || value.slice(0, maxChars)).trimEnd()}…`;
}

export function sanitizeTitle(value: string): string {
  const compact = collapseWhitespace(stripWrappingQuotes(value)).replace(
    /^(?:title|chat title|session title)\s*:\s*/i,
    "",
  );
  if (!compact) return "";
  const tokenBound = limitTokenCount(compact, TITLE_MAX_TOKENS).trim();
  return truncateToCharLimit(tokenBound.replace(/[.!?]+$/g, "").trim(), TITLE_MAX_CHARS);
}

export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((term) => term.replace(/s$/u, ""))
    .filter((term) => term.length > 2 && !TITLE_SELECTION_STOP_WORDS.has(term));
}

export function buildTitlePrompt(query: string, variationHint?: string): string {
  const lines = [
    "Generate a brief title that would help the user find this conversation later.",
    "",
    "Rules:",
    `- Single line, maximum ${TITLE_MAX_CHARS} characters`,
    "- No surrounding quotes or explanations",
    "- Grammatically correct",
    "- NEVER include tool names or technical jargon about the AI",
    "- Focus on the main topic and user intent",
    "- Vary phrasing to avoid repetitive patterns",
    "- Use a short noun phrase, not a sentence copied from the request",
    "- Prefer distinctive topic words over generic starts like 'Use', 'Make', or 'How to'",
    "- Do not invent files, images, PDFs, products, or actions not present in the request",
    "- When a file is mentioned, focus on WHAT the user wants to do WITH it",
  ];
  if (variationHint) {
    lines.push(`- ${variationHint}`);
  }
  lines.push("", `User request: ${query}`);
  return lines.join("\n");
}
