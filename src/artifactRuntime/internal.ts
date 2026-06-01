import { findRuntimeRoot } from "./archive";
import { ARTIFACT_RUNTIME_ARCHIVE_URL_ENV } from "./constants";
import { findLegacyArtifactRuntimeRoot, migrateLegacyArtifactRuntime } from "./migrate";
import {
  artifactRuntimeCacheRoot,
  discoverArtifactRuntimeEnv,
  findArtifactToolNamespace,
} from "./runtimeDiscovery";

export const __internal = {
  ARTIFACT_RUNTIME_ARCHIVE_URL_ENV,
  artifactRuntimeCacheRoot,
  discoverArtifactRuntimeEnv,
  findArtifactToolNamespace,
  findLegacyArtifactRuntimeRoot,
  findRuntimeRoot,
  migrateLegacyArtifactRuntime,
};
