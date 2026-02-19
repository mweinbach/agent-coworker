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

const TITLE_MAX_TOKENS = 15;

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

function sanitizeModelTitle(value: string): string {
  const compact = collapseWhitespace(stripWrappingQuotes(value));
  if (!compact) return "";
  return limitTokenCount(compact, TITLE_MAX_TOKENS).trim();
}

export function heuristicTitleFromQuery(query: string): string {
  const compact = collapseWhitespace(stripWrappingQuotes(query));
  if (!compact) return DEFAULT_SESSION_TITLE;

  const withoutTrailingPunctuation = compact.replace(/[.!?]+$/g, "").trim();
  const tokenBound = limitTokenCount(withoutTrailingPunctuation || compact, TITLE_MAX_TOKENS);
  const charBound = tokenBound.length > 96 ? `${tokenBound.slice(0, 95).trimEnd()}…` : tokenBound;
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
    "Generate a concise session title for this user request.",
    `Rules: max ${TITLE_MAX_TOKENS} tokens, plain text, no surrounding quotes.`,
    "Focus on the user intent only.",
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
