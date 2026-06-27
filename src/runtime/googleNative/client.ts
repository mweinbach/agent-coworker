import { GoogleGenAI } from "@google/genai";

export function resolveGoogleApiKey(explicitKey?: string): string {
  const direct = explicitKey?.trim();
  if (direct) return direct;

  const envKey =
    process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
    process.env.GOOGLE_API_KEY?.trim() ||
    process.env.GEMINI_API_KEY?.trim();
  if (envKey) return envKey;

  throw new Error(
    "No API key for Google provider. Set GOOGLE_GENERATIVE_AI_API_KEY, GOOGLE_API_KEY, or GEMINI_API_KEY.",
  );
}

export const googleInteractionsClientCache = new Map<string, GoogleGenAI["interactions"]>();

export function getGoogleInteractionsClient(apiKey: string): GoogleGenAI["interactions"] {
  const cached = googleInteractionsClientCache.get(apiKey);
  if (cached) return cached;

  const client = new GoogleGenAI({ apiKey });
  const interactions = client.interactions;
  googleInteractionsClientCache.set(apiKey, interactions);
  return interactions;
}
