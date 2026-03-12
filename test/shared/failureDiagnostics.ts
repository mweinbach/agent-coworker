const diagnosticsEnabled =
  process.env.COWORK_TEST_DIAGNOSTICS === "1" ||
  process.env.CI === "true" ||
  process.env.GITHUB_ACTIONS === "true";

function formatDiagnosticValue(value: unknown): string {
  if (value instanceof Error) {
    return value.stack || `${value.name}: ${value.message}`;
  }
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createFailureDiagnostics(label: string) {
  const lines: string[] = [];

  return {
    enabled: diagnosticsEnabled,
    log(event: string, details?: unknown) {
      if (!diagnosticsEnabled) return;
      lines.push(details === undefined ? event : `${event} ${formatDiagnosticValue(details)}`);
    },
    flush(error: unknown) {
      if (!diagnosticsEnabled) return;
      const summary = formatDiagnosticValue(error);
      console.error(`[ci-test-diagnostic] ${label} failed: ${summary}`);
      for (const line of lines) {
        console.error(`[ci-test-diagnostic] ${label} ${line}`);
      }
    },
  };
}
