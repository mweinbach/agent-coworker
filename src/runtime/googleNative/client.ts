import { GoogleGenAI } from "@google/genai";

import {
  googleApiKeyEnvVarList,
  resolveGoogleApiKey as resolveOptionalGoogleApiKey,
} from "../../providers/googleApiKey";

export function resolveGoogleApiKey(explicitKey?: string): string {
  const apiKey = resolveOptionalGoogleApiKey({ savedKey: explicitKey });
  if (apiKey) return apiKey;

  throw new Error(`No API key for Google provider. Set ${googleApiKeyEnvVarList()}.`);
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
