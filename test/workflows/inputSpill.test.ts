import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { hostPlatform } from "../../src/platform";
import { spillWorkflowPromptToFile } from "../../src/workflows/inputSpill";
import { workflowTmpDir } from "./harness";

describe("workflow input file safety", () => {
  test("reuses a genuine content-addressed input without changing its contents", async () => {
    const workingDirectory = await workflowTmpDir();
    const prompt = "full workflow instructions";

    const first = await spillWorkflowPromptToFile({ prompt, workingDirectory });
    const second = await spillWorkflowPromptToFile({ prompt, workingDirectory });

    expect(second.absolutePath).toBe(first.absolutePath);
    expect(await fs.readFile(first.absolutePath, "utf8")).toBe(prompt);
  });

  test.skipIf(hostPlatform() === "win32")(
    "rejects a planted input-file symlink without changing an outside file",
    async () => {
      const root = await workflowTmpDir();
      const workingDirectory = path.join(root, "workspace");
      const externalFile = path.join(root, "outside-workspace.txt");
      const prompt = "known contents from outside the workspace";
      await fs.mkdir(workingDirectory, { recursive: true });
      await fs.writeFile(externalFile, prompt, { mode: 0o600 });
      const seeded = await spillWorkflowPromptToFile({ prompt, workingDirectory });
      await fs.rm(seeded.absolutePath);
      await fs.symlink(externalFile, seeded.absolutePath);
      const originalMode = (await fs.stat(externalFile)).mode & 0o777;

      await expect(spillWorkflowPromptToFile({ prompt, workingDirectory })).rejects.toThrow(
        /symbolic link|ELOOP/i,
      );

      expect((await fs.stat(externalFile)).mode & 0o777).toBe(originalMode);
      expect((await fs.lstat(seeded.absolutePath)).isSymbolicLink()).toBe(true);
    },
  );
});
