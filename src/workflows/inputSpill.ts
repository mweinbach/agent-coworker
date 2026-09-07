import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";

import { MODEL_SCRATCHPAD_DIRNAME } from "../shared/toolOutputOverflow";

export const WORKFLOW_INLINE_PROMPT_CHARS = 20_000;
export const WORKFLOW_MAX_PROMPT_CHARS = 2_000_000;

const PRIVATE_DIRECTORY_MODE = 0o700;
const READ_ONLY_FILE_MODE = 0o400;
const DEFAULT_INPUT_FORMAT = "md";

export type WorkflowInputSpill = {
  prompt: string;
  absolutePath: string;
  targetPath: string;
  chars: number;
  format: string;
};

function normalizeWorkflowInputFormat(format: string | undefined): string {
  const normalized = format?.trim().replace(/^\.+/, "").toLowerCase() || DEFAULT_INPUT_FORMAT;
  if (!/^[a-z0-9][a-z0-9_-]{0,15}$/.test(normalized)) {
    throw new Error(
      `invalid workflow input format "${format}": use 1-16 letters, digits, underscores, or hyphens`,
    );
  }
  return normalized;
}

export async function spillWorkflowPromptToFile(opts: {
  prompt: string;
  workingDirectory: string;
  format?: string;
  assertCanMutate?: (toolName: string) => void | Promise<void>;
}): Promise<WorkflowInputSpill> {
  const format = normalizeWorkflowInputFormat(opts.format);
  const digest = createHash("sha256").update(format).update("\0").update(opts.prompt).digest("hex");
  const targetPath = path.join(
    MODEL_SCRATCHPAD_DIRNAME,
    "workflows",
    "inputs",
    `${digest}.${format}`,
  );
  const absolutePath = path.resolve(opts.workingDirectory, targetPath);
  const inputDirectory = path.dirname(absolutePath);

  await opts.assertCanMutate?.("workflowInputSpill");
  await assertSafeInputDirectories(opts.workingDirectory);
  await fs.mkdir(inputDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await assertSafeInputDirectories(opts.workingDirectory);
  await opts.assertCanMutate?.("workflowInputSpill");
  const existing = await readExistingWorkflowInput(absolutePath);
  if (existing !== null && existing !== opts.prompt) {
    throw new Error(`workflow input hash collision at ${absolutePath}`);
  }
  if (existing === null) {
    const temporaryPath = `${absolutePath}.${randomUUID()}.tmp`;
    await fs.writeFile(temporaryPath, opts.prompt, {
      encoding: "utf8",
      mode: READ_ONLY_FILE_MODE,
      flag: "wx",
    });
    try {
      await fs.rename(temporaryPath, absolutePath);
    } catch (error) {
      const concurrent = await readExistingWorkflowInput(absolutePath).catch(() => null);
      if (concurrent !== opts.prompt) throw error;
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => {
        // The temporary path is unique; a stale file cannot alter the verified final input.
      });
    }
  }
  const persistedInput = await openSafeWorkflowInput(absolutePath);
  try {
    // Change permissions on the already-verified descriptor. A path-based
    // chmod follows symlinks and can mutate files outside the workspace.
    await persistedInput.chmod(READ_ONLY_FILE_MODE).catch(() => {
      // The verified descriptor remains safe to use if filesystem permission hardening is unavailable.
    });
  } finally {
    await persistedInput.close();
  }

  return {
    prompt: [
      `This workflow input contains ${opts.prompt.length.toLocaleString()} characters and is file-backed so no detail is truncated.`,
      `Input file: ${targetPath}`,
      "Use the read tool to read the file completely before doing any work.",
      "If read reports that a line continues, keep reading that same line with the exact offset, columnOffset, and limit values it provides until no continuation remains.",
      "Treat the file contents as the complete task, including every instruction, source, report, and data section.",
    ].join("\n"),
    absolutePath,
    targetPath,
    chars: opts.prompt.length,
    format,
  };
}

async function readExistingWorkflowInput(absolutePath: string): Promise<string | null> {
  let file: FileHandle;
  try {
    file = await openSafeWorkflowInput(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  try {
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

async function openSafeWorkflowInput(absolutePath: string): Promise<FileHandle> {
  const expected = await fs.lstat(absolutePath);
  if (expected.isSymbolicLink()) {
    throw new Error(`${absolutePath} must not be a symbolic link`);
  }
  if (!expected.isFile()) {
    throw new Error(`${absolutePath} must be a regular file`);
  }

  const file = await fs.open(absolutePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const actual = await file.stat();
    if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
      throw new Error(`${absolutePath} changed while it was being opened`);
    }
    if (actual.nlink !== 1) {
      throw new Error(`${absolutePath} must not have hard links`);
    }
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function assertSafeInputDirectories(workingDirectory: string): Promise<void> {
  const directories = [
    path.join(workingDirectory, MODEL_SCRATCHPAD_DIRNAME),
    path.join(workingDirectory, MODEL_SCRATCHPAD_DIRNAME, "workflows"),
    path.join(workingDirectory, MODEL_SCRATCHPAD_DIRNAME, "workflows", "inputs"),
  ];
  for (const directory of directories) {
    try {
      const stat = await fs.lstat(directory);
      if (stat.isSymbolicLink()) throw new Error(`${directory} must not be a symbolic link`);
      if (!stat.isDirectory()) throw new Error(`${directory} exists but is not a directory`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
}
