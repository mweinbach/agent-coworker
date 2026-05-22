#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const HELPER_VERSION = __COWORK_HELPER_VERSION__;
const DEFAULT_LIBREOFFICE_VERSION = "__COWORK_LIBREOFFICE_VERSION__";
const rootDir = process.env.COWORK_MANAGED_SOFFICE_ROOT ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shimDir = process.env.COWORK_MANAGED_SOFFICE_SHIM_DIR ||
  path.join(rootDir, "bin");

function log(message) {
  if (process.env.COWORK_MANAGED_SOFFICE_VERBOSE === "1") {
    console.error("[cowork-soffice] " + message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function executableName(name) {
  return process.platform === "win32" ? name + ".exe" : name;
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function dirExists(dirPath) {
  try {
    return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.stdio || "pipe",
    encoding: options.encoding || "utf8",
    env: options.env || process.env,
    cwd: options.cwd || process.cwd(),
    timeout: options.timeout,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
    const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
    throw new Error(
      command + " " + args.join(" ") + " failed with exit " + result.status +
        (stderr || stdout ? ": " + [stderr, stdout].filter(Boolean).join("\n") : ""),
    );
  }
  return result;
}

function isHealthySoffice(candidate) {
  if (!fileExists(candidate)) return false;
  const result = spawnSync(candidate, ["--version"], {
    stdio: "ignore",
    timeout: 15000,
    env: process.env,
  });
  return !result.error && result.status === 0;
}

function platformArchKey() {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64";
  if (process.platform === "linux" && process.arch === "arm64") return "linux-arm64";
  return process.platform + "-" + process.arch;
}

function installRoot(version = DEFAULT_LIBREOFFICE_VERSION) {
  return path.join(rootDir, "runtime", version, platformArchKey());
}

function macSofficePath(root) {
  return path.join(root, "LibreOffice.app", "Contents", "MacOS", "soffice");
}

function linuxSofficePath(root) {
  const optDir = path.join(root, "opt");
  if (!dirExists(optDir)) return "";
  const entries = fs.readdirSync(optDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("libreoffice")) continue;
    const candidate = path.join(optDir, entry.name, "program", "soffice");
    if (fileExists(candidate)) return candidate;
  }
  return "";
}

function windowsSofficePath(root) {
  const direct = path.join(root, "program", "soffice.exe");
  if (fileExists(direct)) return direct;
  if (!dirExists(root)) return "";
  return findFirstFile(root, (candidate) =>
    path.basename(candidate).toLowerCase() === "soffice.exe" &&
      path.basename(path.dirname(candidate)).toLowerCase() === "program",
  );
}

function managedSofficePath(version = DEFAULT_LIBREOFFICE_VERSION) {
  const root = installRoot(version);
  if (process.platform === "darwin") return macSofficePath(root);
  if (process.platform === "linux") return linuxSofficePath(root);
  if (process.platform === "win32") return windowsSofficePath(root);
  return "";
}

function candidateSystemSofficePaths() {
  const candidates = [];
  if (process.platform === "darwin") {
    candidates.push("/Applications/LibreOffice.app/Contents/MacOS/soffice");
  } else if (process.platform === "win32") {
    for (const programFilesDir of [
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
      process.env.ProgramW6432,
    ]) {
      if (programFilesDir) {
        candidates.push(path.join(programFilesDir, "LibreOffice", "program", "soffice.exe"));
      }
    }
  }
  const pathEntries = (process.env.PATH || "")
    .split(path.delimiter)
    .filter((entry) => entry && path.resolve(entry) !== path.resolve(shimDir));
  for (const entry of pathEntries) {
    candidates.push(path.join(entry, executableName("soffice")));
  }
  return [...new Set(candidates)];
}

function healthySystemSoffice() {
  if (process.env.COWORK_IGNORE_SYSTEM_SOFFICE === "1") return "";
  for (const candidate of candidateSystemSofficePaths()) {
    if (isHealthySoffice(candidate)) return candidate;
  }
  return "";
}

function defaultDownloadUrl(version = DEFAULT_LIBREOFFICE_VERSION) {
  const key = platformArchKey();
  if (key === "darwin-arm64") {
    return `https://download.documentfoundation.org/libreoffice/stable/${version}/mac/aarch64/LibreOffice_${version}_MacOS_aarch64.dmg`;
  }
  if (key === "darwin-x64") {
    return `https://download.documentfoundation.org/libreoffice/stable/${version}/mac/x86_64/LibreOffice_${version}_MacOS_x86-64.dmg`;
  }
  if (key === "linux-x64") {
    return `https://download.documentfoundation.org/libreoffice/stable/${version}/deb/x86_64/LibreOffice_${version}_Linux_x86-64_deb.tar.gz`;
  }
  if (key === "linux-arm64") {
    return `https://download.documentfoundation.org/libreoffice/stable/${version}/deb/aarch64/LibreOffice_${version}_Linux_aarch64_deb.tar.gz`;
  }
  if (key === "win32-x64") {
    return `https://download.documentfoundation.org/libreoffice/stable/${version}/win/x86_64/LibreOffice_${version}_Win_x86-64.msi`;
  }
  if (key === "win32-arm64") {
    return `https://download.documentfoundation.org/libreoffice/stable/${version}/win/aarch64/LibreOffice_${version}_Win_aarch64.msi`;
  }
  return "";
}

async function downloadFile(url, destination) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  log("downloading " + url);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new Error("GET " + url + " failed with status " + response.status + ": " + text.slice(0, 300));
  }
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination));
}

