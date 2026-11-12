#!/usr/bin/env bun

/**
 * Generates `src/generated/providerSpecs.ts` from `config/providers.json`, the
 * single source of truth for static provider metadata (shared with the Rust
 * `cowork-config` crate).
 *
 *   bun run providers:generate  # rewrite the generated module
 *   bun run providers:check     # fail when it is stale or providers drift (also models/schema)
 *
 * `bun run docs:check` (run in CI) runs the same check (see `checkProviderSpecs`).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
export const PROVIDER_SPECS_SOURCE_REL = "config/providers.json";
export const GENERATED_PROVIDER_SPECS_REL = "src/generated/providerSpecs.ts";
const WS_SCHEMA_REL = "crates/cowork-protocol/src/ws_jsonrpc_schema.json";
const MODELS_DIR_REL = "config/models";
const GENERATE_COMMAND = "bun run providers:generate";

const authFieldSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["text", "password"]),
  required: z.boolean().optional(),
  secret: z.boolean().optional(),
  placeholder: z.string().optional(),
});

const authMethodSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["api", "oauth"]),
  label: z.string().min(1),
  oauthMode: z.enum(["auto", "code"]).optional(),
  fields: z.array(authFieldSchema).optional(),
});

const DISCOVERY_MODES = ["api", "static", "local"] as const;

// Mirrors `ProviderSpec` in crates/cowork-config/src/provider_specs.rs (deny_unknown_fields).
const providerSpecSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/, "provider ids must be lowercase kebab-case"),
    displayName: z.string().trim().min(1),
    promptDisplayName: z.string().trim().min(1).optional(),
    // Valid values are the kebab-case `ProviderWireProtocol` variants in
    // crates/cowork-config/src/provider_specs.rs (serde rejects unknown ones).
    transport: z.string().regex(/^[a-z][a-z0-9-]*$/, "transport must be kebab-case"),
    userFacing: z.boolean(),
    discovery: z.enum(DISCOVERY_MODES),
    apiKeyEnvVars: z.array(z.string().min(1)),
    inferenceBaseUrl: z.string().min(1).nullable(),
    discoveryBaseUrl: z.string().min(1).nullable(),
    defaultModel: z.string(),
    titleModel: z.string().min(1).nullable(),
    authMethods: z.array(authMethodSchema),
  })
  .strict();

const providersFileSchema = z
  .object({
    providers: z.array(providerSpecSchema).min(1),
  })
  .strict();

type ProviderSpecInput = z.infer<typeof providerSpecSchema>;

export function parseProviderSpecs(raw: string, source = PROVIDER_SPECS_SOURCE_REL) {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${source} is not valid JSON: ${String(err)}`);
  }
  const parsed = providersFileSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("\n");
    throw new Error(`${source} failed validation:\n${issues}`);
  }
  const seen = new Set<string>();
  for (const provider of parsed.data.providers) {
    if (seen.has(provider.id)) {
      throw new Error(`${source} lists provider "${provider.id}" more than once.`);
    }
    seen.add(provider.id);
  }
  return parsed.data.providers;
}

function literal(value: unknown): string {
  return JSON.stringify(value);
}

function indentBlock(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line, index) => (index === 0 ? line : `${pad}${line}`))
    .join("\n");
}

function renderAuthMethods(methods: ProviderSpecInput["authMethods"]): string {
  if (methods.length === 0) return "[]";
  // Re-key in a stable order so the output does not depend on JSON key order.
  const normalized = methods.map((method) => ({
    id: method.id,
    type: method.type,
    label: method.label,
    ...(method.oauthMode ? { oauthMode: method.oauthMode } : {}),
    ...(method.fields
      ? {
          fields: method.fields.map((field) => ({
            id: field.id,
            label: field.label,
            kind: field.kind,
            ...(field.required !== undefined ? { required: field.required } : {}),
            ...(field.secret !== undefined ? { secret: field.secret } : {}),
            ...(field.placeholder !== undefined ? { placeholder: field.placeholder } : {}),
          })),
        }
      : {}),
  }));
  return JSON.stringify(normalized, null, 2);
}

/** Providers whose models are listed statically under `config/models/<provider>/`. */
function modelRegistryProviders(specs: readonly ProviderSpecInput[]): ProviderSpecInput[] {
  return specs.filter((spec) => spec.discovery !== "local");
}

