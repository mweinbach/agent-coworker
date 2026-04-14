import crypto from "node:crypto";
import os from "node:os";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import {
  Bedrock,
  type CustomModelDeploymentSummary,
  type FoundationModelSummary,
  type ImportedModelSummary,
  type InferenceProfileSummary,
  type ProvisionedModelSummary,
} from "@aws-sdk/client-bedrock";

import { getAiCoworkerPaths, readConnectionStore } from "../connect";
import type { ProviderCatalogModelEntry } from "./connectionCatalog";
import type { ResolvedModelMetadata } from "../models/metadataTypes";
import { defaultModelIdForProvider, getSupportedModel, listSupportedModels } from "../models/registry";
import { parseConnectionStoreJson, type AiCoworkerPaths, type ConnectionStore, type StoredConnection } from "../store/connections";
import { writeTextFileAtomic } from "../utils/atomicFile";
import { resolveAuthHomeDir } from "../utils/authHome";
import type { AgentConfig } from "../types";

export type BedrockAuthMethodId = "aws_default" | "aws_profile" | "aws_keys" | "api_key";

export type ResolvedBedrockAuthConfig = {
  methodId: BedrockAuthMethodId;
  source: "saved" | "env";
  region?: string;
  profile?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  apiKey?: string;
};

type BedrockClientConfig = {
  region?: string;
  profile?: string;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  token?: { token: string };
};

type CachedBedrockModel = ProviderCatalogModelEntry & {
  sourceKind: "foundation" | "inference_profile" | "provisioned" | "custom_deployment" | "imported";
  sourceModelId?: string;
  sourceModelArn?: string;
};

type BedrockDiscoverySnapshot = {
  authFingerprint: string;
  updatedAt: string;
  models: CachedBedrockModel[];
};

type BedrockDiscoveryCacheFile = {
  version: 1;
  snapshots: Record<string, BedrockDiscoverySnapshot>;
};

const BEDROCK_DISCOVERY_CACHE_VERSION = 1;
const BEDROCK_DISCOVERY_CACHE_NAME = "bedrock-models.json";
const MODEL_PROMPT_TEMPLATE = "system.md";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeModelId(modelId: string, source = "model"): string {
  const trimmed = modelId.trim();
  if (!trimmed) {
    throw new Error(`${source} is required.`);
  }
  return trimmed;
}

function bedrockConfigPaths(home: string): AiCoworkerPaths {
  return getAiCoworkerPaths({ homedir: home });
}

function readConnectionStoreSync(paths: AiCoworkerPaths): ConnectionStore {
  try {
    const raw = fsSync.readFileSync(paths.connectionsFile, "utf-8");
    return parseConnectionStoreJson(raw, paths.connectionsFile);
  } catch (error) {
    const code = asNonEmptyString(asRecord(error)?.code);
    if (code === "ENOENT") {
      return { version: 1, updatedAt: new Date().toISOString(), services: {} };
    }
    throw error;
  }
}

function savedBedrockConnection(store: ConnectionStore): StoredConnection | null {
  const entry = store.services.bedrock;
  return entry ?? null;
}

function normalizeRegionForMethod(
  _methodId: BedrockAuthMethodId,
  region: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (region) return region;
  return asNonEmptyString(env.AWS_REGION) ?? asNonEmptyString(env.AWS_DEFAULT_REGION) ?? undefined;
}

function sharedAwsConfigPaths(home: string): { credentials: string; config: string } {
  const awsDir = path.join(home, ".aws");
  return {
    credentials: path.join(awsDir, "credentials"),
    config: path.join(awsDir, "config"),
  };
}

function fileHasAwsDefaultProfile(filePath: string, patterns: RegExp[]): boolean {
  try {
    const raw = fsSync.readFileSync(filePath, "utf-8");
    return patterns.some((pattern) => pattern.test(raw));
  } catch (error) {
    const code = asNonEmptyString(asRecord(error)?.code);
    if (code === "ENOENT") return false;
    return false;
  }
}

function hasAmbientDefaultAwsProfile(home: string): boolean {
  const paths = sharedAwsConfigPaths(home);
  return (
    fileHasAwsDefaultProfile(paths.credentials, [/^\s*\[default\]\s*$/m])
    || fileHasAwsDefaultProfile(paths.config, [/^\s*\[profile\s+default\]\s*$/m, /^\s*\[default\]\s*$/m])
  );
}