function findFirstFile(root, predicate) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isFile() && predicate(candidate)) return candidate;
    if (entry.isDirectory()) {
      const found = findFirstFile(candidate, predicate);
      if (found) return found;
    }
  }
  return "";
}

function listFiles(root, predicate) {
  const out = [];
  const visit = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(dir, entry.name);
      if (entry.isFile() && predicate(candidate)) out.push(candidate);
      if (entry.isDirectory()) visit(candidate);
    }
  };
  visit(root);
  return out;
}

async function installMacRuntime(archivePath, stagedRoot) {
  const mountPoint = path.join(stagedRoot, "mount");
  const appTarget = path.join(stagedRoot, "LibreOffice.app");
  await fsp.mkdir(mountPoint, { recursive: true });
  let attached = false;
  try {
    run("hdiutil", ["attach", archivePath, "-nobrowse", "-readonly", "-mountpoint", mountPoint], {
      timeout: 120000,
    });
    attached = true;
    const appSource = path.join(mountPoint, "LibreOffice.app");
    if (!dirExists(appSource)) {
      throw new Error("Downloaded LibreOffice DMG did not contain LibreOffice.app.");
    }
    run("ditto", [appSource, appTarget], { timeout: 240000 });
  } finally {
    if (attached) {
      spawnSync("hdiutil", ["detach", mountPoint, "-quiet"], { stdio: "ignore", timeout: 60000 });
    }
  }
  const soffice = macSofficePath(stagedRoot);
  if (!isHealthySoffice(soffice)) {
    throw new Error("Managed LibreOffice app was installed but soffice did not pass --version.");
  }
}

function extractDeb(debPath, stagedRoot, tempDir) {
  const dpkg = spawnSync("dpkg-deb", ["-x", debPath, stagedRoot], {
    stdio: "pipe",
    encoding: "utf8",
    timeout: 120000,
  });
  if (!dpkg.error && dpkg.status === 0) return;

  const packageTemp = fs.mkdtempSync(path.join(tempDir, "deb-"));
  run("ar", ["x", debPath], { cwd: packageTemp, timeout: 120000 });
  const dataArchive = findFirstFile(packageTemp, (candidate) =>
    /^data\.tar\./.test(path.basename(candidate)),
  );
  if (!dataArchive) {
    throw new Error("Could not find data.tar archive inside " + debPath);
  }
  run("tar", ["-xf", dataArchive, "-C", stagedRoot], { timeout: 120000 });
}

async function installLinuxRuntime(archivePath, stagedRoot, tempDir) {
  const unpackDir = path.join(tempDir, "unpack");
  await fsp.mkdir(unpackDir, { recursive: true });
  run("tar", ["-xzf", archivePath, "-C", unpackDir], { timeout: 240000 });
  const debs = listFiles(unpackDir, (candidate) => candidate.endsWith(".deb"));
  if (debs.length === 0) {
    throw new Error("Downloaded LibreOffice archive did not contain .deb packages.");
  }
  for (const deb of debs) {
    extractDeb(deb, stagedRoot, tempDir);
  }
  const soffice = linuxSofficePath(stagedRoot);
  if (!isHealthySoffice(soffice)) {
    throw new Error("Managed LibreOffice archive was extracted but soffice did not pass --version.");
  }
}

