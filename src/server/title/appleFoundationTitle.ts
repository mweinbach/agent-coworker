import { randomInt } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildTitlePrompt, sanitizeTitle, TITLE_MAX_CHARS, tokenize } from "./shared";

export const APPLE_FOUNDATION_TITLE_MODEL = "SystemLanguageModel";
const APPLE_MODEL_NOT_READY_REASON = 2;
const APPLE_TITLE_WAIT_TIMEOUT_MS = 1_000;
const APPLE_TITLE_WAIT_INTERVAL_MS = 100;
const APPLE_TITLE_MAX_RESPONSE_TOKENS = 80;
const APPLE_TITLE_OPTION_COUNT = 4;
export const APPLE_TITLE_TEMPERATURE = 0.65;
export const APPLE_TITLE_RANDOM_TOP_P = 0.9;
const APPLE_TITLE_RANDOM_SEED_MAX = 2_147_483_647;
const APPLE_TITLE_VARIATION_HINTS = [
  "Emphasize the implementation action.",
  "Emphasize the user-facing outcome.",
  "Emphasize the system or component being changed.",
  "Emphasize the problem being solved.",
  "Favor concrete topic nouns over generic wording.",
] as const;
const APPLE_TITLE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  title: "SessionTitleOptions",
  properties: {
    titles: {
      type: "array",
      description:
        "Distinct concise noun-phrase chat title options, each under 50 characters, with no prefixes, quotes, or invented task details.",
      minItems: APPLE_TITLE_OPTION_COUNT,
      maxItems: APPLE_TITLE_OPTION_COUNT,
      items: {
        type: "string",
        maxLength: TITLE_MAX_CHARS,
      },
    },
  },
  required: ["titles"],
  additionalProperties: false,
};

type AppleFoundationAvailability = {
  available: boolean;
  reason?: number;
};

type AppleFoundationSystemLanguageModel = {
  isAvailable: () => AppleFoundationAvailability;
  waitUntilAvailable?: (
    timeoutMs?: number,
    intervalMs?: number,
  ) => Promise<AppleFoundationAvailability>;
  dispose: () => void;
};

type AppleFoundationLanguageModelSession = {
  respond: (
    prompt: string,
    opts?: {
      options?: {
        sampling?: unknown;
        maximumResponseTokens?: number;
        temperature?: number;
      };
    },
  ) => Promise<string>;
  respondWithJsonSchema?: (
    prompt: string,
    jsonSchema: Record<string, unknown>,
    opts?: {
      options?: {
        sampling?: unknown;
        maximumResponseTokens?: number;
        temperature?: number;
      };
    },
  ) => Promise<AppleFoundationGeneratedContent>;
  dispose: () => void;
};

type AppleFoundationGeneratedContent = {
  value?: (propertyName: string) => unknown;
  toObject?: () => Record<string, unknown>;
  toJson?: () => string;
};

export type AppleFoundationModelsModule = {
  SystemLanguageModel: new () => AppleFoundationSystemLanguageModel;
  LanguageModelSession: new (opts?: {
    model?: AppleFoundationSystemLanguageModel;
    instructions?: string;
  }) => AppleFoundationLanguageModelSession;
  SamplingMode?: {
    greedy?: () => unknown;
    random?: (opts?: { top?: number; probabilityThreshold?: number; seed?: number }) => unknown;
  };
};

export type AppleFoundationTitleAttempt =
  | { status: "generated"; title: string }
  | { status: "unavailable" }
  | { status: "failed" };

export type AppleFoundationTitleDeps = {
  loadAppleFoundationModelsModule: (env: NodeJS.ProcessEnv) => Promise<AppleFoundationModelsModule>;
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
};

function buildAppleTitleOptionsPrompt(query: string, variationHint: string): string {
  const keywords = tokenize(query).slice(0, 8);
  return [
    `Generate ${APPLE_TITLE_OPTION_COUNT} distinct brief title options that would help the user find this conversation later.`,
    "",
    "Rules:",
    `- Each title must be a single line, maximum ${TITLE_MAX_CHARS} characters`,
    "- No surrounding quotes or explanations",
    "- Each option should use a different phrasing angle",
    "- Titles must sound natural and polished, not like keyword piles",
    "- Prefer distinctive topic words over generic starts like 'Use', 'Make', or 'How to'",
    keywords.length > 0
      ? `- Preserve at least one specific request keyword when natural: ${keywords.join(", ")}`
      : "",
    "- Do not invent files, images, PDFs, products, or actions not present in the request",
    "- When a file is mentioned, focus on WHAT the user wants to do WITH it",
    `- ${variationHint}`,
    "",
    `User request: ${query}`,
  ].join("\n");
}

export function isAppleSiliconMac(platform: NodeJS.Platform, arch: string): boolean {
  return platform === "darwin" && arch === "arm64";
}

export async function loadAppleFoundationModelsModule(
  env: NodeJS.ProcessEnv,
): Promise<AppleFoundationModelsModule> {
  const packagedSdkDir = env.COWORK_TSFMSDK_DIR?.trim();
  if (packagedSdkDir) {
    const indexUrl = pathToFileURL(path.join(packagedSdkDir, "dist", "index.js")).href;
    return (await import(indexUrl)) as AppleFoundationModelsModule;
  }

  const packageName = "tsfm-" + "sdk";
  return (await import(packageName)) as AppleFoundationModelsModule;
}

