import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

/**
 * A stand-in for the spawned workspace-server child process used by the desktop
 * `ServerManager`. It exposes just enough of the `ChildProcessByStdio` surface
 * that the manager touches — `stdout`/`stderr` streams (for
 * `waitForServerListening` line parsing), `exitCode`/`signalCode`, `kill()`, and
 * the `exit`/`error` events — so lifecycle chaos can be driven deterministically.
 */
export type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  /** Force an exit with a specific code/signal to model a crash or kill. */
  killWith: (code: number | null, signal: NodeJS.Signals | null) => void;
  /** Emit a well-formed `server_listening` startup line on stdout. */
  emitServerListening: (opts?: { url?: string; port?: number; cwd?: string }) => void;
};

export function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    child.killWith(0, null);
    return true;
  };
  child.killWith = (code, signal) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = code;
    child.signalCode = signal;
    queueMicrotask(() => {
      child.emit("exit", code, signal);
    });
  };
  child.emitServerListening = (opts) => {
    child.stdout.write(
      `${JSON.stringify({
        type: "server_listening",
        url: opts?.url ?? "ws://127.0.0.1:1234/ws",
        port: opts?.port ?? 1234,
        cwd: opts?.cwd ?? "C:\\tmp",
      })}\n`,
    );
  };
  return child;
}
