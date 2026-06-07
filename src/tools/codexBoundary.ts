const CODEX_NATIVE_EXECUTION_TOOL_NAMES = new Set([
  "bash",
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "webFetch",
]);

const MODEL_HIDDEN_COWORK_TOOL_NAMES = new Set(["usage"]);
const SCOPED_CODEX_FILE_READ_TOOL_NAMES = new Set(["read", "glob", "grep"]);

export function isCodexDynamicCoworkToolName(
  name: string,
  opts: { preserveScopedFileReadTools?: boolean } = {},
): boolean {
  if (opts.preserveScopedFileReadTools && SCOPED_CODEX_FILE_READ_TOOL_NAMES.has(name)) return true;
  return !CODEX_NATIVE_EXECUTION_TOOL_NAMES.has(name) && !MODEL_HIDDEN_COWORK_TOOL_NAMES.has(name);
}

export function filterToolsForCodexDynamicBoundary<T>(
  tools: Record<string, T>,
  opts: { preserveScopedFileReadTools?: boolean } = {},
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => isCodexDynamicCoworkToolName(name, opts)),
  );
}
