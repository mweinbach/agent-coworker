export function isExplorerEntryHidden(name: string): boolean {
  return name.startsWith(".") || name.startsWith("~$");
}
