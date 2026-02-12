import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

export interface LocalObservabilityStackPorts {
  vectorOtlpHttp: number;
  victoriaLogs: number;
  victoriaMetrics: number;
  victoriaTraces: number;
}

export interface LocalObservabilityStack {
  projectName: string;
  composeFile: string;
  env: Record<string, string>;
  ports: LocalObservabilityStackPorts;
  endpoints: {
    otlpHttpEndpoint: string;
    logsBaseUrl: string;
    metricsBaseUrl: string;
    tracesBaseUrl: string;
  };
}

function sanitizeName(v: string): string {
  const cleaned = v.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "obs";
}

async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function findAvailablePort(start: number): Promise<number> {
  for (let port = start; port < start + 500; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`Unable to find available port near ${start}`);
}

const COMMAND_TIMEOUT_MS = 120_000;

async function runCommand(cmd: string, args: string[], env?: Record<string, string>): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${cmd} ${args.join(" ")} timed out after ${COMMAND_TIMEOUT_MS / 1000}s`));
    }, COMMAND_TIMEOUT_MS);
    child.stdout.on("data", (buf) => {
      stdout += String(buf);
    });
    child.stderr.on("data", (buf) => {
      stderr += String(buf);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${cmd} ${args.join(" ")} failed (${code}): ${stderr || stdout}`));
    });
  });
}

function composeArgs(stack: LocalObservabilityStack, args: string[]): string[] {
  return ["compose", "-p", stack.projectName, "-f", stack.composeFile, ...args];
}

export async function createLocalObservabilityStack(opts: {
  repoDir: string;
  runId: string;
  composeFile?: string;
}): Promise<LocalObservabilityStack> {
  const composeFile = opts.composeFile ?? path.join(opts.repoDir, "config/observability/docker-compose.yml");
  const projectName = sanitizeName(`cowork-obs-${opts.runId.toLowerCase()}`);
  const ports: LocalObservabilityStackPorts = {
    vectorOtlpHttp: await findAvailablePort(14318),
    victoriaLogs: await findAvailablePort(19428),
    victoriaMetrics: await findAvailablePort(18428),
    victoriaTraces: await findAvailablePort(10428),
  };

  const env = {
    VECTOR_OTLP_HTTP_PORT: String(ports.vectorOtlpHttp),
    VICTORIA_LOGS_PORT: String(ports.victoriaLogs),
    VICTORIA_METRICS_PORT: String(ports.victoriaMetrics),
    VICTORIA_TRACES_PORT: String(ports.victoriaTraces),
  };

  return {
    projectName,
    composeFile,
    env,
    ports,
    endpoints: {
      otlpHttpEndpoint: `http://127.0.0.1:${ports.vectorOtlpHttp}`,
      logsBaseUrl: `http://127.0.0.1:${ports.victoriaLogs}`,
      metricsBaseUrl: `http://127.0.0.1:${ports.victoriaMetrics}`,
      tracesBaseUrl: `http://127.0.0.1:${ports.victoriaTraces}`,
    },
  };
}

export async function startLocalObservabilityStack(stack: LocalObservabilityStack) {
  await runCommand("docker", composeArgs(stack, ["up", "-d"]), stack.env);
}

export async function stopLocalObservabilityStack(stack: LocalObservabilityStack) {
  await runCommand("docker", composeArgs(stack, ["down", "-v"]), stack.env);
}

export async function getLocalObservabilityStackStatus(stack: LocalObservabilityStack): Promise<string> {
  const { stdout } = await runCommand("docker", composeArgs(stack, ["ps"]), stack.env);
  return stdout;
}

