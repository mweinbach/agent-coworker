import { getAiCoworkerPaths } from "../../connect";
import { fileLockRootForCoworkHome, withFileLock } from "../../utils/fileLock";
import { canonicalizePathForBoundaryCheckSync } from "../../utils/paths";

const operationQueues = new Map<string, Promise<void>>();

/** Acquire session before workspace when both are needed; never prune while holding either. */
export async function withBackupPathLock<T>(
  targetPath: string,
  operation: () => Promise<T>,
  homedir?: string,
): Promise<T> {
  const key = canonicalizePathForBoundaryCheckSync(targetPath);
  const previous = operationQueues.get(key) ?? Promise.resolve();
  const run = previous.then(() =>
    withFileLock(targetPath, operation, {
      lockRoot: fileLockRootForCoworkHome(getAiCoworkerPaths({ homedir }).rootDir),
    }),
  );
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  operationQueues.set(key, tail);
  try {
    return await run;
  } finally {
    if (operationQueues.get(key) === tail) operationQueues.delete(key);
  }
}
