import { getAiCoworkerPaths } from "../store/connections";
import { resolveAuthHomeDir } from "../utils/authHome";
import { readToolApiKey } from "./api-keys";
import type { ToolContext } from "./context";

export const PARALLEL_MISSING_KEY_MESSAGE = "set PARALLEL_API_KEY or save Parallel API key in provider settings";

export async function resolveParallelApiKey(ctx: ToolContext): Promise<string | undefined> {
  try {
    const paths = getAiCoworkerPaths({ homedir: resolveAuthHomeDir(ctx.config) });
    const saved = await readToolApiKey({ name: "parallel", paths });
    if (saved?.trim()) return saved.trim();
  } catch {
    // Fall back to ambient env only when the saved-key path is unavailable.
  }

  const fromEnv = process.env.PARALLEL_API_KEY?.trim();
  return fromEnv || undefined;
}

export async function postParallelJson(opts: {
  apiKey: string;
  path: string;
  body: unknown;
  fetchImpl?: typeof fetch;
  abortSignal?: AbortSignal;
}): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return fetchImpl(`https://api.parallel.ai${opts.path}`, {
    method: "POST",
    headers: {
      "x-api-key": opts.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(opts.body),
    signal: opts.abortSignal,
  });
}
