export function getServerTerminationSignal(
  platform: NodeJS.Platform = process.platform,
): NodeJS.Signals | undefined {
  return platform === "win32" ? undefined : "SIGTERM";
}
