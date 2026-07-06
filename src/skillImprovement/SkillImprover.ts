import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parseChildModelRef } from "../models/childModelRouting";
import { createRuntime } from "../runtime";
import { parseSkillFrontMatter } from "../skills/catalog";
import { createWebSearchTool } from "../tools/webSearch";
import { type AgentConfig, defaultRuntimeNameForProvider, type ModelMessage } from "../types";
import { isPathInside } from "../utils/paths";
import type { SkillImproverRunInput } from "./types";

const MAX_FILE_BYTES = 96 * 1024;
const MAX_FILE_LIST_ENTRIES = 250;

type SkillImproverDeps = {
  createRuntime: typeof createRuntime;
  loadPrompt: (config: AgentConfig) => Promise<string>;
};

async function defaultLoadPrompt(config: AgentConfig): Promise<string> {
  const promptPath = path.join(config.builtInDir, "prompts", "skill-improver.md");
  return (await fs.readFile(promptPath, "utf-8")).replace(/\r\n?/g, "\n");
}

const defaultDeps: SkillImproverDeps = {
  createRuntime,
  loadPrompt: defaultLoadPrompt,
};

function resolveTargetConfig(config: AgentConfig): AgentConfig {
  const requested =
    config.skillImprovementModel?.trim() ||
    config.preferredChildModelRef?.trim() ||
    config.preferredChildModel ||
    config.model;
  try {
    const parsed = parseChildModelRef(requested, config.provider, "skill improvement model");
    return {
      ...config,
      provider: parsed.provider,
      runtime: defaultRuntimeNameForProvider(parsed.provider),
      model: parsed.modelId,
    };
  } catch {
    return config;
  }
}

function normalizeRelativePath(rawPath: string): string {
  const normalized = path.normalize(rawPath.trim()).replace(/^(\.\.(\/|\\|$))+/, "");
  return normalized === "." ? "" : normalized;
}

function resolveInsideRoot(rootDir: string, rawPath: string): string {
  const targetPath = path.resolve(rootDir, normalizeRelativePath(rawPath));
  const resolvedRoot = path.resolve(rootDir);
  if (targetPath !== resolvedRoot && !isPathInside(resolvedRoot, targetPath)) {
    throw new Error("Path escapes the target skill directory.");
  }
  return targetPath;
}

async function listFiles(rootDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    if (out.length >= MAX_FILE_LIST_ENTRIES) return;
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (out.length >= MAX_FILE_LIST_ENTRIES) break;
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const fullPath = path.join(current, entry.name);
      const rel = path.relative(rootDir, fullPath).split(path.sep).join("/");
      if (entry.isDirectory()) {
        out.push(`${rel}/`);
        await walk(fullPath);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }
  await walk(rootDir);
  return out;
}

async function readTextFileLimited(targetPath: string): Promise<string> {
  const stat = await fs.stat(targetPath);
  if (!stat.isFile()) throw new Error("Path is not a file.");
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`File is too large (${stat.size} bytes, max ${MAX_FILE_BYTES}).`);
  }
  return await fs.readFile(targetPath, "utf-8");
}

function renderUsageEvents(events: SkillImproverRunInput["usageEvents"]): string {
  return events
    .map((event, index) =>
      [
        `### Usage ${index + 1}`,
        `- Session: ${event.sessionId}`,
        `- Turn: ${event.turnId}`,
        `- Invocation: ${event.kind} (${event.source})`,
        `- Workspace: ${event.workingDirectory}`,
        `- Message range: ${event.messageStartIndex}-${event.messageEndIndex}`,
        "",
        event.transcript.trim() || "(no transcript captured)",
      ].join("\n"),
    )
    .join("\n\n");
}

function renderSkillList(skills: SkillImproverRunInput["allSkills"]): string {
  if (skills.length === 0) return "(no skills discovered)";
  return skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
}

export class SkillImprover {
  constructor(private readonly deps: SkillImproverDeps = defaultDeps) {}

