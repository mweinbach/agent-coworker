const MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 8 * 1024;

/** Limit the decoded fetch stream, not the potentially compressed Content-Length. */
export async function readWebResponseJson(response: Response, operation: string): Promise<unknown> {
  const maxBytes = response.ok ? MAX_JSON_RESPONSE_BYTES : MAX_ERROR_RESPONSE_BYTES;
  let text = "";
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let totalBytes = 0;
    let complete = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          complete = true;
          break;
        }

        const remaining = maxBytes - totalBytes;
        if (response.ok && value.byteLength > remaining) {
          throw new Error(
            `${operation} response exceeded 2 MiB; aborting to avoid memory exhaustion.`,
          );
        }
        const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
        text += decoder.decode(chunk, { stream: true });
        totalBytes += chunk.byteLength;
        if (!response.ok && totalBytes === maxBytes) break;
      }
      text += decoder.decode();
    } finally {
      // Do not let a slow or rejected cancellation hide the response error.
      if (!complete)
        void reader.cancel().catch(() => {
          // Cancellation only releases the response stream; retain the response error.
        });
      reader.releaseLock();
    }
  }

  if (!response.ok) {
    throw new Error(
      `${operation} failed: ${response.status} ${response.statusText}: ${text.slice(0, 500)}`,
    );
  }
  return JSON.parse(text);
}
