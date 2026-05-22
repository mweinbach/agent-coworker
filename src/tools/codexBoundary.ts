export const CODEX_NATIVE_EXECUTION_TOOL_NAMES = new Set([
  "bash",
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "webSearch",
  "webFetch",
  "notebookEdit",
]);

export function isCodexDynamicCoworkToolName(name: string): boolean {
  return !CODEX_NATIVE_EXECUTION_TOOL_NAMES.has(name);
}

export function filterToolsForCodexDynamicBoundary<T>(tools: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => isCodexDynamicCoworkToolName(name)),
  );
}
