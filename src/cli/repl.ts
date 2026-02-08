import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import type { ModelMessage } from "ai";

import { loadConfig, defaultModelForProvider } from "../config";
import { runTurn } from "../agent";
import { loadSystemPrompt } from "../prompt";
import { approveCommand } from "../utils/approval";
import { createTools } from "../tools";
import { currentTodos, onTodoChange } from "../tools/todoWrite";
import { isProviderName, PROVIDER_NAMES } from "../types";

// Keep CLI output clean by default.
(globalThis as any).AI_SDK_LOG_WARNINGS = false;

function createQuestion(rl: readline.Interface) {
  return (q: string) =>
    new Promise<string | null>((resolve) => {
      if ((rl as any).closed) return resolve(null);
      try {
        rl.question(q, (answer) => resolve(answer));
      } catch {
        resolve(null);
      }
    });
}

function renderTodos(todos: typeof currentTodos) {
  if (todos.length === 0) return;

  console.log("\n--- Progress ---");
  for (const todo of todos) {
    const icon = todo.status === "completed" ? "x" : todo.status === "in_progress" ? ">" : "-";
    const line = `  ${icon} ${todo.content}`;
    console.log(line);
  }
  const active = todos.find((t) => t.status === "in_progress");
  if (active) console.log(`\n  ${active.activeForm}...`);
  console.log("");
}

async function resolveAndValidateDir(dirArg: string): Promise<string> {
  const resolved = path.resolve(dirArg);
  let st: { isDirectory: () => boolean } | null = null;
  try {
    st = await fs.stat(resolved);
  } catch {
    st = null;
  }
  if (!st || !st.isDirectory()) throw new Error(`--dir is not a directory: ${resolved}`);
  return resolved;
}

export async function runCliRepl(
  opts: { dir?: string; providerOptions?: Record<string, any>; yolo?: boolean } = {}
) {
  let config: Awaited<ReturnType<typeof loadConfig>>;
  if (opts.dir) {
    const dir = await resolveAndValidateDir(opts.dir);
    process.chdir(dir);
    config = await loadConfig({ cwd: dir, env: { ...process.env, AGENT_WORKING_DIR: dir } });
  } else {
    config = await loadConfig();
  }
  if (opts.providerOptions) config.providerOptions = opts.providerOptions;

  await fs.mkdir(config.projectAgentDir, { recursive: true });
  await fs.mkdir(config.outputDirectory, { recursive: true });
  await fs.mkdir(config.uploadsDirectory, { recursive: true });

  let system = await loadSystemPrompt(config);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const question = createQuestion(rl);
  const yolo = opts.yolo === true;

  onTodoChange(renderTodos);

  const log = (line: string) => console.log(line);

  const askUser = async (q: string, options?: string[]) => {
    console.log(`\n${q}`);
    if (options && options.length > 0) {
      for (let i = 0; i < options.length; i++) {
        console.log(`  ${i + 1}. ${options[i]}`);
      }
    }

    const ansRaw = await question("answer> ");
    const ans = (ansRaw ?? "").trim();
    const asNum = Number(ans);
    if (options && options.length > 0 && Number.isInteger(asNum) && asNum >= 1 && asNum <= options.length) {
      return options[asNum - 1];
    }
    return ans;
  };

  const approve = yolo
    ? async (_command: string) => true
    : async (command: string) => approveCommand(command, async (msg) => (await question(msg)) ?? "");

  console.log("Cowork agent (CLI)");
  console.log(`provider=${config.provider} model=${config.model}`);
  console.log(`cwd=${config.workingDirectory}`);
  if (yolo) console.log("YOLO mode enabled: command approvals are bypassed.");
  console.log("Type /help for commands. Use /connect to store keys or mark OAuth sign-in pending.\n");

  let messages: ModelMessage[] = [];

  const printHelp = () => {
    console.log("\nCommands:");
    console.log("  /help                 Show help");
    console.log("  /exit                 Quit");
    console.log("  /new                  Clear conversation");
    console.log("  /model <id>            Set model id for this session");
    console.log(`  /provider <name>       Set provider (${PROVIDER_NAMES.join("|")})`);
    console.log("  /cwd <path>            Set working directory for this session");
    console.log("  /tools                List tool names\n");
  };

  while (true) {
    const lineRaw = await question("you> ");
    if (lineRaw === null) break;
    const line = lineRaw.trim();
    if (!line) continue;

    if (line.startsWith("/")) {
      const [cmd, ...rest] = line.slice(1).split(/\s+/);

      if (cmd === "help") {
        printHelp();
        continue;
      }

      if (cmd === "exit") {
        break;
      }

      if (cmd === "new") {
        messages = [];
        console.log("(cleared)\n");
        continue;
      }

      if (cmd === "model") {
        const id = rest.join(" ").trim();
        if (!id) {
          console.log("usage: /model <id>");
          continue;
        }
        config = { ...config, model: id };
        system = await loadSystemPrompt(config);
        console.log(`model set to ${id}`);
        continue;
      }

      if (cmd === "provider") {
        const name = rest[0];
        if (!isProviderName(name)) {
          console.log(`usage: /provider <${PROVIDER_NAMES.join("|")}>`);
          continue;
        }
        const nextModel = defaultModelForProvider(name);
        config = { ...config, provider: name, model: nextModel, subAgentModel: nextModel };
        system = await loadSystemPrompt(config);
        console.log(`provider set to ${name} (model=${config.model})`);
        continue;
      }

      if (cmd === "cwd") {
        const p = rest.join(" ").trim();
        if (!p) {
          console.log("usage: /cwd <path>");
          continue;
        }
        const next = await resolveAndValidateDir(p);
        process.chdir(next);
        config = await loadConfig({ cwd: next, env: { ...process.env, AGENT_WORKING_DIR: next } });
        if (opts.providerOptions) config.providerOptions = opts.providerOptions;

        await fs.mkdir(config.projectAgentDir, { recursive: true });
        await fs.mkdir(config.outputDirectory, { recursive: true });
        await fs.mkdir(config.uploadsDirectory, { recursive: true });

        system = await loadSystemPrompt(config);
        console.log(`cwd set to ${config.workingDirectory}`);
        continue;
      }

      if (cmd === "tools") {
        const toolNames = Object.keys(createTools({ config, log, askUser, approveCommand: approve })).sort();
        console.log(`\nTools:\n${toolNames.map((t) => `  - ${t}`).join("\n")}\n`);
        continue;
      }

      console.log(`unknown command: /${cmd}`);
      continue;
    }

    messages.push({ role: "user", content: line });

    try {
      const res = await runTurn({
        config,
        system,
        messages,
        log,
        askUser,
        approveCommand: approve,
        maxSteps: 100,
        enableMcp: config.enableMcp,
      });

      messages.push(...res.responseMessages);
      const out = res.text.trim();
      if (out) console.log(`\n${out}\n`);
    } catch (err) {
      console.error(`\nError: ${String(err)}\n`);
    }
  }

  rl.close();
}
