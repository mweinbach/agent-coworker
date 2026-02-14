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

  // Hoist timer handles so both start() and cancel() can access them.
  let intervalTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let lastDigest = "";

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (intervalTimer) clearInterval(intervalTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        try {
          controller.close();
        } catch {
          // ignore double-close races
        }
      };

      // Register abort listener before any async operations to ensure it's called
      // even if the client disconnects during the initial snapshot.
      request.signal.addEventListener("abort", cleanup);

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
          if (closed) return;
          controller.enqueue(encodeData(snapshot));
        } catch (err) {
          if (closed) return;
          try {
            controller.enqueue(
              encodeData({ type: "stream_error", message: String(err), at: new Date().toISOString() })
            );
          } catch {
            // controller already closed — discard
          }
        }
      };

      await sendSnapshot();

      intervalTimer = setInterval(() => {
        void sendSnapshot();
      }, intervalMs);

      heartbeatTimer = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(new TextEncoder().encode(`: heartbeat ${Date.now()}\n\n`));
        } catch {
          // controller already closed — discard
        }
      }, 12_000);
    },
    cancel() {
      // Ensure intervals are cleaned up when the consumer cancels the stream.
      closed = true;
      if (intervalTimer) clearInterval(intervalTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
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
