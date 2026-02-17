import fs from "node:fs/promises";
import path from "node:path";

import { discoverSkills, stripSkillFrontMatter } from "../skills";
import type { AgentConfig, CommandInfo, CommandSource } from "../types";

export type CommandDefinition = CommandInfo & {
  template: string;
};

const BUILTIN_COMMANDS = [
  {
    name: "init",
    description: "create/update AGENTS.md",
    filename: "init.txt",
  },
  {
    name: "review",
    description: "review changes [commit|branch|pr], defaults to uncommitted",
    filename: "review.txt",
  },
] as const;

const BUILTIN_FALLBACK_TEMPLATES: Record<string, string> = {
  init: "Create or update an AGENTS.md file for this repository.\n\n$ARGUMENTS",
  review: "Review the current changes.\n\nTarget: $ARGUMENTS",
};

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function extractHints(template: string): string[] {
  const result: string[] = [];
  const numbered = template.match(/\$[1-9]\d*/g);
  if (numbered) {
    for (const hint of [...new Set(numbered)].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))) {
      result.push(hint);
    }
  }
  if (template.includes("$ARGUMENTS")) {
    result.push("$ARGUMENTS");
  }
  return result;
}

function tokenizeArguments(argumentsText: string): string[] {
  const tokens: string[] = [];
  const re = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi;
  let match: RegExpExecArray | null = null;

  while ((match = re.exec(argumentsText)) !== null) {
    const token = (match[0] ?? "").replace(/^["']|["']$/g, "");
    tokens.push(token);
  }

  return tokens;
}

async function loadBuiltinTemplate(config: AgentConfig, name: string, filename: string): Promise<string> {
  const templatePath = path.join(config.builtInDir, "prompts", "commands", filename);
  try {
    const raw = await fs.readFile(templatePath, "utf-8");
    const trimmed = raw.trim();
    if (trimmed) return trimmed;
  } catch {
    // fall through to fallback template
  }
  return BUILTIN_FALLBACK_TEMPLATES[name] ?? "";
}

function commandInfo(
  name: string,
  description: string | undefined,
  source: CommandSource,
  template: string
): CommandDefinition {
  return {
    name,
    description,
    source,
    template,
    hints: extractHints(template),
  };
}

async function buildCommandMap(config: AgentConfig): Promise<Map<string, CommandDefinition>> {
  const map = new Map<string, CommandDefinition>();

  for (const builtin of BUILTIN_COMMANDS) {
    const template = await loadBuiltinTemplate(config, builtin.name, builtin.filename);
    map.set(
      normalizeName(builtin.name),
      commandInfo(builtin.name, builtin.description, "command", template)
    );
  }

  for (const [name, command] of Object.entries(config.command ?? {})) {
    const normalized = normalizeName(name);
    if (!normalized) continue;
    const template = command.template.trim();
    if (!template) continue;
    map.set(normalized, commandInfo(name, command.description, command.source ?? "command", template));
  }

  const skills = await discoverSkills(config.skillsDirs);
  for (const skill of skills) {
    if (!skill.enabled) continue;
    const normalized = normalizeName(skill.name);
    if (!normalized || map.has(normalized)) continue;

    try {
      const raw = await fs.readFile(skill.path, "utf-8");
      const template = stripSkillFrontMatter(raw).trim();
      if (!template) continue;
      map.set(normalized, commandInfo(skill.name, skill.description, "skill", template));
    } catch {
      // Ignore unreadable skills for command execution.
    }
  }

  return map;
}

export async function listCommands(config: AgentConfig): Promise<CommandInfo[]> {
  const map = await buildCommandMap(config);
  return [...map.values()]
    .map((entry) => ({
      name: entry.name,
      description: entry.description,
      source: entry.source,
      hints: entry.hints,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function resolveCommand(config: AgentConfig, name: string): Promise<CommandDefinition | null> {
  const map = await buildCommandMap(config);
  return map.get(normalizeName(name)) ?? null;
}

export function expandCommandTemplate(template: string, argumentsText: string): string {
  const trimmedArguments = argumentsText.trim();
  const tokens = tokenizeArguments(trimmedArguments);
  const numberedPlaceholders = template.match(/\$(\d+)/g) ?? [];
  const maxPlaceholder = numberedPlaceholders.reduce((max, placeholder) => {
    const value = Number(placeholder.slice(1));
    return Number.isFinite(value) && value > max ? value : max;
  }, 0);
  const usesArgumentsPlaceholder = template.includes("$ARGUMENTS");

  // Expand numbered placeholders against the template before inserting raw
  // arguments so literal "$2" text in user input remains unchanged.
  let output = template;
  if (numberedPlaceholders.length > 0) {
    output = output.replace(/\$(\d+)/g, (_match, indexRaw: string) => {
      const index = Number(indexRaw);
      if (!Number.isFinite(index) || index < 1) return "";
      const tokenIndex = index - 1;
      if (tokenIndex >= tokens.length) return "";
      if (index === maxPlaceholder) return tokens.slice(tokenIndex).join(" ");
      return tokens[tokenIndex] ?? "";
    });
  }
  if (usesArgumentsPlaceholder) {
    output = output.replace(/\$ARGUMENTS/g, trimmedArguments);
  }

  if (numberedPlaceholders.length === 0 && !usesArgumentsPlaceholder && trimmedArguments) {
    output = `${output}\n\n${trimmedArguments}`;
  }

  return output.trim();
}
