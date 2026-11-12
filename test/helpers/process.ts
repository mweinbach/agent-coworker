export { killTree } from "../../src/platform/processTree";

/**
 * PID liveness probe for tests: ESRCH means the process is gone; any other
 * outcome (success, EPERM, unknown errors) is conservatively "alive".
 */
export function isAlive(
  pid: number,
  opts: { kill?: (pid: number, signal: 0) => unknown } = {},
): boolean {
  const kill = opts.kill ?? ((p: number, s: 0) => process.kill(p, s));
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    return code !== "ESRCH";
  }
}