export function renderProviderSpecsModule(specs: readonly ProviderSpecInput[]): string {
  const transportUnion = [...new Set(specs.map((spec) => spec.transport))]
    .map((transport) => literal(transport))
    .join(" | ");
  const names = specs.map((spec) => `  ${literal(spec.id)},`).join("\n");
  const registryNames = modelRegistryProviders(specs)
    .map((spec) => `  ${literal(spec.id)},`)
    .join("\n");
  const entries = specs
    .map((spec) =>
      [
        `  ${literal(spec.id)}: {`,
        `    displayName: ${literal(spec.displayName)},`,
        `    transport: ${literal(spec.transport)},`,
        `    userFacing: ${literal(spec.userFacing)},`,
        `    discovery: ${literal(spec.discovery)},`,
        `    defaultModel: ${literal(spec.defaultModel)},`,
        `    titleModel: ${literal(spec.titleModel)},`,
        `    authMethods: ${indentBlock(renderAuthMethods(spec.authMethods), 4)},`,
        "  },",
      ].join("\n"),
    )
    .join("\n");

  return `// GENERATED FILE - DO NOT EDIT.
// Source: ${PROVIDER_SPECS_SOURCE_REL}. Regenerate with \`${GENERATE_COMMAND}\`;
// \`bun run docs:check\` fails when this file is stale.

/** Canonical provider ids, in canonical provider order. */
export const PROVIDER_NAMES = [
${names}
] as const;

type GeneratedProviderName = (typeof PROVIDER_NAMES)[number];

/** Providers whose models are registered statically under \`config/models/<provider>/\`. */
export const MODEL_REGISTRY_PROVIDER_NAMES = [
${registryNames}
] as const satisfies readonly GeneratedProviderName[];

type ProviderSpecAuthField = {
  readonly id: string;
  readonly label: string;
  readonly kind: "text" | "password";
  readonly required?: boolean;
  readonly secret?: boolean;
  readonly placeholder?: string;
};

type ProviderSpecAuthMethod = {
  readonly id: string;
  readonly type: "api" | "oauth";
  readonly label: string;
  readonly oauthMode?: "auto" | "code";
  readonly fields?: readonly ProviderSpecAuthField[];
};

type ProviderSpec = {
  readonly displayName: string;
  readonly transport: ${transportUnion};
  readonly userFacing: boolean;
  readonly discovery: ${DISCOVERY_MODES.map((d) => literal(d)).join(" | ")};
  /** Default model id; for registry providers it is the \`isDefault\` model in \`config/models/\`. */
  readonly defaultModel: string;
  readonly titleModel: string | null;
  /** Static auth methods offered before the server reports live ones. */
  readonly authMethods: readonly ProviderSpecAuthMethod[];
};

export const PROVIDER_SPECS: { readonly [P in GeneratedProviderName]: ProviderSpec } = {
${entries}
};
`;
}

async function readText(rel: string): Promise<string> {
  return await fs.readFile(path.join(REPO_ROOT, rel), "utf-8");
}

