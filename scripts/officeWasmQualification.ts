/**
 * Qualification only; no production runtime installation or distribution.
 *
 * Required: OFFICE_WASM_TEMP_DIR (or RUNNER_TEMP), OFFICE_WASM_ARTIFACT_DIR.
 * Optional: OFFICE_WASM_ASSET_DIR (defaults to <temp>/office-wasm-assets),
 * OFFICE_WASM_CACHE_DIR (exact named tarballs, setup only), OFFICE_WASM_NODE
 * (Node 24 executable), OFFICE_WASM_POPPLER_BIN (directory containing all three
 * Poppler tools). Otherwise executables resolve from the caller's PATH.
 *
 * bun --no-env-file scripts/officeWasmQualification.ts setup
 * bun --no-env-file scripts/officeWasmQualification.ts qualify
 *
 * setup alone may access npm. qualify NEVER downloads or silently skips.
 * Assets/workspaces must stay under runner temp and outside this checkout.
 * Artifact directory must be new. Upload it even when qualification fails.
 */
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { which } from "../src/platform/exec";
import { hostArch, hostPlatform } from "../src/platform/host";
import { home as hostHome } from "../src/platform/paths";
import {
  acquire,
  boundedFile,
  pins,
  sha256,
  verifyAssets,
} from "./officeWasmQualification/acquire";
import { validatePng } from "./officeWasmQualification/png";
import { limits, supervise } from "./officeWasmQualification/supervise";

const expectations = {
  docx: {
    pages: 2,
    markers: [
      "DOCX-7319",
      "SECOND PAGE DOCX-8420",
      "COWORK WASM HEADER",
      "COWORK WASM FOOTER",
      "Alpha",
      "240",
    ],
  },
  pptx: {
    pages: 2,
    markers: [
      "PPTX FIRST SLIDE 7319",
      "PPTX SECOND SLIDE 8420",
      "Offline sandbox presentation proof.",
    ],
  },
  xlsx: { pages: 1, markers: ["XLSX SANDBOX PROOF", "Alpha", "Beta", "TOTAL", "360", "Amounts"] },
} as const;

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    !!relative &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function executable(name: string): string {
  const file = which(name);
  if (!file) throw new Error(`Required executable not found: ${name}`);
  return file;
}

