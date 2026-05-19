import { Cursor } from "@cursor/sdk";

import { getSavedProviderApiKeyForHome } from "../config";
import type { AgentConfig } from "../types";
import { resolveAuthHomeDir } from "../utils/authHome";

export const CURSOR_AGENT_PROVIDER = "cursor-agent" as const;

export function resolveCursorApiKey(config: AgentConfig, savedKey?: string): string {
  const fromSaved =
    savedKey?.trim() ||
    getSavedProviderApiKeyForHome(resolveAuthHomeDir(config), CURSOR_AGENT_PROVIDER)?.trim();
  const fromEnv = process.env.CURSOR_API_KEY?.trim();
  const apiKey = fromSaved || fromEnv;
  if (!apiKey) {
    throw new Error(
      "Cursor API key is missing. Connect cursor-agent with an API key or set CURSOR_API_KEY.",
    );
  }
  return apiKey;
}

export async function verifyCursorApiKey(apiKey: string): Promise<{ email?: string; keyName: string }> {
  const user = await Cursor.me({ apiKey });
  return {
    keyName: user.apiKeyName,
    ...(user.userEmail ? { email: user.userEmail } : {}),
  };
}
