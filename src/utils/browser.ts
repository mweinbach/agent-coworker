import { spawn } from "node:child_process";

export type UrlOpener = (url: string) => Promise<boolean>;

export async function openExternalUrl(url: string): Promise<boolean> {
  try {
    const command =
      process.platform === "darwin"
        ? { cmd: "open", args: [url] }
        : process.platform === "win32"
          ? { cmd: "cmd", args: ["/c", "start", "", url] }
          : { cmd: "xdg-open", args: [url] };

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(command.cmd, command.args, {
        stdio: ["ignore", "ignore", "ignore"],
        detached: process.platform !== "win32",
      });
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
      if (process.platform !== "win32") child.unref();
    });
    return exitCode === 0;
  } catch {
    return false;
  }
}