export async function officeWasmQualification(mode: string): Promise<void> {
  if (!["setup", "qualify"].includes(mode)) throw new Error("Use setup or qualify");
  if (!["darwin", "linux"].includes(hostPlatform())) {
    throw new Error(
      "Windows not qualified: requires native helper setup, Job Object resource limits and a tested supervisor",
    );
  }
  const tempSetting = process.env.OFFICE_WASM_TEMP_DIR ?? process.env.RUNNER_TEMP;
  if (!tempSetting || !path.isAbsolute(tempSetting))
    throw new Error("Set an absolute OFFICE_WASM_TEMP_DIR or RUNNER_TEMP");
  const temp = await fs.realpath(tempSetting);
  const repo = await fs.realpath(path.resolve(import.meta.dir, ".."));
  if (temp === repo || inside(repo, temp))
    throw new Error("Runner temp must be outside the checkout");
  const assets = path.resolve(
    process.env.OFFICE_WASM_ASSET_DIR ?? path.join(temp, "office-wasm-assets"),
  );
  const assetParent = await fs.realpath(path.dirname(assets));
  if (assetParent !== temp && !inside(temp, assetParent))
    throw new Error("Assets must be under runner temp");
  if (mode === "setup") {
    await acquire(assets, process.env.OFFICE_WASM_CACHE_DIR);
    console.log(JSON.stringify({ assets, verifiedFiles: await verifyAssets(assets), pins }));
    return;
  }
  const canonicalAssets = await fs.realpath(assets);
  if (!inside(temp, canonicalAssets)) throw new Error("Assets escape runner temp");
  const artifactSetting = process.env.OFFICE_WASM_ARTIFACT_DIR;
  if (!artifactSetting || !path.isAbsolute(artifactSetting))
    throw new Error("Set absolute OFFICE_WASM_ARTIFACT_DIR");
  await fs.mkdir(artifactSetting, { mode: 0o700 }); // Refuse stale results/overwrites.
  const artifacts = await fs.realpath(artifactSetting);
  const root = await fs.mkdtemp(path.join(temp, "office-wasm-run-"));
  const report: Record<string, unknown> = {
    status: "failed",
    platform: hostPlatform(),
    arch: hostArch(),
    assets: canonicalAssets,
    workspace: root,
    runtimeNetwork: false,
    pins,
    limits,
    qualificationOnly: true,
    unresolved: [
      "redistribution/source/font notices",
      "cryptographic provenance verification",
      "representative fidelity parity",
    ],
  };
  let server: net.Server | undefined;
  let canaryDir: string | undefined;
  let readCanaryDir: string | undefined;
  try {
    report.verifiedFiles = await verifyAssets(canonicalAssets);
    const node = await fs.realpath(executable(process.env.OFFICE_WASM_NODE ?? "node"));
    const tools = Object.fromEntries(
      await Promise.all(
        ["pdfinfo", "pdftotext", "pdftoppm"].map(async (name) => [
          name,
          await fs.realpath(
            executable(
              process.env.OFFICE_WASM_POPPLER_BIN
                ? path.join(process.env.OFFICE_WASM_POPPLER_BIN, name)
                : name,
            ),
          ),
        ]),
      ),
    ) as Record<string, string>;
    report.tools = { node, ...tools };
    const home = path.join(root, "home");
    const tmp = path.join(root, "tmp");
    await fs.mkdir(home);
    await fs.mkdir(tmp);
    const env = {
      PATH: [
        path.dirname(node),
        ...Object.values(tools).map((file) => path.dirname(file)),
        "/usr/bin",
        "/bin",
      ].join(":"),
      HOME: home,
      TMPDIR: tmp,
      TMP: tmp,
      TEMP: tmp,
      XDG_CONFIG_HOME: home,
      XDG_CACHE_HOME: tmp,
      XDG_DATA_HOME: home,
      LANG: "C",
      LC_ALL: "C",
      TZ: "UTC",
      PYTHONDONTWRITEBYTECODE: "1",
    };
    const execute = (label: string, file: string, args: string[]) =>
      supervise({
        label,
        file,
        args,
        root,
        assets: canonicalAssets,
        artifacts,
        env,
        executables: [node, ...Object.values(tools)],
        ...(label === "probe" && canaryDir ? { canaryDir } : {}),
        readRoots: [node, ...Object.values(tools)].map((tool) => path.dirname(path.dirname(tool))),
      });
    const version = await execute("node-version", node, ["--version"]);
    if (!/^v24\./.test(version.stdout.trim())) throw new Error("Node 24 required");
    report.node = version.stdout.trim();
    for (const [name, file] of Object.entries(tools))
      await execute(`${name}-version`, file, ["-v"]);

    const fixtureRoot = path.resolve(import.meta.dir, "../test/fixtures/office-wasm");
    const fixtureHashes: Record<string, string> = {};
    for (const kind of Object.keys(expectations)) {
      const name = `fixture.${kind}`;
      const bytes = await boundedFile(path.join(fixtureRoot, name), 1_000_000);
      fixtureHashes[name] = sha256(bytes);
      await fs.writeFile(path.join(root, name), bytes, { flag: "wx" });
    }
    report.fixtureSha256 = fixtureHashes;
    const child = path.join(root, "child.mjs");
    await fs.copyFile(path.join(import.meta.dir, "officeWasmQualification/child.mjs"), child);

    canaryDir = await fs.mkdtemp(path.join(temp, "office-wasm-canary-"));
    const canary = path.join(canaryDir, "write-canary");
    await fs.writeFile(canary, "unchanged");
    let readCanary: string | undefined;
    if (hostPlatform() === "linux") {
      // Synthetic file in the REAL runner home, not isolated HOME or temp.
      // The parent verifies existence/content; the sandbox must not see it.
      const runnerHome = await fs.realpath(hostHome());
      readCanaryDir = await fs.mkdtemp(path.join(runnerHome, ".office-wasm-read-canary-"));
      readCanary = path.join(readCanaryDir, "sentinel");
      if (
        [root, canonicalAssets, canaryDir].some((allowed) =>
          inside(allowed, readCanaryDir as string),
        )
      ) {
        throw new Error("Home read sentinel unexpectedly inside an allowed root");
      }
      await fs.writeFile(readCanary, "synthetic-home-sentinel", { flag: "wx", mode: 0o600 });
      if ((await fs.readFile(readCanary, "utf8")) !== "synthetic-home-sentinel") {
        throw new Error("Home read sentinel positive control failed");
      }
      report.readCanary = readCanary;
    }
    let accepted = 0;
    server = net.createServer((socket) => {
      accepted++;
      socket.end();
    });
    const listener = server;
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("No probe listener");
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(address.port, "127.0.0.1");
      socket.setTimeout(3000, () => {
        socket.destroy();
        reject(new Error("Positive network control timeout"));
      });
      socket.once("end", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", reject);
    });
    const before = accepted;
    if (before !== 1) throw new Error("Positive network control did not reach listener");
    await execute("probe", node, [
      ...limits.nodeFlags,
      child,
      "probe",
      root,
      canonicalAssets,
      canary,
      String(address.port),
      ...(readCanary ? [readCanary] : []),
    ]);
    if (accepted !== before || (await fs.readFile(canary, "utf8")) !== "unchanged") {
      throw new Error("Sandbox negative control failed");
    }
    if (readCanary && (await fs.readFile(readCanary, "utf8")) !== "synthetic-home-sentinel") {
      throw new Error("Home read sentinel changed or disappeared");
    }
    report.probes = JSON.parse(
      (await boundedFile(path.join(root, "probe.json"), 10_000)).toString(),
    );
    listener.close();
    server = undefined;
    await execute("convert", node, [...limits.nodeFlags, child, "convert", root, canonicalAssets]);
    report.conversion = JSON.parse(
      (await boundedFile(path.join(root, "conversion.json"), 100_000)).toString(),
    );

    const validation = [];
    for (const [kind, expected] of Object.entries(expectations)) {
      const pdf = path.join(root, `${kind}.pdf`);
      const info = await execute(`${kind}-pdfinfo`, tools.pdfinfo, [pdf]);
      const pages = Number(/^Pages:\s+(\d+)$/m.exec(info.stdout)?.[1]);
      if (pages !== expected.pages)
        throw new Error(`${kind}: expected ${expected.pages} pages, got ${pages}`);
      await execute(`${kind}-text`, tools.pdftotext, [
        "-layout",
        pdf,
        path.join(root, `${kind}.txt`),
      ]);
      const text = (await boundedFile(path.join(root, `${kind}.txt`), 100_000)).toString();
      for (const marker of expected.markers) {
        if (!text.includes(marker)) throw new Error(`${kind}: missing text ${marker}`);
      }
      if (kind === "xlsx" && !/\bTOTAL\s+360\b/.test(text))
        throw new Error("Formula TOTAL did not recalculate to 360");
      await execute(`${kind}-render`, tools.pdftoppm, [
        "-png",
        "-scale-to",
        "1200",
        "-f",
        "1",
        "-l",
        String(pages),
        pdf,
        path.join(root, kind),
      ]);
      const images = [];
      const names = (await fs.readdir(root))
        .filter((name) => name.startsWith(`${kind}-`) && name.endsWith(".png"))
        .sort();
      if (names.length !== pages) throw new Error(`${kind}: PNG count mismatch`);
      for (const name of names) {
        const png = await boundedFile(path.join(root, name), 10_000_000);
        images.push({ name, ...validatePng(png), sha256: sha256(png) });
      }
      validation.push({
        kind,
        pages,
        markers: expected.markers,
        images,
        pdfSha256: sha256(await boundedFile(pdf, 20_000_000)),
      });
    }
    report.validation = validation;
    report.status = "passed";
  } catch (error) {
    report.error = String(error);
    throw error;
  } finally {
    server?.close();
    if (canaryDir) await fs.rm(canaryDir, { recursive: true, force: true });
    if (readCanaryDir) {
      await fs
        .unlink(path.join(readCanaryDir, "sentinel"))
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      await fs.rmdir(readCanaryDir);
    }
    try {
      report.verifiedFilesAfter = await verifyAssets(canonicalAssets);
    } catch (error) {
      report.status = "failed";
      report.assetVerificationError = String(error);
      process.exitCode = 1;
    }
    // Copy only bounded regular evidence, never downloaded executable assets.
    for (const name of await fs.readdir(root)) {
      if (!/^(docx|pptx|xlsx)(\.pdf|\.txt|-\d+\.png)$/.test(name)) continue;
      try {
        await fs.writeFile(
          path.join(artifacts, name),
          await boundedFile(path.join(root, name), 20_000_000),
          { flag: "wx" },
        );
      } catch (error) {
        report.status = "failed";
        report.artifactError = String(error);
        process.exitCode = 1;
      }
    }
    await fs.writeFile(path.join(artifacts, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, artifacts, workspace: root }));
  }
  if (report.status !== "passed")
    throw new Error("Qualification evidence or asset verification failed");
}

if (import.meta.main) {
  await officeWasmQualification(process.argv[2] ?? "");
}
