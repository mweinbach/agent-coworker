/**
 * Thin re-export: the canned cross-platform commands live in
 * src/platform/shell.ts (single choke point; see
 * docs/platform-abstraction-plan.md row 8/9). runPythonScript now renders the
 * canonical interpreter from pythonInvocation — never `py -3`.
 */
export {
  commands as createHarnessPlatformCommands,
  type PlatformCommands as HarnessPlatformCommands,
} from "../../../src/platform/shell";
