import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { type AiCoworkerPaths, ensureAiCoworkerHome } from "../connect";
import {
  type CustomModelProviderName,
  resolveCustomModelProviderName,
  supportsCustomModelIds,
} from "../shared/customModels";
import type { ProviderName } from "../types";
import { writeTextFileAtomic } from "../utils/atomicFile";
import { fileLockRootForCoworkHome, withFileLock } from "../utils/fileLock";

const CUSTOM_MODEL_STORE_FILENAME = "custom-models.json";
const MAX_CUSTOM_MODEL_ID_LENGTH = 2048;

export type CustomModelEntry = {
  id: string;
  displayName?: string;
  updatedAt: string;
};

export type CustomModelStore = {
  version: 1;
  updatedAt: string;
  providers: Partial<Record<CustomModelProviderName, CustomModelEntry[]>>;
};

const isoTimestampSchema = z.string().datetime({ offset: true });

const customModelEntrySchema = z
  .object({
    id: z.string(),
    displayName: z.string().trim().min(1).optional(),
    updatedAt: isoTimestampSchema,
  })
  .passthrough();

const customModelStoreSchema = z
  .object({
    version: z.literal(1),
    updatedAt: isoTimestampSchema,
    providers: z.record(z.string().trim().min(1), z.array(customModelEntrySchema)),
  })
  .strict();

const errorWithCodeSchema = z.object({ code: z.string() }).passthrough();

class CustomModelStoreParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomModelStoreParseError";
  }
}

function emptyCustomModelStore(): CustomModelStore {
  return { version: 1, updatedAt: new Date().toISOString(), providers: {} };
}

function customModelStorePath(paths: AiCoworkerPaths): string {
  return path.join(paths.configDir, CUSTOM_MODEL_STORE_FILENAME);
}

export function normalizeCustomModelId(raw: string, source = "model id"): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`${source} is required.`);
  }
  if (hasControlCharacter(trimmed)) {
    throw new Error(`${source} cannot contain control characters.`);
  }
  if (trimmed.length > MAX_CUSTOM_MODEL_ID_LENGTH) {
    throw new Error(`${source} must be ${MAX_CUSTOM_MODEL_ID_LENGTH} characters or fewer.`);
  }
  return trimmed;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function parseCustomModelStore(raw: unknown): CustomModelStore {
  const parsed = customModelStoreSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CustomModelStoreParseError(
      `Invalid custom model store schema: ${issue?.message ?? "validation_failed"}`,
    );
  }

  const providers: CustomModelStore["providers"] = {};
  for (const [providerRaw, entries] of Object.entries(parsed.data.providers)) {
    const provider = resolveCustomModelProviderName(providerRaw);
    if (!provider) continue;
    const byId = new Map<string, CustomModelEntry>();
    for (const entry of entries) {
      try {
        const id = normalizeCustomModelId(entry.id);
        byId.set(id, {
          id,
          ...(entry.displayName ? { displayName: entry.displayName } : {}),
          updatedAt: entry.updatedAt,
        });
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

function parseCustomModelStoreJson(raw: string, filePath: string): CustomModelStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CustomModelStoreParseError(
      `Invalid JSON in custom model store at ${filePath}: ${String(error)}`,
    );
  }
  return parseCustomModelStore(parsed);
}

export async function readCustomModelStore(paths: AiCoworkerPaths): Promise<CustomModelStore> {
  await ensureAiCoworkerHome(paths);
  const filePath = customModelStorePath(paths);
  try {
    return parseCustomModelStoreJson(await fs.readFile(filePath, "utf-8"), filePath);
  } catch (error) {
    const parsedCode = errorWithCodeSchema.safeParse(error);
    const code = parsedCode.success ? parsedCode.data.code : undefined;
    if (code === "ENOENT" || error instanceof CustomModelStoreParseError) {
      return emptyCustomModelStore();
    }
    throw new Error(`Failed to read custom model store at ${filePath}: ${String(error)}`);
  }
}

export async function writeCustomModelStore(
  paths: AiCoworkerPaths,
  store: CustomModelStore,
): Promise<void> {
  await ensureAiCoworkerHome(paths);
  const filePath = customModelStorePath(paths);
  await writeTextFileAtomic(filePath, JSON.stringify(store, null, 2), { mode: 0o600 });
  try {
    await fs.chmod(filePath, 0o600);
  } catch {
    // best effort only
  }
}

export async function upsertCustomModel(
  paths: AiCoworkerPaths,
  provider: ProviderName,
  modelIdRaw: string,
): Promise<CustomModelEntry> {
  if (!supportsCustomModelIds(provider)) {
    throw new Error(`${provider} does not support custom model IDs.`);
  }
  const id = normalizeCustomModelId(modelIdRaw);
  // Serialize the read-modify-write cycle across workspace server processes
  // sharing the global store; a plain atomic write alone still loses updates.
  return await withFileLock(
    customModelStorePath(paths),
    async () => {
      const store = await readCustomModelStore(paths);
      const now = new Date().toISOString();
      const existing = store.providers[provider] ?? [];
      const nextEntry: CustomModelEntry = { id, updatedAt: now };
      const byId = new Map(existing.map((entry) => [entry.id, entry] as const));
      byId.set(id, { ...byId.get(id), ...nextEntry });
      const nextStore: CustomModelStore = {
        version: 1,
        updatedAt: now,
        providers: {
          ...store.providers,
          [provider]: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
        },
      };
      await writeCustomModelStore(paths, nextStore);
      return nextEntry;
    },
    { lockRoot: fileLockRootForCoworkHome(paths.rootDir) },
  );
}

export async function deleteCustomModel(
  paths: AiCoworkerPaths,
  provider: ProviderName,
  modelIdRaw: string,
): Promise<void> {
  if (!supportsCustomModelIds(provider)) {
    throw new Error(`${provider} does not support custom model IDs.`);
  }
  const id = normalizeCustomModelId(modelIdRaw);
  await withFileLock(
    customModelStorePath(paths),
    async () => {
      const store = await readCustomModelStore(paths);
      const existing = store.providers[provider] ?? [];
      const nextEntries = existing.filter((entry) => entry.id !== id);
      if (nextEntries.length === existing.length) return;

      const now = new Date().toISOString();
      const providers = { ...store.providers };
      if (nextEntries.length > 0) {
        providers[provider] = nextEntries;
      } else {
        delete providers[provider];
      }

      await writeCustomModelStore(paths, {
        version: 1,
        updatedAt: now,
        providers,
      });
    },
    { lockRoot: fileLockRootForCoworkHome(paths.rootDir) },
  );
}
