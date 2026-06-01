export const ARTIFACT_RUNTIME_STATE_VERSION = 1;
export const ARTIFACT_RUNTIME_STATE_FILE = "artifact-runtime.json";

/**
 * Operators point this at a downloadable archive (zip) that extracts into a
 * self-contained artifact runtime tree (`node/`, optional `python/`, and a
 * `node_modules/@oai/artifact-tool` package). There is intentionally no
 * hardcoded default so we never advertise a fake endpoint.
 */
export const ARTIFACT_RUNTIME_ARCHIVE_URL_ENV = "COWORK_ARTIFACT_RUNTIME_ARCHIVE_URL";

/** Explicit/bundled runtime root override (set by packaged desktop builds). */
export const ARTIFACT_RUNTIME_BUNDLED_DIR_ENV = "COWORK_BUNDLED_ARTIFACT_RUNTIME_DIR";

export const ARTIFACT_RUNTIME_DISABLE_ENV = "COWORK_DISABLE_ARTIFACT_RUNTIME";
export const ARTIFACT_RUNTIME_FORCE_ENV = "COWORK_ARTIFACT_RUNTIME_FORCE";
export const ARTIFACT_RUNTIME_ALLOW_NETWORK_ENV = "COWORK_ARTIFACT_RUNTIME_ALLOW_NETWORK";

/** Env keys exported into the tool environment for every provider/turn. */
export const ARTIFACT_RUNTIME_ENV_DIR = "COWORK_ARTIFACT_RUNTIME_DIR";
export const ARTIFACT_RUNTIME_ENV_NODE = "COWORK_ARTIFACT_RUNTIME_NODE";
export const ARTIFACT_RUNTIME_ENV_PYTHON = "COWORK_ARTIFACT_RUNTIME_PYTHON";
export const ARTIFACT_RUNTIME_ENV_NODE_MODULES = "COWORK_ARTIFACT_RUNTIME_NODE_MODULES";
export const ARTIFACT_RUNTIME_ENV_NODE_RESOLVER = "COWORK_ARTIFACT_RUNTIME_NODE_RESOLVER";
