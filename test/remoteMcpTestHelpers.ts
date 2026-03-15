function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

export function isTransientRemoteMcpError(error: unknown): boolean {
  const message = describeError(error);
  return (
    /Streamable HTTP error/i.test(message) ||
    /Error POSTing to endpoint/i.test(message) ||
    /Internal Server Error/i.test(message) ||
    /temporary outage/i.test(message) ||
    /Unexpected non-JSON response/i.test(message) ||
    /(?:ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed)/i.test(message) ||
    /\b(?:500|502|503|504)\b/.test(message)
  );
}

export async function withRemoteMcpRetries<T>(
  operation: () => Promise<T>,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const delayMs = options.delayMs ?? 500;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientRemoteMcpError(error) || attempt === attempts) {
        throw error;
      }
      await Bun.sleep(delayMs * attempt);
    }
  }

  throw lastError;
}

export function noteRemoteMcpSkip(label: string, error: unknown): void {
  console.warn(`[remote MCP] Skipping ${label} after transient upstream failure: ${describeError(error)}`);
}
