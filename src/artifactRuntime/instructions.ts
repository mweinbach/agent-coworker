import {
  ARTIFACT_RUNTIME_DISABLE_ENV,
  ARTIFACT_RUNTIME_ENV_NODE,
  ARTIFACT_RUNTIME_ENV_NODE_MODULES,
  ARTIFACT_RUNTIME_ENV_NODE_RESOLVER,
  ARTIFACT_RUNTIME_ENV_PYTHON,
} from "./constants";
import { bundledRuntimeDirFromOptions, discoverArtifactRuntimeEnv } from "./runtimeDiscovery";

function envValue(env: Record<string, string | undefined> | undefined, key: string): string {
  if (!env) return "";
  const actualKey = Object.keys(env).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  );
  return actualKey ? (env[actualKey] ?? "") : "";
}

function isTruthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export const ARTIFACT_RUNTIME_INSTRUCTIONS_HEADING = "## Artifact Runtime Dependencies";

export function renderArtifactRuntimeInstructions(
  env: Record<string, string | undefined> | undefined,
): string | null {
  const nodeModulesPath = envValue(env, ARTIFACT_RUNTIME_ENV_NODE_MODULES);
  if (!nodeModulesPath) return null;

  const nodePath = envValue(env, ARTIFACT_RUNTIME_ENV_NODE);
  const pythonPath = envValue(env, ARTIFACT_RUNTIME_ENV_PYTHON);
  const resolverPath = envValue(env, ARTIFACT_RUNTIME_ENV_NODE_RESOLVER);
  const linkExample =
    process.platform === "win32"
      ? `cmd /c mklink /J node_modules "%${ARTIFACT_RUNTIME_ENV_NODE_MODULES}%"`
      : `ln -s "$${ARTIFACT_RUNTIME_ENV_NODE_MODULES}" node_modules`;
  const nodeExample =
    process.platform === "win32"
      ? `& "$env:${ARTIFACT_RUNTIME_ENV_NODE}" .\\builder.mjs`
      : `"${nodePath || `$${ARTIFACT_RUNTIME_ENV_NODE}`}" ./builder.mjs`;

  return [
    ARTIFACT_RUNTIME_INSTRUCTIONS_HEADING,
    "",
    resolverPath
      ? "The Cowork-managed artifact runtime is already wired into Node module resolution for this turn."
      : `The Cowork-managed artifact runtime is available through \`${ARTIFACT_RUNTIME_ENV_NODE_MODULES}\`.`,
    ...(nodePath ? [`Use bundled Node at \`${nodePath}\` for artifact builders.`] : []),
    ...(pythonPath
      ? [`Use bundled Python at \`${pythonPath}\` when a skill requires Python.`]
      : []),
    resolverPath
      ? 'For spreadsheet, document, and presentation artifact work, run builders from a writable scratch work directory; bare imports such as `import "@oai/artifact-tool"` should resolve directly.'
      : "For spreadsheet, document, and presentation artifact work, run builders from a scratch work directory and link that directory's `node_modules` to the managed artifact runtime directory before importing packages.",
    ...(resolverPath ? [] : [`Example link setup from the scratch directory: \`${linkExample}\`.`]),
    ...(nodePath ? [`Example builder run: \`${nodeExample}\`.`] : []),
    resolverPath
      ? "Do not link, install, copy, or search for `@oai/artifact-tool`; if the direct import fails, report a setup blocker with the artifact runtime env keys."
      : '`NODE_PATH` alone is not enough for ESM imports such as `import "@oai/artifact-tool"`; create the local `node_modules` link first.',
    ...(resolverPath
      ? []
      : [
          "Do not install, copy, or search for `@oai/artifact-tool` in guessed locations. If this dependency path exists, use it as the source of truth.",
        ]),
  ].join("\n");
}

/**
 * Idempotently ensure the artifact runtime env is present on the provided
 * environment. Discovery only (no download), so this is cheap to call per turn
 * for any provider. Returns the (possibly augmented) env.
 */
export async function prepareArtifactRuntimeToolEnv(opts: {
  homedir?: string;
  env?: Record<string, string | undefined>;
  bundledRuntimeDir?: string;
  log?: (line: string) => void;
}): Promise<Record<string, string | undefined>> {
  const env = { ...(opts.env ?? process.env) };
  if (isTruthy(env[ARTIFACT_RUNTIME_DISABLE_ENV])) return env;
  if (envValue(env, ARTIFACT_RUNTIME_ENV_NODE_MODULES)) return env;

  const home = opts.homedir ?? process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (!home) return env;

  const bundledRuntimeDir = bundledRuntimeDirFromOptions({
    bundledRuntimeDir: opts.bundledRuntimeDir,
    env,
  });
  const runtimeEnv = await discoverArtifactRuntimeEnv({ home, env, bundledRuntimeDir });
  if (Object.keys(runtimeEnv).length > 0) {
    Object.assign(env, runtimeEnv);
    opts.log?.("Wired Cowork artifact runtime into the tool environment.");
  }
  return env;
}
