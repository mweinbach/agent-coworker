import path from "node:path";
import type { AgentConfig } from "../types";
import { isPathInside } from "./paths";

export function isWritePathAllowed(filePath: string, config: AgentConfig): boolean {
  const resolved = path.resolve(filePath);

  // v0.1: allow writes within the current project, working directory, or output directory.
  const projectRoot = path.dirname(config.projectAgentDir);
  if (isPathInside(projectRoot, resolved)) return true;

  if (isPathInside(config.workingDirectory, resolved)) return true;
  if (isPathInside(config.outputDirectory, resolved)) return true;

  return false;
}
