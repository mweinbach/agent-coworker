import { getHarnessRunsSnapshot } from "@/lib/harness";

export const dynamic = "force-dynamic";

function encodeData(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const intervalMsRaw = Number(searchParams.get("intervalMs") ?? "2000");
  const limitRaw = Number(searchParams.get("limitRoots") ?? "30");

  const intervalMs = Math.max(500, Math.min(15_000, Number.isFinite(intervalMsRaw) ? intervalMsRaw : 2000));
  const limitRoots = Math.max(1, Math.min(100, Number.isFinite(limitRaw) ? limitRaw : 30));

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let lastDigest = "";

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(intervalTimer);
        clearInterval(heartbeatTimer);
        try {
          controller.close();
        } catch {
          // ignore double-close races
        }
      };

      const sendSnapshot = async () => {
        if (closed) return;
        try {
          const snapshot = await getHarnessRunsSnapshot({ limitRoots });
          const digest = JSON.stringify(
            snapshot.roots.map((root) => ({
              runRootName: root.runRootName,
              updatedAtMs: root.updatedAtMs,
              runs: root.runs.map((run) => ({ runDirName: run.runDirName, updatedAtMs: run.updatedAtMs, status: run.status })),
            }))
          );

          if (digest === lastDigest) return;
          lastDigest = digest;
          controller.enqueue(encodeData(snapshot));
        } catch (err) {
          controller.enqueue(
            encodeData({ type: "stream_error", message: String(err), at: new Date().toISOString() })
          );
        }
      };

      await sendSnapshot();

      const intervalTimer = setInterval(() => {
        void sendSnapshot();
      }, intervalMs);

      const heartbeatTimer = setInterval(() => {
        if (closed) return;
        controller.enqueue(new TextEncoder().encode(`: heartbeat ${Date.now()}\n\n`));
      }, 12_000);

      request.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
