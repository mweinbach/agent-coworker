import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export const OAUTH_SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Auth complete</title></head><body><h1>Authorization complete</h1><p>You can close this tab.</p></body></html>`;

export const OAUTH_FAILURE_HTML = (message: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Auth failed</title></head><body><h1>Authorization failed</h1><p>${message}</p></body></html>`;

export const OAUTH_LOOPBACK_HOST = "127.0.0.1";

export async function listenOnLocalhost(
  preferredPort: number,
  onRequest: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ port: number; close: () => void }> {
  const isAddrInUse = (err: unknown): boolean => {
    return (err as { code?: string } | undefined)?.code === "EADDRINUSE";
  };

  const listen = async (port: number): Promise<{ port: number; close: () => void }> => {
    const server = createServer(onRequest);
    const resolvedPort = await new Promise<number>((resolve, reject) => {
      const onError = (err: Error & { code?: string }) => {
        server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("Unable to determine local callback port."));
          return;
        }
        resolve(addr.port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, OAUTH_LOOPBACK_HOST);
    });
    return { port: resolvedPort, close: () => server.close() };
  };

  let lastErr: unknown;
  const tryListen = async (port: number): Promise<{ port: number; close: () => void } | null> => {
    try {
      return await listen(port);
    } catch (err) {
      lastErr = err;
      if (isAddrInUse(err)) return null;
      throw err instanceof Error ? err : new Error(String(err));
    }
  };

  const preferred = await tryListen(preferredPort);
  if (preferred) return preferred;

  if (preferredPort !== 0) {
    const ephemeral = await tryListen(0);
    if (ephemeral) return ephemeral;
  }

  const min = 49152;
  const max = 65535;
  const attempts = 50;
  for (let i = 0; i < attempts; i++) {
    const candidate = min + Math.floor(Math.random() * (max - min + 1));
    const resolved = await tryListen(candidate);
    if (resolved) return resolved;
  }

  throw lastErr instanceof Error ? lastErr : new Error("Unable to bind localhost callback port.");
}