function valuesFromConnection(entry: StoredConnection | null): Record<string, string> {
  if (!entry) return {};
  const values = entry.values ?? {};
  return Object.fromEntries(
    Object.entries(values)
      .map(([key, value]) => [key.trim(), value.trim()])
      .filter(([key, value]) => key.length > 0 && value.length > 0),
  );
}

function resolveSavedBedrockAuthFromStore(
  store: ConnectionStore,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedBedrockAuthConfig | null {
  const entry = savedBedrockConnection(store);
  if (!entry) return null;

  const methodId = asNonEmptyString(entry.methodId) as BedrockAuthMethodId | undefined;
  const values = valuesFromConnection(entry);
  if (!methodId || !["aws_default", "aws_profile", "aws_keys", "api_key"].includes(methodId)) {
    return null;
  }

  const base: ResolvedBedrockAuthConfig = {
    methodId,
    source: "saved",
    region: normalizeRegionForMethod(methodId, values.region, env),
    ...(values.profile ? { profile: values.profile } : {}),
    ...(values.accessKeyId ? { accessKeyId: values.accessKeyId } : {}),
    ...(values.secretAccessKey ? { secretAccessKey: values.secretAccessKey } : {}),
    ...(values.sessionToken ? { sessionToken: values.sessionToken } : {}),
    ...(values.apiKey ? { apiKey: values.apiKey } : {}),
  };
  return base;
}

function resolveAmbientBedrockAuth(
  env: NodeJS.ProcessEnv = process.env,
  home: string = env.HOME?.trim() || os.homedir(),
): ResolvedBedrockAuthConfig | null {
  const region = asNonEmptyString(env.AWS_REGION) ?? asNonEmptyString(env.AWS_DEFAULT_REGION);
  const apiKey = asNonEmptyString(env.AWS_BEARER_TOKEN_BEDROCK);
  if (apiKey) {
    return {
      methodId: "api_key",
      source: "env",
      apiKey,
      region: normalizeRegionForMethod("api_key", region, env),
    };
  }

  const accessKeyId = asNonEmptyString(env.AWS_ACCESS_KEY_ID);
  const secretAccessKey = asNonEmptyString(env.AWS_SECRET_ACCESS_KEY);
  if (accessKeyId && secretAccessKey) {
    return {
      methodId: "aws_keys",
      source: "env",
      accessKeyId,
      secretAccessKey,
      ...(asNonEmptyString(env.AWS_SESSION_TOKEN) ? { sessionToken: asNonEmptyString(env.AWS_SESSION_TOKEN) } : {}),
      region: normalizeRegionForMethod("aws_keys", region, env),
    };
  }

  const profile = asNonEmptyString(env.AWS_PROFILE);
  if (profile) {
    return {
      methodId: "aws_profile",
      source: "env",
      profile,
      region: normalizeRegionForMethod("aws_profile", region, env),
    };
  }

  if (
    asNonEmptyString(env.AWS_WEB_IDENTITY_TOKEN_FILE)
    || asNonEmptyString(env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI)
    || asNonEmptyString(env.AWS_CONTAINER_CREDENTIALS_FULL_URI)
    || asNonEmptyString(env.AWS_EC2_METADATA_DISABLED) === "false"
    || (asNonEmptyString(env.AWS_EXECUTION_ENV)?.toLowerCase().includes("ec2") ?? false)
    || hasAmbientDefaultAwsProfile(home)
  ) {
    return {
      methodId: "aws_default",
      source: "env",
      region: normalizeRegionForMethod("aws_default", region, env),
    };
  }

  return null;
}

export async function resolveBedrockAuthConfig(opts: {
  paths?: AiCoworkerPaths;
  env?: NodeJS.ProcessEnv;
  config?: Pick<AgentConfig, "skillsDirs">;
} = {}): Promise<ResolvedBedrockAuthConfig | null> {
  const env = opts.env ?? process.env;
  const home = opts.paths ? path.dirname(opts.paths.rootDir) : resolveAuthHomeDir(opts.config);
  const paths = opts.paths ?? bedrockConfigPaths(home);
  const store = await readConnectionStore(paths);
  return resolveSavedBedrockAuthFromStore(store, env) ?? resolveAmbientBedrockAuth(env, home);
}

export function resolveBedrockAuthConfigSync(opts: {
  home?: string;
  env?: NodeJS.ProcessEnv;
  config?: Pick<AgentConfig, "skillsDirs">;
} = {}): ResolvedBedrockAuthConfig | null {
  const env = opts.env ?? process.env;
  const home = opts.home ?? resolveAuthHomeDir(opts.config);
  const paths = bedrockConfigPaths(home);
  const store = readConnectionStoreSync(paths);
  return resolveSavedBedrockAuthFromStore(store, env) ?? resolveAmbientBedrockAuth(env, home);
}

export function bedrockDiscoveryCachePath(paths: AiCoworkerPaths): string {
  return path.join(paths.configDir, BEDROCK_DISCOVERY_CACHE_NAME);
}

export function bedrockClientConfig(auth: ResolvedBedrockAuthConfig, env: NodeJS.ProcessEnv = process.env): BedrockClientConfig {
  const config: BedrockClientConfig = {};
  const region = normalizeRegionForMethod(auth.methodId, auth.region, env);
  if (region) {
    config.region = region;
  }
  if (auth.methodId === "aws_profile" && auth.profile) {
    config.profile = auth.profile;
  }
  if (auth.methodId === "aws_keys" && auth.accessKeyId && auth.secretAccessKey) {
    config.credentials = {
      accessKeyId: auth.accessKeyId,
      secretAccessKey: auth.secretAccessKey,
      ...(auth.sessionToken ? { sessionToken: auth.sessionToken } : {}),
    };
  }
  if (auth.methodId === "api_key" && auth.apiKey) {
    config.token = { token: auth.apiKey };
  }
  return config;
}

export function bedrockAuthFingerprint(auth: ResolvedBedrockAuthConfig): string {
  const hash = crypto.createHash("sha256");
  hash.update(auth.methodId);
  hash.update("\n");
  hash.update(auth.source);
  hash.update("\n");
  hash.update(auth.region ?? "");
  hash.update("\n");
  hash.update(auth.profile ?? "");
  hash.update("\n");
  hash.update(auth.accessKeyId ?? "");
  hash.update("\n");
  hash.update(auth.sessionToken ? "session" : "nosession");
  hash.update("\n");
  if (auth.apiKey) {
    hash.update(auth.apiKey);
    hash.update("\n");
  }
  return hash.digest("hex");
}

function serializeFallbackModel(modelId: string): CachedBedrockModel {
  const model = getSupportedModel("bedrock", modelId);
  if (!model) {
    throw new Error(`Missing Bedrock fallback model metadata for ${modelId}.`);
  }
  return {
    id: model.id,
    displayName: model.displayName,
    knowledgeCutoff: model.knowledgeCutoff,
    supportsImageInput: model.supportsImageInput,
    sourceKind: "foundation",
  };
}

function fallbackBedrockModels(): CachedBedrockModel[] {
  return listSupportedModels("bedrock").map((model) => serializeFallbackModel(model.id));
}

export function buildBedrockPlaceholderMetadata(modelId: string): ResolvedModelMetadata {
  const id = normalizeModelId(modelId);
  return {
    id,
    provider: "bedrock",
    displayName: id,
    knowledgeCutoff: "Unknown",
    supportsImageInput: false,
    promptTemplate: MODEL_PROMPT_TEMPLATE,
    providerOptionsDefaults: {},
    source: "dynamic",
  };
}

function cacheModelToResolvedMetadata(model: CachedBedrockModel): ResolvedModelMetadata {
  return {
    id: model.id,
    provider: "bedrock",
    displayName: model.displayName,
    knowledgeCutoff: model.knowledgeCutoff,
    supportsImageInput: model.supportsImageInput,
    promptTemplate: MODEL_PROMPT_TEMPLATE,
    providerOptionsDefaults: {},
    source: "dynamic",
  };
}

function readBedrockDiscoveryCacheSync(paths: AiCoworkerPaths): BedrockDiscoveryCacheFile {
  const filePath = bedrockDiscoveryCachePath(paths);
  try {
    const raw = fsSync.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<BedrockDiscoveryCacheFile>;
    if (parsed.version !== BEDROCK_DISCOVERY_CACHE_VERSION || !parsed.snapshots || typeof parsed.snapshots !== "object") {
      return { version: BEDROCK_DISCOVERY_CACHE_VERSION, snapshots: {} };
    }
    return {
      version: BEDROCK_DISCOVERY_CACHE_VERSION,
      snapshots: parsed.snapshots,
    };
  } catch (error) {
    const code = asNonEmptyString(asRecord(error)?.code);
    if (code === "ENOENT") {
      return { version: BEDROCK_DISCOVERY_CACHE_VERSION, snapshots: {} };
    }
    return { version: BEDROCK_DISCOVERY_CACHE_VERSION, snapshots: {} };
  }
}

async function readBedrockDiscoveryCache(paths: AiCoworkerPaths): Promise<BedrockDiscoveryCacheFile> {
  return readBedrockDiscoveryCacheSync(paths);
}

async function writeBedrockDiscoveryCache(
  paths: AiCoworkerPaths,
  cacheFile: BedrockDiscoveryCacheFile,
): Promise<void> {
  await fs.mkdir(paths.configDir, { recursive: true, mode: 0o700 });
  await writeTextFileAtomic(
    bedrockDiscoveryCachePath(paths),
    JSON.stringify(cacheFile, null, 2),
    { mode: 0o600 },
  );
}

function foundationModelIdFromArn(modelArn?: string): string | undefined {
  const arn = asNonEmptyString(modelArn);
  if (!arn) return undefined;
  const marker = ":foundation-model/";
  const idx = arn.indexOf(marker);
  if (idx === -1) return undefined;
  return arn.slice(idx + marker.length);
}

function modelIdFromArn(modelArn?: string): string | undefined {
  return foundationModelIdFromArn(modelArn);
}

function supportsImageInputFromModalities(modalities: readonly string[] | undefined): boolean {
  return Boolean(modalities?.some((modality) => modality.toUpperCase() === "IMAGE"));
}

function buildFoundationModelsLookup(entries: readonly CachedBedrockModel[]): Map<string, CachedBedrockModel> {
  const lookup = new Map<string, CachedBedrockModel>();
  for (const entry of entries) {
    lookup.set(entry.id, entry);
    if (entry.sourceModelArn) {
      lookup.set(entry.sourceModelArn, entry);
    }
  }
  return lookup;
}

function foundationSummaryToCachedModel(summary: FoundationModelSummary): CachedBedrockModel | null {
  const modelId = asNonEmptyString(summary.modelId);
  if (!modelId) return null;
  if (summary.responseStreamingSupported === false) return null;
  return {
    id: modelId,
    displayName: asNonEmptyString(summary.modelName) ?? modelId,
    knowledgeCutoff: "Unknown",
    supportsImageInput: supportsImageInputFromModalities(summary.inputModalities),
    sourceKind: "foundation",
    sourceModelArn: asNonEmptyString(summary.modelArn),
    sourceModelId: modelId,
  };
}

function inferenceProfileToCachedModel(
  summary: InferenceProfileSummary,
  foundationLookup: Map<string, CachedBedrockModel>,
): CachedBedrockModel | null {
  const inferenceProfileId = asNonEmptyString(summary.inferenceProfileId);
  if (!inferenceProfileId) return null;
  const referenced = summary.models
    ?.map((model) => foundationLookup.get(model.modelArn ?? "") ?? foundationLookup.get(modelIdFromArn(model.modelArn) ?? ""))
    .filter((entry): entry is CachedBedrockModel => !!entry) ?? [];
  if (referenced.length === 0) return null;
  return {
    id: inferenceProfileId,
    displayName: asNonEmptyString(summary.inferenceProfileName) ?? inferenceProfileId,
    knowledgeCutoff: "Unknown",
    supportsImageInput: referenced.some((entry) => entry.supportsImageInput),
    sourceKind: "inference_profile",
    sourceModelId: referenced[0]?.sourceModelId,
    sourceModelArn: referenced[0]?.sourceModelArn,
  };
}

function provisionedModelToCachedModel(
  summary: ProvisionedModelSummary,
  foundationLookup: Map<string, CachedBedrockModel>,
): CachedBedrockModel | null {
  const id = asNonEmptyString(summary.provisionedModelArn);
  if (!id) return null;
  const reference =
    foundationLookup.get(summary.foundationModelArn ?? "")
    ?? foundationLookup.get(modelIdFromArn(summary.foundationModelArn) ?? "")
    ?? foundationLookup.get(summary.modelArn ?? "")
    ?? foundationLookup.get(modelIdFromArn(summary.modelArn) ?? "");
  if (!reference) return null;
  return {
    id,
    displayName: asNonEmptyString(summary.provisionedModelName) ?? id,
    knowledgeCutoff: "Unknown",
    supportsImageInput: reference?.supportsImageInput ?? false,
    sourceKind: "provisioned",
    sourceModelId: reference?.sourceModelId,
    sourceModelArn: reference?.sourceModelArn,
  };
}

function customDeploymentToCachedModel(summary: CustomModelDeploymentSummary): CachedBedrockModel | null {
  const id = asNonEmptyString(summary.customModelDeploymentArn);
  if (!id) return null;
  return {
    id,
    displayName: asNonEmptyString(summary.customModelDeploymentName) ?? id,
    knowledgeCutoff: "Unknown",
    supportsImageInput: false,
    sourceKind: "custom_deployment",
    sourceModelArn: asNonEmptyString(summary.modelArn),
  };
}

function importedModelToCachedModel(summary: ImportedModelSummary): CachedBedrockModel | null {
  const id = asNonEmptyString(summary.modelArn);
  if (!id) return null;
  return {
    id,
    displayName: asNonEmptyString(summary.modelName) ?? id,
    knowledgeCutoff: "Unknown",
    supportsImageInput: false,
    sourceKind: "imported",
    sourceModelArn: id,
  };
}

async function listAllInferenceProfiles(client: Bedrock): Promise<InferenceProfileSummary[]> {
  const out: InferenceProfileSummary[] = [];
  let nextToken: string | undefined;
  do {
    const response: any = await client.listInferenceProfiles({
      maxResults: 1_000,
      ...(nextToken ? { nextToken } : {}),
    });
    out.push(...(response.inferenceProfileSummaries ?? []));
    nextToken = response.nextToken;
  } while (nextToken);
  return out;
}

async function listAllCustomModelDeployments(client: Bedrock): Promise<CustomModelDeploymentSummary[]> {
  const out: CustomModelDeploymentSummary[] = [];
  let nextToken: string | undefined;
  do {
    const response: any = await client.listCustomModelDeployments({
      maxResults: 1_000,
      statusEquals: "Active",
      ...(nextToken ? { nextToken } : {}),
    });
    out.push(...(response.modelDeploymentSummaries ?? []));
    nextToken = response.nextToken;
  } while (nextToken);
  return out;
}

async function listAllProvisionedModelThroughputs(client: Bedrock): Promise<ProvisionedModelSummary[]> {
  const out: ProvisionedModelSummary[] = [];
  let nextToken: string | undefined;
  do {
    const response: any = await client.listProvisionedModelThroughputs({
      maxResults: 1_000,
      ...(nextToken ? { nextToken } : {}),
    });
    out.push(...(response.provisionedModelSummaries ?? []));
    nextToken = response.nextToken;
  } while (nextToken);
  return out;
}

async function listAllImportedModels(client: Bedrock): Promise<ImportedModelSummary[]> {
  const out: ImportedModelSummary[] = [];
  let nextToken: string | undefined;
  do {
    const response: any = await client.listImportedModels({
      maxResults: 1_000,
      ...(nextToken ? { nextToken } : {}),
    });
    out.push(...(response.modelSummaries ?? []));
    nextToken = response.nextToken;
  } while (nextToken);
  return out;
}

function sortBedrockModels(models: CachedBedrockModel[]): CachedBedrockModel[] {
  return [...models].sort((left, right) =>
    left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id),
  );
}

