import { exec } from "node:child_process";

export function copyToClipboard(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const platform = process.platform;
    let cmd: string;
    if (platform === "darwin") {
      cmd = "pbcopy";
    } else if (platform === "win32") {
      cmd = "clip";
    } else {
      cmd = "xclip -selection clipboard";
    }

    const child = exec(cmd, (err) => {
      if (err) reject(err);
      else resolve();
    });
    child.stdin?.write(text);
    child.stdin?.end();
  });
}
