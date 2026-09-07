import {
  type CodeModeProcessSpawner,
  codeModeBunCommand,
} from "../../src/platform/codeModeProcess";
import { spawnStreaming } from "../../src/platform/proc";

/**
 * Only for fixed, reviewed regression/benchmark fixtures. Runs the actual
 * disposable process + restricted realm WITHOUT claiming OS sandbox or memory
 * enforcement. Production never imports this helper and has no fallback to it.
 */
export const spawnTrustedCodeModeFixture: CodeModeProcessSpawner = ({ source }) => {
  const command = codeModeBunCommand(source);
  const child = spawnStreaming(command.file, command.args, {
    env: command.env,
    cwd: "/",
    stdin: "pipe",
  });
  let disposal: Promise<void> | undefined;
  return {
    child,
    dispose() {
      disposal ??= (async () => {
        await child.killTree();
        await child.exited;
      })();
      return disposal;
    },
  };
};