function dedupeBedrockModels(models: CachedBedrockModel[]): CachedBedrockModel[] {
  const deduped = new Map<string, CachedBedrockModel>();
  for (const model of models) {
    deduped.set(model.id, model);
  }
  return sortBedrockModels([...deduped.values()]);
}

function formatBedrockDiscoveryError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function liveDiscoverBedrockModels(auth: ResolvedBedrockAuthConfig): Promise<CachedBedrockModel[]> {
  const client = new Bedrock(bedrockClientConfig(auth));
  const foundationResponse = await client.listFoundationModels({});
  const foundationModels = (foundationResponse.modelSummaries ?? [])
    .map((summary: FoundationModelSummary) => foundationSummaryToCachedModel(summary))
    .filter((entry: CachedBedrockModel | null): entry is CachedBedrockModel => !!entry);
  const foundationLookup = buildFoundationModelsLookup(foundationModels);

  const [
    inferenceProfiles,
    customDeployments,
    provisionedModels,
    importedModels,
  ] = await Promise.all([
    listAllInferenceProfiles(client),
    listAllCustomModelDeployments(client),
    listAllProvisionedModelThroughputs(client),
    listAllImportedModels(client),
  ]);

  return dedupeBedrockModels([
    ...foundationModels,
    ...inferenceProfiles
      .filter((summary) => summary.status === "ACTIVE")
      .map((summary) => inferenceProfileToCachedModel(summary, foundationLookup))
      .filter((entry): entry is CachedBedrockModel => !!entry),
    ...customDeployments
      .map((summary) => customDeploymentToCachedModel(summary))
      .filter((entry): entry is CachedBedrockModel => !!entry),
    ...provisionedModels
      .filter((summary) => summary.status === "InService")
      .map((summary) => provisionedModelToCachedModel(summary, foundationLookup))
      .filter((entry): entry is CachedBedrockModel => !!entry),
    ...importedModels
      .filter((summary) => summary.instructSupported !== false)
      .map((summary) => importedModelToCachedModel(summary))
      .filter((entry): entry is CachedBedrockModel => !!entry),
  ]);
}

