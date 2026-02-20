import { generateObject } from "ai";
import { z } from "zod";

import { defaultModelForProvider, getModel } from "../config";
import type { AgentConfig } from "../types";

const TITLE_SCHEMA = z.object({
  title: z.string().min(1),
});

const TITLE_MODEL_BY_PROVIDER = {
  anthropic: "claude-4-5-haiku",
  "codex-cli": "gpt-5.1-codex-mini",
  google: "gemini-2.5-flash-lite",
  openai: "gpt-5-mini",
} as const satisfies Record<AgentConfig["provider"], string>;

const TITLE_MAX_TOKENS = 30;
const TITLE_MAX_CHARS = 50;

export const DEFAULT_SESSION_TITLE = "New session";

export type SessionTitleSource = "default" | "model" | "heuristic" | "manual";

export type SessionTitleResult = {
  title: string;
  source: SessionTitleSource;
  model: string | null;
};

type SessionTitleDeps = {
  generateObject: typeof generateObject;
  getModel: typeof getModel;
  defaultModelForProvider: typeof defaultModelForProvider;
};

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripWrappingQuotes(value: string): string {
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

function limitTokenCount(value: string, maxTokens: number): string {
  const tokens = value.split(/\s+/).filter(Boolean);
  if (tokens.length <= maxTokens) return value;
  return tokens.slice(0, maxTokens).join(" ");
}

function truncateToCharLimit(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const truncated = value.slice(0, maxChars).replace(/\s+\S*$/, "");
  return (truncated || value.slice(0, maxChars)).trimEnd() + "…";
}

function sanitizeModelTitle(value: string): string {
  const compact = collapseWhitespace(stripWrappingQuotes(value));
  if (!compact) return "";
  const tokenBound = limitTokenCount(compact, TITLE_MAX_TOKENS).trim();
  return truncateToCharLimit(tokenBound, TITLE_MAX_CHARS);
}

export function heuristicTitleFromQuery(query: string): string {
  const compact = collapseWhitespace(stripWrappingQuotes(query));
  if (!compact) return DEFAULT_SESSION_TITLE;

  const withoutTrailingPunctuation = compact.replace(/[.!?]+$/g, "").trim();
  const tokenBound = limitTokenCount(withoutTrailingPunctuation || compact, TITLE_MAX_TOKENS);
  const charBound = tokenBound.length > TITLE_MAX_CHARS ? truncateToCharLimit(tokenBound, TITLE_MAX_CHARS) : tokenBound;
  return charBound || DEFAULT_SESSION_TITLE;
}

function modelCandidatesForProvider(
  provider: AgentConfig["provider"],
  defaultModelForProviderImpl: typeof defaultModelForProvider
): string[] {
  const candidates = [
    TITLE_MODEL_BY_PROVIDER[provider],
    defaultModelForProviderImpl(provider),
  ];

  const unique: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || unique.includes(candidate)) continue;
    unique.push(candidate);
  }
  return unique;
}

function buildTitlePrompt(query: string): string {
  return [
    "Generate a brief title that would help the user find this conversation later.",
    "",
    "Rules:",
    `- Single line, maximum ${TITLE_MAX_CHARS} characters`,
    "- No surrounding quotes or explanations",
    "- Grammatically correct",
    "- NEVER include tool names or technical jargon about the AI",
    "- Focus on the main topic and user intent",
    "- Vary phrasing to avoid repetitive patterns",
    "- When a file is mentioned, focus on WHAT the user wants to do WITH it",
    "",
    `User request: ${query}`,
  ].join("\n");
}

export function createSessionTitleGenerator(overrides: Partial<SessionTitleDeps> = {}) {
  const deps: SessionTitleDeps = {
    generateObject,
    getModel,
    defaultModelForProvider,
    ...overrides,
  };

  return async function generateSessionTitle(opts: {
    config: AgentConfig;
    query: string;
  }): Promise<SessionTitleResult> {
    const query = collapseWhitespace(opts.query);
    if (!query) {
      return {
        title: DEFAULT_SESSION_TITLE,
        source: "default",
        model: null,
      };
    }

    const candidates = modelCandidatesForProvider(opts.config.provider, deps.defaultModelForProvider);
    for (const modelId of candidates) {
      try {
        const { object } = await deps.generateObject({
          model: deps.getModel(opts.config, modelId),
          schema: TITLE_SCHEMA,
          prompt: buildTitlePrompt(query),
          maxOutputTokens: TITLE_MAX_TOKENS,
        });

        const title = sanitizeModelTitle(object.title);
        if (!title) continue;

        return {
          title,
          source: "model",
          model: modelId,
        };
      } catch {
        // fall through to next candidate
      }
    }

    return {
      title: heuristicTitleFromQuery(query),
      source: "heuristic",
      model: null,
    };
  };
}

export const generateSessionTitle = createSessionTitleGenerator();
