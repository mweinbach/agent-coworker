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
const { SubprocessConverter } = await import(
  pathToFileURL(path.join(packageDir, "dist/index.js")).href
);

// Upstream `@matbee/libreoffice-converter@2.7.2` hardcodes 180s init / 120s
// convert waits and never restarts its forked worker on timeout, so a single
// intermittent Emscripten pthread deadlock consumes the entire 180s supervisor
// budget. Bound each init/convert step and replace a stalled worker inside the
// same offline sandbox while recording any restarts in `conversion.json`.
const STEP_TIMEOUT_MS = 45_000;
const MAX_STEP_ATTEMPTS = 3;

function withTimeout(promise, label, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`${label} timed out after ${timeoutMs}ms`);
        error.code = "STEP_TIMEOUT";
        reject(error);
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function isStepTimeout(error) {
  return error instanceof Error && error.code === "STEP_TIMEOUT";
}

function forceKillConverter(converter) {
  if (!converter) return;
  try {
    if (typeof converter.killWorker === "function") {
      converter.killWorker();
    } else if (converter.child) {
      converter.child.kill("SIGKILL");
    }
  } catch {
    // Best-effort cleanup; supervisor also enforces zero surviving descendants.
  }
}

async function createBoundedConverter(restarts) {
  for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt++) {
    const started = performance.now();
    const converter = new SubprocessConverter({
      wasmPath: path.join(packageDir, "wasm"),
      workerPath: path.join(packageDir, "dist/subprocess.worker.cjs"),
      includeSystemFonts: false,
      maxInitRetries: 1, // Zero falls back to upstream defaults via `||`.
      maxConversionRetries: 1,
      restartOnMemoryError: false,
      // Upstream `verbose: true` monkey-patches Emscripten `FS.open` and proxies
      // pthread `print`/`printErr` through `console.*`, triggering an intermittent
      // main-thread / em-pthread `WasmI32AtomicWait` deadlock on macOS ARM64.
      verbose: false,
    });
    try {
      await withTimeout(converter.initialize(), "init", STEP_TIMEOUT_MS);
      return { converter, initMs: performance.now() - started };
    } catch (error) {
      forceKillConverter(converter);
      if (!isStepTimeout(error) || attempt >= MAX_STEP_ATTEMPTS) {
        throw error;
      }
      restarts.push({ stage: "init", attempt, reason: error.message });
    }
  }
  throw new Error("Exhausted converter initialization attempts");
}

const restarts = [];
let { converter, initMs } = await createBoundedConverter(restarts);
const results = { node: process.version, initMs, files: [], restarts };
try {
  for (const inputFormat of ["docx", "pptx", "xlsx"]) {
    const file = `fixture.${inputFormat}`;
    const inputBytes = await fs.readFile(path.join(root, file));
    for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt++) {
      const before = performance.now();
      try {
        const result = await withTimeout(
          converter.convert(inputBytes, { inputFormat, outputFormat: "pdf" }, file),
          `convert:${inputFormat}`,
          STEP_TIMEOUT_MS,
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
          ...(attempt > 1 ? { attempt } : {}),
        });
        break;
      } catch (error) {
        if (!isStepTimeout(error) || attempt >= MAX_STEP_ATTEMPTS) {
          forceKillConverter(converter);
          converter = null;
          throw error;
        }
        restarts.push({ stage: `convert:${inputFormat}`, attempt, reason: error.message });
        forceKillConverter(converter);
        converter = null;
        ({ converter } = await createBoundedConverter(restarts));
      }
    }
  }
} finally {
  if (converter) {
    try {
      await withTimeout(converter.destroy(), "destroy", 5_000);
    } catch {
      forceKillConverter(converter);
    }
  }
}
await fs.writeFile(path.join(root, "conversion.json"), JSON.stringify(results, null, 2));
// Disposable CLI only: upstream send() leaves referenced request timers alive.
// All writes/destroy are awaited; the supervisor kills remaining descendants.
process.exit(0);