export async function refreshBedrockDiscoveryCache(opts: {
  paths?: AiCoworkerPaths;
  env?: NodeJS.ProcessEnv;
  config?: Pick<AgentConfig, "skillsDirs">;
} = {}): Promise<{
  ok: boolean;
  auth: ResolvedBedrockAuthConfig | null;
  models: CachedBedrockModel[];
  defaultModel: string;
  message: string;
  usedCache: boolean;
  updatedAt?: string;
}> {
  const env = opts.env ?? process.env;
  const paths = opts.paths ?? bedrockConfigPaths(resolveAuthHomeDir(opts.config));
  const auth = await resolveBedrockAuthConfig({ paths, env, config: opts.config });
  const fallbackModels = fallbackBedrockModels();
  const defaultModel = defaultModelIdForProvider("bedrock");

  if (!auth) {
    return {
      ok: false,
      auth: null,
      models: fallbackModels,
      defaultModel,
      message: "Amazon Bedrock is not configured.",
      usedCache: false,
    };
  }

  const fingerprint = bedrockAuthFingerprint(auth);
  const cacheFile = await readBedrockDiscoveryCache(paths);
  const cached = cacheFile.snapshots[fingerprint];
  try {
    const models = await liveDiscoverBedrockModels(auth);
    const updatedAt = new Date().toISOString();
    const nextSnapshot: BedrockDiscoverySnapshot = {
      authFingerprint: fingerprint,
      updatedAt,
      models,
    };
    cacheFile.snapshots[fingerprint] = nextSnapshot;
    await writeBedrockDiscoveryCache(paths, cacheFile);
    return {
      ok: true,
      auth,
      models,
      defaultModel: models.some((model) => model.id === defaultModel) ? defaultModel : (models[0]?.id ?? defaultModel),
      message: "Amazon Bedrock credentials verified.",
      usedCache: false,
      updatedAt,
    };
  } catch (error) {
    if (cached) {
      return {
        ok: false,
        auth,
        models: cached.models,
        defaultModel: cached.models.some((model) => model.id === defaultModel) ? defaultModel : (cached.models[0]?.id ?? defaultModel),
        message: `Bedrock discovery failed: ${formatBedrockDiscoveryError(error)} Using cached Bedrock catalog from ${cached.updatedAt}.`,
        usedCache: true,
        updatedAt: cached.updatedAt,
      };
    }
    return {
      ok: false,
      auth,
      models: fallbackModels,
      defaultModel,
      message: `Bedrock discovery failed: ${formatBedrockDiscoveryError(error)}`,
      usedCache: false,
    };
  }
}

