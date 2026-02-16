export function getTerminalSize(): { width: number; height: number } {
  return {
    width: process.stdout.columns ?? 80,
    height: process.stdout.rows ?? 24,
  };
}

export function isWideTerminal(): boolean {
  return getTerminalSize().width > 120;
}
