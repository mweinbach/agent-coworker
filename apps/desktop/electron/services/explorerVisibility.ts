const HIDDEN_DEPENDENCY_DIR_NAMES = new Set(["node_modules"]);

export function isExplorerEntryHidden(name: string): boolean {
  return name.startsWith(".") || name.startsWith("~$") || HIDDEN_DEPENDENCY_DIR_NAMES.has(name);
}