export async function readBedrockCatalogSnapshot(opts: {
  paths?: AiCoworkerPaths;
  env?: NodeJS.ProcessEnv;
  config?: Pick<AgentConfig, "skillsDirs">;
} = {}): Promise<{
  auth: ResolvedBedrockAuthConfig | null;
  models: CachedBedrockModel[];
  defaultModel: string;
  message?: string;
  state: "ready" | "unreachable";
  connected: boolean;
}> {
  const env = opts.env ?? process.env;
  const paths = opts.paths ?? bedrockConfigPaths(resolveAuthHomeDir(opts.config));
  const auth = await resolveBedrockAuthConfig({ paths, env, config: opts.config });
  const defaultModel = defaultModelIdForProvider("bedrock");
  const fallbackModels = fallbackBedrockModels();
  if (!auth) {
    return {
      auth: null,
      models: fallbackModels,
      defaultModel,
      message: "Configure Amazon Bedrock credentials to discover models.",
      state: "unreachable",
      connected: false,
    };
  }

  const cacheFile = await readBedrockDiscoveryCache(paths);
  const cached = cacheFile.snapshots[bedrockAuthFingerprint(auth)];
  if (!cached) {
    return {
      auth,
      models: fallbackModels,
      defaultModel,
      message: "Refresh provider status to load the latest Amazon Bedrock catalog.",
      state: "ready",
      connected: true,
    };
  }

  return {
    auth,
    models: cached.models,
    defaultModel: cached.models.some((model) => model.id === defaultModel) ? defaultModel : (cached.models[0]?.id ?? defaultModel),
    state: "ready",
    connected: true,
  };
}

