export const OPENAI_PROXY_DISABLED_BETA_HEADER = "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS";
export const OPENAI_PROXY_DISABLED_BETA_HEADER_VALUE = "1";

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

export function resolveOpenAiProxyBaseUrl(opts: {
  env?: NodeJS.ProcessEnv;
} = {}): string | undefined {
  const env = opts.env ?? process.env;
  return firstNonEmpty(env.OPENAI_PROXY_BASE_URL);
}

export function resolveOpenAiProxyApiKey(opts: {
  savedKey?: string;
  env?: NodeJS.ProcessEnv;
} = {}): string | undefined {
  const env = opts.env ?? process.env;
  return firstNonEmpty(opts.savedKey, env.OPENAI_PROXY_API_KEY);
}

type OpenAiCompatibleModelEntry = {
  id: string;
  displayName: string;
  knowledgeCutoff: string;
  supportsImageInput: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function detectClaudeModel(modelId: string): boolean {
  return /claude|anthropic/i.test(modelId);
}

function detectImageSupport(model: Record<string, unknown>): boolean {
  const modalities = Array.isArray(model.modalities) ? model.modalities : [];
  if (modalities.some((entry) => typeof entry === "string" && entry.toLowerCase().includes("image"))) return true;

  const inputModalities = Array.isArray(model.input_modalities) ? model.input_modalities : [];
  if (inputModalities.some((entry) => typeof entry === "string" && entry.toLowerCase().includes("image"))) return true;

  const capabilities = asRecord(model.capabilities);
  if (capabilities?.vision === true || capabilities?.image === true) return true;
  return false;
}

function toModelEntry(raw: unknown): OpenAiCompatibleModelEntry | null {
  const model = asRecord(raw);
  if (!model) return null;
  const id = asNonEmptyString(model.id);
  if (!id) return null;

  return {
    id,
    displayName: id,
    knowledgeCutoff: "Unknown",
    supportsImageInput: detectImageSupport(model),
  };
}

export async function discoverOpenAiProxyModels(opts: {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): Promise<OpenAiCompatibleModelEntry[]> {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const url = `${base}/models`;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    [OPENAI_PROXY_DISABLED_BETA_HEADER]: OPENAI_PROXY_DISABLED_BETA_HEADER_VALUE,
  };
  if (opts.apiKey) {
    headers.authorization = `Bearer ${opts.apiKey}`;
  }

  const response = await fetchImpl(url, { headers });
  if (!response.ok) throw new Error(`Model discovery failed (${response.status}).`);
  const payload = await response.json() as Record<string, unknown>;
  const data = Array.isArray(payload.data) ? payload.data : [];

  const discovered = data
    .map(toModelEntry)
    .filter((entry): entry is OpenAiCompatibleModelEntry => Boolean(entry))
    .filter((entry) => detectClaudeModel(entry.id));

  discovered.sort((a, b) => a.id.localeCompare(b.id));
  return discovered;
}

export type { OpenAiCompatibleModelEntry };
