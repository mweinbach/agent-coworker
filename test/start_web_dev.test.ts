import { describe, expect, test } from "bun:test";

import { createServerStdoutMonitor, normalizeProcessExitCode } from "../scripts/start_web_dev";

const encoder = new TextEncoder();

function createStdoutStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

describe("createServerStdoutMonitor", () => {
  test("resolves readiness and keeps draining later stdout", async () => {
    const echoed: string[] = [];
    const monitor = createServerStdoutMonitor(
      createStdoutStream([
        "{\"type\":\"server_",
        "listening\",\"url\":\"ws://127.0.0.1:7337/ws\"}\n",
        "server log after ready\n",
      ]),
      (line) => echoed.push(line),
    );

    await expect(monitor.ready).resolves.toBe("ws://127.0.0.1:7337/ws");
    await expect(monitor.drained).resolves.toBeUndefined();
    expect(echoed).toEqual(["server log after ready"]);
  });

  test("rejects readiness when stdout closes before the ready event", async () => {
    const monitor = createServerStdoutMonitor(createStdoutStream(["booting up\n"]));

    await expect(monitor.ready).rejects.toThrow("Server exited before reporting readiness");
    await expect(monitor.drained).resolves.toBeUndefined();
  });
});

describe("normalizeProcessExitCode", () => {
  test("preserves explicit codes and treats missing codes as failure", () => {
    expect(normalizeProcessExitCode(0)).toBe(0);
    expect(normalizeProcessExitCode(17)).toBe(17);
    expect(normalizeProcessExitCode(null)).toBe(1);
    expect(normalizeProcessExitCode(undefined)).toBe(1);
  });
});
