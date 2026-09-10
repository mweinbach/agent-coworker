export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}
export function withResponseHeaders(
  response: Response,
  headers: Record<string, string> | undefined,
): Response {
  const isEmpty = headers === undefined || Object.keys(headers).length === 0;
  if (isEmpty) {
    return response;
  }
  const merged = new Headers(response.headers);
  for (const [key, value] of Object.entries(headers)) {
    merged.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}