  async run(opts: {
    config: AgentConfig;
    input: SkillImproverRunInput;
    log?: (line: string) => void;
    abortSignal?: AbortSignal;
  }): Promise<{ ok: boolean; changed: boolean; message: string; error?: string }> {
    const log = opts.log ?? (() => {});
    const rootDir = path.resolve(opts.input.skillRootDir);
    const initialSkill = await readTextFileLimited(opts.input.skillPath);
    const initialFrontMatter = parseSkillFrontMatter(initialSkill, path.basename(rootDir));
    if (!initialFrontMatter) {
      return {
        ok: false,
        changed: false,
        message: "Skill frontmatter is invalid before improvement.",
      };
    }

    let finishMessage = "";
    const tools = {
      list_files: {
        description: "List files under the target skill directory.",
        inputSchema: z.object({}).strict(),
        execute: async () => (await listFiles(rootDir)).join("\n"),
      },
      read_file: {
        description: "Read a UTF-8 text file under the target skill directory.",
        inputSchema: z.object({ path: z.string().min(1) }).strict(),
        execute: async ({ path: filePath }: { path: string }) =>
          await readTextFileLimited(resolveInsideRoot(rootDir, filePath)),
      },
      write_file: {
        description: "Write a UTF-8 text file under the target skill directory.",
        inputSchema: z.object({ path: z.string().min(1), content: z.string() }).strict(),
        execute: async ({ path: filePath, content }: { path: string; content: string }) => {
          const targetPath = resolveInsideRoot(rootDir, filePath);
          await fs.mkdir(path.dirname(targetPath), { recursive: true });
          await fs.writeFile(targetPath, content, "utf-8");
          return "ok";
        },
      },
      edit_file: {
        description: "Replace an exact text span in a UTF-8 file under the target skill directory.",
        inputSchema: z
          .object({
            path: z.string().min(1),
            oldText: z.string().min(1),
            newText: z.string(),
          })
          .strict(),
        execute: async ({
          path: filePath,
          oldText,
          newText,
        }: {
          path: string;
          oldText: string;
          newText: string;
        }) => {
          const targetPath = resolveInsideRoot(rootDir, filePath);
          const current = await readTextFileLimited(targetPath);
          if (!current.includes(oldText)) {
            throw new Error("oldText was not found.");
          }
          await fs.writeFile(targetPath, current.replace(oldText, newText), "utf-8");
          return "ok";
        },
      },
      webSearch: createWebSearchTool({
        config: opts.config,
        log: (line) => log(`[skill-improver] ${line}`),
        askUser: async () => "",
        approveCommand: async () => false,
        abortSignal: opts.abortSignal,
      }),
      finish: {
        description: "Finish the skill improvement pass with a concise summary.",
        inputSchema: z.object({ summary: z.string().min(1) }).strict(),
        execute: ({ summary }: { summary: string }) => {
          finishMessage = summary.trim();
          return "ok";
        },
      },
    };

    const system = await this.deps.loadPrompt(opts.config);
    const targetConfig = resolveTargetConfig(opts.config);
    const fileTree = (await listFiles(rootDir)).join("\n") || "(empty)";
    const userMessage = [
      `Target skill: ${opts.input.skillName}`,
      `Target source: ${opts.input.sourceKind}`,
      `Target root: ${rootDir}`,
      "",
      `Current file tree:\n${fileTree}`,
      "",
      `Current SKILL.md:\n${initialSkill}`,
      "",
      `Recent usage evidence:\n${renderUsageEvents(opts.input.usageEvents)}`,
      "",
      `Current discovered skill list:\n${renderSkillList(opts.input.allSkills)}`,
    ].join("\n\n");

    try {
      const runtime = this.deps.createRuntime(targetConfig);
      await runtime.runTurn({
        config: targetConfig,
        system,
        messages: [{ role: "user", content: userMessage }] as ModelMessage[],
        tools,
        maxSteps: 10,
        providerOptions: targetConfig.providerOptions,
        abortSignal: opts.abortSignal,
        log: (line) => log(`[skill-improver] ${line}`),
        enableMcp: false,
      } as Parameters<ReturnType<typeof createRuntime>["runTurn"]>[0]);
    } catch (error) {
      return {
        ok: false,
        changed: false,
        message: "Skill improvement runtime failed.",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const nextSkill = await readTextFileLimited(opts.input.skillPath);
    const changed = nextSkill !== initialSkill;
    const nextFrontMatter = parseSkillFrontMatter(nextSkill, path.basename(rootDir));
    if (
      !nextFrontMatter ||
      nextFrontMatter.frontMatter.name !== initialFrontMatter.frontMatter.name
    ) {
      return {
        ok: false,
        changed,
        message: "Skill improvement produced invalid frontmatter.",
      };
    }

    return {
      ok: true,
      changed,
      message: finishMessage || (changed ? "Skill improved." : "No changes needed."),
    };
  }
}

export const __internalSkillImprover = {
  listFiles,
  resolveInsideRoot,
};