async function resolveAppleModelAvailability(
  model: AppleFoundationSystemLanguageModel,
): Promise<AppleFoundationAvailability> {
  const availability = model.isAvailable();
  if (
    !availability.available &&
    availability.reason === APPLE_MODEL_NOT_READY_REASON &&
    typeof model.waitUntilAvailable === "function"
  ) {
    return await model.waitUntilAvailable(
      APPLE_TITLE_WAIT_TIMEOUT_MS,
      APPLE_TITLE_WAIT_INTERVAL_MS,
    );
  }
  return availability;
}

export async function generateAppleFoundationTitle(
  query: string,
  deps: AppleFoundationTitleDeps,
): Promise<AppleFoundationTitleAttempt> {
  if (!isAppleSiliconMac(deps.platform, deps.arch)) {
    return { status: "unavailable" };
  }

  let appleModule: AppleFoundationModelsModule;
  try {
    appleModule = await deps.loadAppleFoundationModelsModule(deps.env);
  } catch {
    return { status: "unavailable" };
  }

  let model: AppleFoundationSystemLanguageModel | null = null;
  try {
    model = new appleModule.SystemLanguageModel();
    const availability = await resolveAppleModelAvailability(model);
    if (!availability.available) {
      model.dispose();
      return { status: "unavailable" };
    }
  } catch {
    model?.dispose();
    return { status: "unavailable" };
  }

  let session: AppleFoundationLanguageModelSession | null = null;
  try {
    session = new appleModule.LanguageModelSession({
      model,
      instructions:
        "You generate concise session titles. Return title text only, without quotes or extra explanation.",
    });
    const sampling =
      appleModule.SamplingMode?.random?.({
        probabilityThreshold: APPLE_TITLE_RANDOM_TOP_P,
        seed: randomInt(1, APPLE_TITLE_RANDOM_SEED_MAX),
      }) ?? appleModule.SamplingMode?.greedy?.();
    const variationHint =
      APPLE_TITLE_VARIATION_HINTS[randomInt(APPLE_TITLE_VARIATION_HINTS.length)];
    const titlePrompt = buildTitlePrompt(query, variationHint);
    const titleOptionsPrompt = buildAppleTitleOptionsPrompt(query, variationHint);
    const generationOptions = {
      options: {
        ...(sampling ? { sampling } : {}),
        maximumResponseTokens: APPLE_TITLE_MAX_RESPONSE_TOKENS,
        temperature: APPLE_TITLE_TEMPERATURE,
      },
    };
    const result =
      typeof session.respondWithJsonSchema === "function"
        ? extractAppleStructuredTitle(
            await session.respondWithJsonSchema(
              titleOptionsPrompt,
              APPLE_TITLE_JSON_SCHEMA,
              generationOptions,
            ),
            query,
          )
        : await session.respond(titlePrompt, generationOptions);
    const title = sanitizeTitle(result);
    return title ? { status: "generated", title } : { status: "failed" };
  } catch {
    return { status: "failed" };
  } finally {
    session?.dispose();
    model.dispose();
  }
}

function extractAppleStructuredTitle(
  content: AppleFoundationGeneratedContent,
  query: string,
): string {
  try {
    const titles = normalizeAppleStructuredTitles(content.value?.("titles"));
    if (titles.length > 0) return chooseAppleTitleCandidate(titles, query);
  } catch {
    // Fall through to broader structured accessors.
  }

  try {
    const object = content.toObject?.();
    const titles = normalizeAppleStructuredTitles(object?.titles ?? object?.title);
    if (titles.length > 0) return chooseAppleTitleCandidate(titles, query);
  } catch {
    // Fall through to raw JSON parsing.
  }

  try {
    const raw = content.toJson?.();
    if (raw) {
      const parsed = JSON.parse(raw) as { title?: unknown; titles?: unknown };
      const titles = normalizeAppleStructuredTitles(parsed.titles ?? parsed.title);
      if (titles.length > 0) return chooseAppleTitleCandidate(titles, query);
    }
  } catch {
    // Treat malformed structured content as an unusable title.
  }

  return "";
}

function normalizeAppleStructuredTitles(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function chooseAppleTitleCandidate(titles: string[], query: string): string {
  const sanitized = titles.map(sanitizeTitle).filter(Boolean);
  const unique = [...new Set(sanitized)];
  if (unique.length === 0) return "";

  const scored = unique.map((title) => ({
    title,
    score: scoreTitleAgainstQuery(title, query),
  }));
  const bestScore = Math.max(...scored.map((candidate) => candidate.score));
  const candidates =
    bestScore > 0
      ? scored.filter((candidate) => candidate.score >= Math.max(1, bestScore - 1))
      : scored;
  return candidates[randomInt(candidates.length)]?.title ?? "";
}

function scoreTitleAgainstQuery(title: string, query: string): number {
  const queryTerms = new Set(tokenize(query));
  let score = 0;
  for (const term of tokenize(title)) {
    if (queryTerms.has(term)) {
      score += 1;
    }
  }
  return score;
}
