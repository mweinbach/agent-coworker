const OFFICE_PREVIEW_TIMEOUT_MS = 30_000;

export async function runOfficePreviewRequest<T>(
  operation: () => Promise<T>,
  documentKind: string,
  timeoutMs = OFFICE_PREVIEW_TIMEOUT_MS,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            new Error(
              `${documentKind} preview timed out while contacting the workspace. Please try again.`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
