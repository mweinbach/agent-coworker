import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

if (
  !["macos-seatbelt", "linux-bwrap"].includes(process.env.COWORK_SANDBOX) ||
  process.env.COWORK_SANDBOX_NETWORK_DISABLED !== "1"
) {
  throw new Error("An enforcing offline sandbox is required");
}
const [mode, root, assets, canary, port, readCanary] = process.argv.slice(2);
if (!process.version.startsWith("v24.")) throw new Error("Node 24 required");

if (mode === "probe") {
  let readDenial;
  if (readCanary) {
    try {
      await fs.readFile(readCanary);
    } catch (error) {
      readDenial = error.code;
    }
    if (!["EPERM", "EACCES", "ENOENT"].includes(readDenial)) {
      throw new Error(`Outside-root home read was not denied: ${readDenial}`);
    }
  } else if (process.env.COWORK_SANDBOX === "linux-bwrap") {
    throw new Error("Linux home read sentinel is required");
  }
  let writeDenial;
  try {
    await fs.writeFile(canary, "sandbox-escaped");
  } catch (error) {
    writeDenial = error.code;
  }
  if (!["EPERM", "EACCES", "EROFS"].includes(writeDenial)) {
    throw new Error(`Outside-write probe was not denied: ${writeDenial}`);
  }
  const networkDenial = await new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: Number(port) });
    socket.setTimeout(3000);
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error("Network escaped sandbox"));
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("Network probe timed out; denial not demonstrated"));
    });
    socket.once("error", (error) => {
      socket.destroy();
      if (["EPERM", "EACCES", "ENETUNREACH", "ECONNREFUSED"].includes(error.code))
        resolve(error.code);
      else reject(error);
    });
  });
  // On Linux, ECONNREFUSED proves namespace isolation only because the parent
  // verified a live listener immediately beforehand and checks zero accepts.
  await fs.writeFile(
    path.join(root, "probe.json"),
    JSON.stringify({ readDenial, writeDenial, networkDenial }),
  );
  process.exit(0);
}
if (mode !== "convert") throw new Error("Unknown child mode");
const packageDir = path.join(assets, "node_modules/@matbee/libreoffice-converter");
const { createSubprocessConverter } = await import(
  pathToFileURL(path.join(packageDir, "dist/index.js")).href
);
const started = performance.now();
const converter = await createSubprocessConverter({
  wasmPath: path.join(packageDir, "wasm"),
  workerPath: path.join(packageDir, "dist/subprocess.worker.cjs"),
  includeSystemFonts: false,
  maxInitRetries: 1, // Zero falls back to upstream defaults via `||`.
  maxConversionRetries: 1,
  restartOnMemoryError: false,
  verbose: true,
});
const results = { node: process.version, initMs: performance.now() - started, files: [] };
try {
  for (const inputFormat of ["docx", "pptx", "xlsx"]) {
    const before = performance.now();
    const file = `fixture.${inputFormat}`;
    const result = await converter.convert(
      await fs.readFile(path.join(root, file)),
      { inputFormat, outputFormat: "pdf" },
      file,
    );
    const bytes = Buffer.from(result.data);
    if (bytes.length > 20_000_000 || !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
      throw new Error("Invalid or oversized PDF");
    }
    await fs.writeFile(path.join(root, `${inputFormat}.pdf`), bytes);
    results.files.push({
      inputFormat,
      bytes: bytes.length,
      durationMs: performance.now() - before,
    });
  }
} finally {
  await converter.destroy();
}
await fs.writeFile(path.join(root, "conversion.json"), JSON.stringify(results, null, 2));
// Disposable CLI only: upstream send() leaves referenced request timers alive.
// All writes/destroy are awaited; the supervisor kills remaining descendants.
process.exit(0);
