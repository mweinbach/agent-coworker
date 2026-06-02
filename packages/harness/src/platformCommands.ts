import {
  quotePosixShellValue,
  quotePowerShellSingleQuotedValue,
} from "../../../src/platform/shell";

export interface HarnessPlatformCommands {
  runPythonScript(scriptPath: string): string;
  printWorkingDirectory(): string;
  listDirectory(dirPath?: string): string;
  countLines(filePath: string): string;
}

export function createHarnessPlatformCommands(
  platform: NodeJS.Platform = process.platform,
): HarnessPlatformCommands {
  if (platform === "win32") {
    return {
      runPythonScript: (scriptPath) => `py -3 ${quotePowerShellSingleQuotedValue(scriptPath)}`,
      printWorkingDirectory: () => "(Get-Location).Path",
      listDirectory: (dirPath) =>
        dirPath
          ? `Get-ChildItem -Force ${quotePowerShellSingleQuotedValue(dirPath)}`
          : "Get-ChildItem -Force",
      countLines: (filePath) =>
        `(Get-Content ${quotePowerShellSingleQuotedValue(filePath)} | Measure-Object -Line).Lines`,
    };
  }

  return {
    runPythonScript: (scriptPath) => `python3 ${quotePosixShellValue(scriptPath)}`,
    printWorkingDirectory: () => "pwd",
    listDirectory: (dirPath) =>
      dirPath ? `ls -la ${quotePosixShellValue(dirPath)}` : "ls -la",
    countLines: (filePath) => `wc -l ${quotePosixShellValue(filePath)}`,
  };
}