async function readOptionalText(rel: string): Promise<string | null> {
  try {
    return await readText(rel);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Reads the `isDefault` model id of each `config/models/<provider>/` directory. */
async function readRegistryDefaults(): Promise<Map<string, string[]>> {
  const root = path.join(REPO_ROOT, MODELS_DIR_REL);
  const defaults = new Map<string, string[]>();
  for (const dir of await fs.readdir(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const ids: string[] = [];
    for (const file of await fs.readdir(path.join(root, dir.name))) {
      if (!file.endsWith(".json")) continue;
      const model = JSON.parse(await fs.readFile(path.join(root, dir.name, file), "utf-8")) as {
        id?: unknown;
        isDefault?: unknown;
      };
      if (model.isDefault === true && typeof model.id === "string") ids.push(model.id);
    }
    defaults.set(dir.name, ids);
  }
  return defaults;
}

/**
 * Collects every JSON-schema `enum` that lists more than half of the canonical
 * provider ids, i.e. a provider-name enum (subset enums such as
 * `["openai", "codex-cli"]` are ignored).
 */
function collectProviderEnums(node: unknown, providerIds: ReadonlySet<string>, out: string[][]) {
  if (Array.isArray(node)) {
    for (const item of node) collectProviderEnums(item, providerIds, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const values = (node as { enum?: unknown }).enum;
  if (Array.isArray(values)) {
    const strings = values.map(String);
    const overlap = strings.filter((value) => providerIds.has(value)).length;
    if (overlap * 2 > providerIds.size) out.push(strings);
  }
  for (const value of Object.values(node)) collectProviderEnums(value, providerIds, out);
}

/**
 * Consistency checks between `config/providers.json`, the generated TS module,
 * the static model registry directories, and the exported JSON-RPC schema.
 * Returns human-readable failure messages (empty when everything is in sync).
 */
export async function checkProviderSpecs(): Promise<string[]> {
  const failures: string[] = [];
  const raw = await readOptionalText(PROVIDER_SPECS_SOURCE_REL);
  if (raw === null) {
    return [`Missing ${PROVIDER_SPECS_SOURCE_REL} (single source of truth for provider metadata).`];
  }

  let specs: ProviderSpecInput[];
  try {
    specs = parseProviderSpecs(raw);
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }

  const expected = renderProviderSpecsModule(specs);
  const onDisk = await readOptionalText(GENERATED_PROVIDER_SPECS_REL);
  if (onDisk !== expected) {
    failures.push(
      `${GENERATED_PROVIDER_SPECS_REL} is ${onDisk === null ? "missing" : "stale"} (source: ${PROVIDER_SPECS_SOURCE_REL}); run \`${GENERATE_COMMAND}\``,
    );
  }

  const registryDefaults = await readRegistryDefaults();
  const providerIds = new Set(specs.map((spec) => spec.id));
  for (const spec of specs) {
    const defaults = registryDefaults.get(spec.id);
    if (spec.discovery === "local") {
      if (defaults) {
        failures.push(
          `${PROVIDER_SPECS_SOURCE_REL}: provider "${spec.id}" uses local discovery but ${MODELS_DIR_REL}/${spec.id}/ exists`,
        );
      }
      continue;
    }
    if (!defaults) {
      failures.push(
        `${PROVIDER_SPECS_SOURCE_REL}: provider "${spec.id}" (discovery "${spec.discovery}") has no ${MODELS_DIR_REL}/${spec.id}/ directory`,
      );
    } else if (defaults.length !== 1 || defaults[0] !== spec.defaultModel) {
      failures.push(
        `${PROVIDER_SPECS_SOURCE_REL}: provider "${spec.id}" defaultModel "${spec.defaultModel}" must be the single \`isDefault: true\` model in ${MODELS_DIR_REL}/${spec.id}/ (found [${defaults.join(", ")}])`,
      );
    }
  }
  for (const dir of registryDefaults.keys()) {
    if (!providerIds.has(dir)) {
      failures.push(
        `${MODELS_DIR_REL}/${dir}/ has no matching provider in ${PROVIDER_SPECS_SOURCE_REL}`,
      );
    }
  }

  const schemaRaw = await readOptionalText(WS_SCHEMA_REL);
  if (schemaRaw !== null) {
    const enums: string[][] = [];
    collectProviderEnums(JSON.parse(schemaRaw), providerIds, enums);
    const canonical = specs.map((spec) => spec.id).join(",");
    const drifted = enums.filter((values) => values.join(",") !== canonical);
    if (drifted.length > 0) {
      failures.push(
        `${WS_SCHEMA_REL} has ${String(drifted.length)} provider enum(s) that differ from ${PROVIDER_SPECS_SOURCE_REL} (expected [${canonical}], e.g. got [${drifted[0]?.join(",")}]); update the provider enums in ${WS_SCHEMA_REL}`,
      );
    }
  }

  return failures;
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  if (checkOnly) {
    const failures = await checkProviderSpecs();
    if (failures.length > 0) {
      for (const failure of failures) console.error(`[provider-specs] ${failure}`);
      process.exitCode = 1;
      return;
    }
    console.log("[provider-specs] OK");
    return;
  }

  const specs = parseProviderSpecs(await readText(PROVIDER_SPECS_SOURCE_REL));
  const outPath = path.join(REPO_ROOT, GENERATED_PROVIDER_SPECS_REL);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, renderProviderSpecsModule(specs), "utf-8");
  console.log(
    `[provider-specs] wrote ${GENERATED_PROVIDER_SPECS_REL} (${String(specs.length)} providers)`,
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
