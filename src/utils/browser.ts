import { spawn } from "node:child_process";

export type UrlOpener = (url: string) => Promise<boolean>;

type ExternalBrowserCommand = {
  cmd: string;
  args: string[];
  detached: boolean;
};

function buildOpenExternalCommand(platform: NodeJS.Platform, url: string): ExternalBrowserCommand {
  if (platform === "darwin") {
    return { cmd: "open", args: [url], detached: true };
  }
  if (platform === "win32") {
    return {
      cmd: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
      detached: false,
    };
  }
  return { cmd: "xdg-open", args: [url], detached: true };
}

export async function openExternalUrl(url: string): Promise<boolean> {
  try {
    const command = buildOpenExternalCommand(process.platform, url);

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(command.cmd, command.args, {
        stdio: ["ignore", "ignore", "ignore"],
        detached: command.detached,
      });
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
      if (command.detached) child.unref();
    });
    return exitCode === 0;
  } catch {
    return false;
  }
}

export const __internal = {
  buildOpenExternalCommand,
};