async function installWindowsRuntime(archivePath, stagedRoot) {
  run("msiexec.exe", ["/a", archivePath, "/qn", "TARGETDIR=" + stagedRoot], {
    timeout: 600000,
  });
  const soffice = windowsSofficePath(stagedRoot);
  if (!isHealthySoffice(soffice)) {
    throw new Error("Managed LibreOffice MSI was extracted but soffice.exe did not pass --version.");
  }
}

async function installManagedRuntime(version = DEFAULT_LIBREOFFICE_VERSION) {
  const url = process.env.COWORK_LIBREOFFICE_DOWNLOAD_URL || defaultDownloadUrl(version);
  if (!url) {
    throw new Error(
      "No managed LibreOffice download is configured for " + platformArchKey() +
        ". Set COWORK_LIBREOFFICE_DOWNLOAD_URL or install LibreOffice manually.",
    );
  }

  const root = installRoot(version);
  const stagedRoot = root + ".staged-" + process.pid + "-" + Date.now();
  await fsp.mkdir(rootDir, { recursive: true });
  const tempDir = await fsp.mkdtemp(path.join(rootDir, "tmp-"));
  const archivePath = path.join(tempDir, path.basename(new URL(url).pathname) || "libreoffice-download");
  await fsp.rm(stagedRoot, { recursive: true, force: true });
  await fsp.mkdir(stagedRoot, { recursive: true });
  try {
    await downloadFile(url, archivePath);
    if (process.platform === "darwin") {
      await installMacRuntime(archivePath, stagedRoot);
    } else if (process.platform === "linux") {
      await installLinuxRuntime(archivePath, stagedRoot, tempDir);
    } else if (process.platform === "win32") {
      await installWindowsRuntime(archivePath, stagedRoot);
    } else {
      throw new Error("Managed LibreOffice download is not supported on " + platformArchKey() + ".");
    }
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.mkdir(path.dirname(root), { recursive: true });
    await fsp.rename(stagedRoot, root);
    const marker = {
      helperVersion: HELPER_VERSION,
      version,
      platform: process.platform,
      arch: process.arch,
      installedAt: new Date().toISOString(),
      url,
    };
    await fsp.writeFile(path.join(root, "cowork-libreoffice-runtime.json"), JSON.stringify(marker, null, 2) + "\n");
  } finally {
    await fsp.rm(stagedRoot, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function withInstallLock(fn) {
  const lockDir = path.join(rootDir, "install.lock");
  const started = Date.now();
  for (;;) {
    try {
      await fsp.mkdir(lockDir, { recursive: false });
      break;
    } catch (error) {
      if (Date.now() - started > 20 * 60 * 1000) {
        throw new Error("Timed out waiting for managed LibreOffice install lock.");
      }
      const existing = managedSofficePath(process.env.COWORK_LIBREOFFICE_VERSION || DEFAULT_LIBREOFFICE_VERSION);
      if (isHealthySoffice(existing)) return existing;
      await sleep(1000);
    }
  }
  try {
    return await fn();
  } finally {
    await fsp.rm(lockDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function resolveRealSoffice() {
  const version = process.env.COWORK_LIBREOFFICE_VERSION || DEFAULT_LIBREOFFICE_VERSION;
  const managed = managedSofficePath(version);
  if (isHealthySoffice(managed)) return managed;

  const system = healthySystemSoffice();
  if (system) return system;

  if (process.env.COWORK_DISABLE_MANAGED_SOFFICE_DOWNLOAD === "1") {
    throw new Error("No working soffice was found and managed LibreOffice download is disabled.");
  }

  return await withInstallLock(async () => {
    const afterWait = managedSofficePath(version);
    if (isHealthySoffice(afterWait)) return afterWait;
    await installManagedRuntime(version);
    const installed = managedSofficePath(version);
    if (!isHealthySoffice(installed)) {
      throw new Error("Managed LibreOffice installation completed but soffice is still unavailable.");
    }
    return installed;
  });
}

async function main() {
  const realSoffice = await resolveRealSoffice();
  if (process.env.COWORK_MANAGED_SOFFICE_PRINT_REAL === "1") {
    console.log(realSoffice);
    return;
  }
  log("using " + realSoffice);
  const result = spawnSync(realSoffice, process.argv.slice(2), {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  process.exit(result.status ?? 1);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[cowork-soffice] " + message);
  process.exit(127);
});
