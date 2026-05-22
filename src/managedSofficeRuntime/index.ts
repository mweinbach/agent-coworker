export { checkManagedSofficeRuntime } from "./diagnostics";

export { ensureManagedSofficeRuntimeReady } from "./ensureReady";
export {
  managedSofficeEnvValue,
  prepareManagedSofficeToolEnv,
  renderManagedSofficeRuntimeInstructions,
} from "./instructions";
export { __internal } from "./internal";
export type {
  EnsureManagedSofficeRuntimeOptions,
  ManagedSofficeRuntimeDiagnostic,
  ManagedSofficeRuntimeSetupResult,
} from "./types";
