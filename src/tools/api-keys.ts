import {
  getAiCoworkerPaths,
  readConnectionStore,
  writeConnectionStore,
  type AiCoworkerPaths,
  type ToolApiKeyName,
} from "../store/connections";

export async function readToolApiKey(opts: {
  name: ToolApiKeyName;
  paths?: AiCoworkerPaths;
  homedir?: string;
  readStore?: typeof readConnectionStore;
}): Promise<string | undefined> {
  const paths = opts.paths ?? getAiCoworkerPaths({ homedir: opts.homedir });
  const readStore = opts.readStore ?? readConnectionStore;
  const store = await readStore(paths);
  const value = store.toolApiKeys?.[opts.name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function writeToolApiKey(opts: {
  name: ToolApiKeyName;
  apiKey: string;
  paths?: AiCoworkerPaths;
  homedir?: string;
  readStore?: typeof readConnectionStore;
  writeStore?: typeof writeConnectionStore;
}): Promise<{ storageFile: string; maskedApiKey: string; message: string }> {
  const paths = opts.paths ?? getAiCoworkerPaths({ homedir: opts.homedir });
  const readStore = opts.readStore ?? readConnectionStore;
  const writeStore = opts.writeStore ?? writeConnectionStore;
  const apiKey = opts.apiKey.trim();
  if (!apiKey) throw new Error("API key is required.");

  const store = await readStore(paths);
  store.toolApiKeys = {
    ...(store.toolApiKeys ?? {}),
    [opts.name]: apiKey,
  };
  store.updatedAt = new Date().toISOString();
  await writeStore(paths, store);

  return {
    storageFile: paths.connectionsFile,
    maskedApiKey: maskApiKey(apiKey),
    message: `${opts.name.toUpperCase()} API key saved.`,
  };
}

export function maskApiKey(value: string): string {
  if (value.length <= 8) return "*".repeat(Math.max(4, value.length));
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
