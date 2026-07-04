import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { type AiCoworkerPaths, ensureAiCoworkerHome } from "../connect";
import {
  type ModelPreferenceProviderName,
  resolveModelPreferenceProviderName,
  supportsModelPreferences,
} from "../shared/modelPreferences";
import type { ProviderName } from "../types";
import { writeTextFileAtomic } from "../utils/atomicFile";
import { normalizeCustomModelId } from "./customModels";

const MODEL_PREFERENCES_STORE_FILENAME = "model-preferences.json";

export type ModelPreferenceEntry = {
  id: string;
  enabled: boolean;
  updatedAt: string;
};

export type ModelPreferencesStore = {
  version: 1;
  updatedAt: string;
  providers: Partial<Record<ModelPreferenceProviderName, ModelPreferenceEntry[]>>;
};

const isoTimestampSchema = z.string().datetime({ offset: true });

const modelPreferenceEntrySchema = z
  .object({
    id: z.string(),
    enabled: z.boolean(),
    updatedAt: isoTimestampSchema,
  })
  .passthrough();

const modelPreferencesStoreSchema = z
  .object({
    version: z.literal(1),
    updatedAt: isoTimestampSchema,
    providers: z.record(z.string().trim().min(1), z.array(modelPreferenceEntrySchema)),
  })
  .strict();

const errorWithCodeSchema = z.object({ code: z.string() }).passthrough();

class ModelPreferencesStoreParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelPreferencesStoreParseError";
  }
}

function emptyModelPreferencesStore(): ModelPreferencesStore {
  return { version: 1, updatedAt: new Date().toISOString(), providers: {} };
}

function modelPreferencesStorePath(paths: AiCoworkerPaths): string {
  return path.join(paths.configDir, MODEL_PREFERENCES_STORE_FILENAME);
}

function parseModelPreferencesStore(raw: unknown): ModelPreferencesStore {
  const parsed = modelPreferencesStoreSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ModelPreferencesStoreParseError(
      `Invalid model preferences store schema: ${issue?.message ?? "validation_failed"}`,
    );
  }

  const providers: ModelPreferencesStore["providers"] = {};
  for (const [providerRaw, entries] of Object.entries(parsed.data.providers)) {
    const provider = resolveModelPreferenceProviderName(providerRaw);
    if (!provider) continue;
    const byId = new Map<string, ModelPreferenceEntry>();
    for (const entry of entries) {
      try {
        const id = normalizeCustomModelId(entry.id);
        byId.set(id, { id, enabled: entry.enabled, updatedAt: entry.updatedAt });
      } catch {}
    }
    if (byId.size > 0) {
      providers[provider] = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
    }
  }

  return {
    version: 1,
    updatedAt: parsed.data.updatedAt,
    providers,
  };
}

function parseModelPreferencesStoreJson(raw: string, filePath: string): ModelPreferencesStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ModelPreferencesStoreParseError(
      `Invalid JSON in model preferences store at ${filePath}: ${String(error)}`,
    );
  }
  return parseModelPreferencesStore(parsed);
}

export async function readModelPreferencesStore(
  paths: AiCoworkerPaths,
): Promise<ModelPreferencesStore> {
  await ensureAiCoworkerHome(paths);
  const filePath = modelPreferencesStorePath(paths);
  try {
    return parseModelPreferencesStoreJson(await fs.readFile(filePath, "utf-8"), filePath);
  } catch (error) {
    const parsedCode = errorWithCodeSchema.safeParse(error);
    const code = parsedCode.success ? parsedCode.data.code : undefined;
    if (code === "ENOENT" || error instanceof ModelPreferencesStoreParseError) {
      return emptyModelPreferencesStore();
    }
    throw new Error(`Failed to read model preferences store at ${filePath}: ${String(error)}`);
  }
}

export async function writeModelPreferencesStore(
  paths: AiCoworkerPaths,
  store: ModelPreferencesStore,
): Promise<void> {
  await ensureAiCoworkerHome(paths);
  const filePath = modelPreferencesStorePath(paths);
  await writeTextFileAtomic(filePath, JSON.stringify(store, null, 2), { mode: 0o600 });
  try {
    await fs.chmod(filePath, 0o600);
  } catch {
    // best effort only
  }
}

export async function setModelPreferences(
  paths: AiCoworkerPaths,
  provider: ProviderName,
  models: ReadonlyArray<{ id: string; enabled: boolean }>,
): Promise<void> {
  if (!supportsModelPreferences(provider)) {
    throw new Error(`${provider} does not support model preferences.`);
  }
  if (models.length === 0) return;

  const store = await readModelPreferencesStore(paths);
  const now = new Date().toISOString();
  const existing = store.providers[provider] ?? [];
  const byId = new Map(existing.map((entry) => [entry.id, entry] as const));
  for (const model of models) {
    const id = normalizeCustomModelId(model.id);
    byId.set(id, { id, enabled: model.enabled, updatedAt: now });
  }

  await writeModelPreferencesStore(paths, {
    version: 1,
    updatedAt: now,
    providers: {
      ...store.providers,
      [provider]: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
    },
  });
}

export async function resetModelPreferences(
  paths: AiCoworkerPaths,
  provider: ProviderName,
): Promise<void> {
  if (!supportsModelPreferences(provider)) {
    throw new Error(`${provider} does not support model preferences.`);
  }
  const store = await readModelPreferencesStore(paths);
  if (!(provider in store.providers)) return;

  const providers = { ...store.providers };
  delete providers[provider];
  await writeModelPreferencesStore(paths, {
    version: 1,
    updatedAt: new Date().toISOString(),
    providers,
  });
}