function lookupCachedBedrockModel(
  modelId: string,
  cacheFile: BedrockDiscoveryCacheFile,
): CachedBedrockModel | null {
  for (const snapshot of Object.values(cacheFile.snapshots)) {
    const match = snapshot.models.find((entry) => entry.id === modelId);
    if (match) return match;
  }
  return null;
}

export function getKnownBedrockResolvedModelMetadataSync(opts: {
  modelId: string;
  home?: string;
  config?: Pick<AgentConfig, "skillsDirs">;
  env?: NodeJS.ProcessEnv;
}): ResolvedModelMetadata | null {
  const normalized = normalizeModelId(opts.modelId);
  const staticModel = getSupportedModel("bedrock", normalized);
  if (staticModel) {
    return {
      id: staticModel.id,
      provider: "bedrock",
      displayName: staticModel.displayName,
      knowledgeCutoff: staticModel.knowledgeCutoff,
      supportsImageInput: staticModel.supportsImageInput,
      promptTemplate: staticModel.promptTemplate,
      providerOptionsDefaults: { ...staticModel.providerOptionsDefaults },
      source: "static",
    };
  }

  const home = opts.home ?? resolveAuthHomeDir(opts.config);
  const paths = bedrockConfigPaths(home);
  const cacheFile = readBedrockDiscoveryCacheSync(paths);
  const cached = lookupCachedBedrockModel(normalized, cacheFile);
  if (cached) {
    return cacheModelToResolvedMetadata(cached);
  }

  return null;
}

export async function resolveBedrockModelMetadata(opts: {
  modelId: string;
  home?: string;
  config?: Pick<AgentConfig, "skillsDirs">;
  env?: NodeJS.ProcessEnv;
}): Promise<ResolvedModelMetadata> {
  const normalized = normalizeModelId(opts.modelId);
  const known = getKnownBedrockResolvedModelMetadataSync({
    modelId: normalized,
    home: opts.home,
    config: opts.config,
    env: opts.env,
  });
  return known ?? buildBedrockPlaceholderMetadata(normalized);
}

export async function resolveDefaultBedrockModelMetadata(opts: {
  home?: string;
  config?: Pick<AgentConfig, "skillsDirs">;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<ResolvedModelMetadata> {
  const snapshot = await readBedrockCatalogSnapshot({
    paths: opts.home ? bedrockConfigPaths(opts.home) : undefined,
    env: opts.env,
    config: opts.config,
  });
  return await resolveBedrockModelMetadata({
    modelId: snapshot.defaultModel,
    home: opts.home,
    config: opts.config,
    env: opts.env,
  });
}

export function maskBedrockFieldValues(values: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!value) continue;
    switch (key) {
      case "region":
      case "profile":
        masked[key] = value;
        break;
      case "accessKeyId":
        masked[key] = value.length <= 8 ? value : `${value.slice(0, 4)}...${value.slice(-4)}`;
        break;
      default:
        masked[key] = value.length <= 8 ? "••••••••" : `${value.slice(0, 4)}...${value.slice(-4)}`;
        break;
    }
  }
  return masked;
}
